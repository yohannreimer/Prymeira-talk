import { createHash, randomBytes } from "node:crypto";
import {
  automationFlowSchema,
  automationWebhookPath,
  findWebhookTriggerNode,
  readWebhookTriggerChannelId,
  type AutomationWebhookDto
} from "@prymeira-talk/shared";
import {
  buildPhoneLookupCandidates,
  normalizePhoneForStorage
} from "../contacts/phone-normalization.js";
import { toConversationDto, toMessageDto } from "../conversations/conversations.service.js";
import type { AutomationRuleRecord, RunForWebhookEventInput } from "./automation-runner.js";
import {
  flattenAutomationVariables,
  formatAutomationVariablesForTeam,
  type AutomationVariables
} from "./automation-variables.js";

type DateLike = Date | string;

const DEDUPE_WINDOW_MS = 10 * 60 * 1000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const PHONE_KEYS = ["whatsapp", "telefone", "phone"] as const;
const NAME_KEYS = ["nome", "name"] as const;
const MAX_NAME_LENGTH = 120;
// Submission timestamps change on every click; they must not defeat dedupe.
const VOLATILE_PAYLOAD_KEYS = new Set(["enviado_em", "submitted_at", "timestamp"]);

export const META_FIRST_MESSAGE_BLOCKED_REASON =
  "Canal da API oficial (Meta): a primeira mensagem fora da janela de 24h exige template aprovado, que ainda não está disponível nas automações. Nenhuma mensagem foi enviada; o contato e os dados do formulário ficaram registrados na conversa.";

const FORM_NOTE_TITLE = "Formulário recebido (Webhook externo)";

interface WebhookTokenRecord {
  id: string;
  workspaceId: string;
  ruleId: string;
  token: string;
  createdAt: DateLike;
  updatedAt: DateLike;
}

interface ChannelRecord {
  id: string;
  workspaceId: string;
  provider: string;
  providerKey: string;
  displayName?: string | null;
}

interface ContactRecord {
  id: string;
  name?: string | null;
  phone: string;
}

export interface WebhookRunRecord {
  id: string; workspaceId: string; ruleId: string; eventKey: string; status: string;
  input: unknown; result?: unknown; executionToken?: string | null; leaseUntil?: Date | null; updatedAt?: Date;
}
export interface AutomationWebhookPrismaLike {
  $transaction<T>(work: (tx: AutomationWebhookPrismaLike) => Promise<T>, options?: { isolationLevel: 'ReadCommitted'; timeout: number }): Promise<T>;
  $executeRaw(...args: unknown[]): Promise<unknown>;
  automationRule: {
    findFirst(args: unknown): Promise<AutomationRuleRecord | null>;
  };
  automationWebhookToken: {
    findUnique(args: unknown): Promise<(WebhookTokenRecord & { rule?: AutomationRuleRecord | null }) | null>;
    create(args: unknown): Promise<WebhookTokenRecord>;
    upsert(args: unknown): Promise<WebhookTokenRecord>;
  };
  automationRun: {
    findFirst(args: unknown): Promise<WebhookRunRecord | null>;
    findMany(args: unknown): Promise<WebhookRunRecord[]>;
    create(args: unknown): Promise<unknown>;
    update(args: unknown): Promise<unknown>;
    updateMany(args: unknown): Promise<{ count: number }>;
  };
  channel: {
    findFirst(args: unknown): Promise<ChannelRecord | null>;
  };
  contact: {
    findFirst(args: unknown): Promise<ContactRecord | null>;
    create(args: unknown): Promise<ContactRecord>;
    updateMany(args: unknown): Promise<unknown>;
  };
  conversation: {
    upsert(args: unknown): Promise<Parameters<typeof toConversationDto>[0]>;
  };
  message: {
    create(args: unknown): Promise<Parameters<typeof toMessageDto>[0]>;
  };
}

export interface AutomationWebhookRunner {
  runForWebhookEvent(input: RunForWebhookEventInput): Promise<unknown>;
}

export class AutomationWebhookServiceError extends Error {
  constructor(
    public code: "AUTOMATION_NOT_FOUND" | "AUTOMATION_WEBHOOK_TRIGGER_MISSING",
    message: string
  ) {
    super(message);
  }
}

export type ParsedWebhookSubmission =
  | {
      ok: true;
      phone: string;
      name: string | null;
      payload: Record<string, unknown>;
      variables: AutomationVariables;
    }
  | { ok: false; code: "invalid_body" | "invalid_phone" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toIsoString(value: DateLike) {
  return value instanceof Date ? value.toISOString() : value;
}

function isUniqueConstraintError(error: unknown) {
  return isRecord(error) && error.code === "P2002";
}

export function generateAutomationWebhookToken() {
  return randomBytes(32).toString("base64url");
}

export function isWellFormedAutomationWebhookToken(token: string) {
  return TOKEN_PATTERN.test(token);
}

/**
 * Digits only; Brazilian national numbers (DDD + number, 10 or 11 digits) get
 * the 55 country code. Returns null when the result is not a plausible number.
 */
export function normalizeWebhookPhone(value: unknown) {
  const raw = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
  if (typeof raw !== "string") {
    return null;
  }

  let digits = raw.replace(/\D/g, "");
  if (digits.startsWith("00")) {
    digits = digits.slice(2);
  }

  if (digits.length === 10 || digits.length === 11) {
    digits = `55${digits}`;
  }

  if (digits.startsWith("55")) {
    return digits.length === 12 || digits.length === 13 ? digits : null;
  }

  return digits.length >= 12 && digits.length <= 15 ? digits : null;
}

function firstPresent(payload: Record<string, unknown>, keys: readonly string[]) {
  for (const key of keys) {
    const value = payload[key];
    if ((typeof value === "string" && value.trim().length > 0) || typeof value === "number") {
      return value;
    }
  }

  return undefined;
}

export function parseWebhookSubmission(body: unknown): ParsedWebhookSubmission {
  let payload = body;
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload) as unknown;
    } catch {
      return { ok: false, code: "invalid_body" };
    }
  }

  if (!isRecord(payload)) {
    return { ok: false, code: "invalid_body" };
  }

  const phone = normalizeWebhookPhone(firstPresent(payload, PHONE_KEYS));
  if (!phone) {
    return { ok: false, code: "invalid_phone" };
  }

  const rawName = firstPresent(payload, NAME_KEYS);
  const name =
    typeof rawName === "string" ? rawName.replace(/\s+/g, " ").trim().slice(0, MAX_NAME_LENGTH) || null : null;
  const variables = flattenAutomationVariables(payload);
  if (name && !Object.hasOwn(variables, "nome")) {
    variables.nome = name;
  }

  return { ok: true, phone, name, payload, variables };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value) ?? "null";
}

export function webhookSubmissionFingerprint(phone: string, payload: Record<string, unknown>) {
  const stablePayload = Object.fromEntries(
    Object.entries(payload).filter(([key]) => !VOLATILE_PAYLOAD_KEYS.has(key))
  );

  return createHash("sha256")
    .update(`${phone}\n${stableStringify(stablePayload)}`)
    .digest("hex")
    .slice(0, 40);
}

function webhookEventKey(fingerprint: string, bucket: number) {
  return `webhook.received:${fingerprint}:${bucket}`;
}

function readFlow(rule: AutomationRuleRecord) {
  const parsed = automationFlowSchema.safeParse(rule.actions);
  return parsed.success ? parsed.data : null;
}

function webhookTriggerFor(rule: AutomationRuleRecord) {
  const flow = readFlow(rule);
  return flow ? findWebhookTriggerNode(flow) : null;
}

function toWebhookDto(record: WebhookTokenRecord): AutomationWebhookDto {
  return {
    automationId: record.ruleId,
    token: record.token,
    path: automationWebhookPath(record.token),
    createdAt: toIsoString(record.createdAt),
    updatedAt: toIsoString(record.updatedAt)
  };
}

export function createAutomationWebhookService(options: {
  prisma: AutomationWebhookPrismaLike;
  runner: AutomationWebhookRunner;
  realtime?: { publish(event: unknown): void };
  generateToken?: () => string;
  now?: () => Date;
  onRecoveryError?: (error: unknown) => void;
}) {
  const { prisma } = options;
  const generateToken = options.generateToken ?? generateAutomationWebhookToken;
  const now = options.now ?? (() => new Date());

  async function findWebhookRule(input: { workspaceId: string; automationId: string }) {
    const rule = await prisma.automationRule.findFirst({
      where: { workspaceId: input.workspaceId, id: input.automationId }
    });

    if (!rule) {
      throw new AutomationWebhookServiceError("AUTOMATION_NOT_FOUND", "Automation rule not found.");
    }

    if (!webhookTriggerFor(rule)) {
      throw new AutomationWebhookServiceError(
        "AUTOMATION_WEBHOOK_TRIGGER_MISSING",
        "Salve o fluxo com o gatilho Webhook externo para gerar o link."
      );
    }

    return rule;
  }

  async function upsertContact(input: { workspaceId: string; phone: string; name: string | null }, database = prisma) {
    const phone = normalizePhoneForStorage(input.phone);
    const where = { workspaceId: input.workspaceId, phone: { in: buildPhoneLookupCandidates(phone) } };
    let contact = await database.contact.findFirst({ where, orderBy: { updatedAt: "desc" } });

    if (!contact) {
      try {
        contact = await database.contact.create({
          data: {
            workspaceId: input.workspaceId,
            phone,
            ...(input.name ? { name: input.name } : {})
          }
        });
        return contact;
      } catch (error) {
        if (!isUniqueConstraintError(error)) {
          throw error;
        }
        contact = await database.contact.findFirst({ where, orderBy: { updatedAt: "desc" } });
        if (!contact) {
          throw error;
        }
      }
    }

    if (input.name && !contact.name?.trim()) {
      // Conditional update: a name typed by the team in the meantime wins.
      await database.contact.updateMany({
        where: { workspaceId: input.workspaceId, id: contact.id, OR: [{ name: null }, { name: "" }] },
        data: { name: input.name }
      });
    }

    return contact;
  }

  async function failRecoverableRun(database: AutomationWebhookPrismaLike, run: WebhookRunRecord, error: string) {
    const prior = isRecord(run.result) ? run.result : {};
    const fence = run.status === 'queued' ? { status: 'queued', executionToken: null }
      : { status: 'running', executionToken: run.executionToken, leaseUntil: { lte: now() } };
    await database.automationRun.updateMany({ where: { id: run.id, workspaceId: run.workspaceId, ...fence }, data: {
      status: 'failed', executionToken: null, leaseUntil: null,
      result: { ...prior, mode: 'real', runner: 'graph', needsReview: run.status === 'running', error, ...(Array.isArray(prior.actionResults) ? {} : { actionResults: [] }) }
    } });
  }

  const service = {
    async getOrCreateWebhook(input: { workspaceId: string; automationId: string }) {
      const rule = await findWebhookRule(input);
      const existing = await prisma.automationWebhookToken.findUnique({
        where: { workspaceId_ruleId: { workspaceId: input.workspaceId, ruleId: rule.id } }
      });

      if (existing) {
        return toWebhookDto(existing);
      }

      try {
        return toWebhookDto(
          await prisma.automationWebhookToken.create({
            data: { workspaceId: input.workspaceId, ruleId: rule.id, token: generateToken() }
          })
        );
      } catch (error) {
        // Two editors opened the block at the same time: keep the first token.
        const concurrent = isUniqueConstraintError(error)
          ? await prisma.automationWebhookToken.findUnique({
              where: { workspaceId_ruleId: { workspaceId: input.workspaceId, ruleId: rule.id } }
            })
          : null;
        if (!concurrent) {
          throw error;
        }
        return toWebhookDto(concurrent);
      }
    },

    async regenerateWebhook(input: { workspaceId: string; automationId: string }) {
      const rule = await findWebhookRule(input);
      const token = generateToken();
      const record = await prisma.automationWebhookToken.upsert({
        where: { workspaceId_ruleId: { workspaceId: input.workspaceId, ruleId: rule.id } },
        create: { workspaceId: input.workspaceId, ruleId: rule.id, token },
        update: { token }
      });

      return toWebhookDto(record);
    },

    /** Resolves a public token to an enabled automation that still starts with the webhook trigger. */
    async resolveToken(token: string) {
      if (!isWellFormedAutomationWebhookToken(token)) {
        return null;
      }

      const record = await prisma.automationWebhookToken.findUnique({
        where: { token },
        include: { rule: true }
      });
      const rule = record?.rule;

      if (!record || !rule || rule.workspaceId !== record.workspaceId || rule.status !== "enabled") {
        return null;
      }

      return webhookTriggerFor(rule) ? rule : null;
    },

    /**
     * Claims the submission before answering the browser. The same phone and
     * payload inside the dedupe window maps to an existing run and is ignored;
     * the unique run event key also settles concurrent duplicates.
     */
    async claimSubmission(input: {
      rule: AutomationRuleRecord;
      submission: Extract<ParsedWebhookSubmission, { ok: true }>;
    }): Promise<{ claimed: true; eventKey: string } | { claimed: false }> {
      const current = now();
      const fingerprint = webhookSubmissionFingerprint(input.submission.phone, input.submission.payload);
      const bucket = Math.floor(current.getTime() / DEDUPE_WINDOW_MS);
      const previous = await prisma.automationRun.findFirst({
        where: {
          workspaceId: input.rule.workspaceId,
          ruleId: input.rule.id,
          eventKey: webhookEventKey(fingerprint, bucket - 1),
          createdAt: { gte: new Date(current.getTime() - DEDUPE_WINDOW_MS) }
        },
        select: { id: true }
      });

      if (previous) {
        return { claimed: false };
      }

      const eventKey = webhookEventKey(fingerprint, bucket);
      try {
        await prisma.automationRun.create({
          data: {
            workspaceId: input.rule.workspaceId,
            ruleId: input.rule.id,
            eventKey,
            status: "queued",
            input: {
              source: "automation_webhook",
              trigger: "webhook.received",
              phone: input.submission.phone,
              payload: input.submission.payload,
              submission: input.submission,
              teamNoteBody: formatAutomationVariablesForTeam(FORM_NOTE_TITLE, input.submission.variables),
              channelId: readWebhookTriggerChannelId(webhookTriggerFor(input.rule)!)
            },
            result: { mode: "real", runner: "graph", actionResults: [] }
          }
        });
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          return { claimed: false };
        }
        throw error;
      }

      return { claimed: true, eventKey };
    },

    async processSubmission(input: {
      rule: AutomationRuleRecord;
      eventKey: string;
      submission: Extract<ParsedWebhookSubmission, { ok: true }>;
    }) {
      const { rule, eventKey } = input, workspaceId = rule.workspaceId;
      // Only local writes happen under this lock. A crash before commit rolls back the
      // anchor; after commit every process resumes the same message UUID.
      const prepared = await prisma.$transaction(async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`automation-webhook:${workspaceId}:${rule.id}:${eventKey}`}, 0))`;
        const run = await tx.automationRun.findFirst({ where: { workspaceId, ruleId: rule.id, eventKey } });
        if (!run) throw new Error('Durable webhook submission missing.');
        if (['completed', 'failed', 'skipped'].includes(run.status)) return { terminal: run };
        if (run.status === 'running' && (!run.executionToken || !run.leaseUntil || new Date(run.leaseUntil).getTime() > now().getTime())) return { terminal: run };
        const stored = isRecord(run.input) ? run.input : {};
        const saved = isRecord(stored.submission) ? stored.submission : null;
        const submission = saved && saved.ok === true && typeof saved.phone === 'string' && isRecord(saved.payload) && isRecord(saved.variables)
          ? saved as Extract<ParsedWebhookSubmission, { ok: true }> : input.submission;
        const trigger = webhookTriggerFor(rule);
        const channelId = typeof stored.channelId === 'string' ? stored.channelId : trigger ? readWebhookTriggerChannelId(trigger) : null;
        const channel = channelId ? await tx.channel.findFirst({ where: { workspaceId, id: channelId } }) : null;
        if (!channel) {
          await failRecoverableRun(tx, run, 'Canal do WhatsApp não encontrado. Escolha o canal no gatilho Webhook externo.');
          return { terminal: run };
        }
        if (typeof stored.messageId === 'string') return { messageId: stored.messageId, channel, submission, runInput: stored };
        const contact = await upsertContact({ workspaceId, phone: submission.phone, name: submission.name }, tx);
        const receivedAt = now();
        const conversation = await tx.conversation.upsert({
          where: { workspaceId_channelId_contactId: { workspaceId, channelId: channel.id, contactId: contact.id } },
          create: { workspaceId, channelId: channel.id, contactId: contact.id, status: 'open', lastMessageAt: receivedAt, lastMessagePreview: FORM_NOTE_TITLE, unreadCount: 1 },
          update: { status: 'open', lastMessageAt: receivedAt, lastMessagePreview: FORM_NOTE_TITLE, unreadCount: { increment: 1 } },
          include: { contact: true, channel: true, department: true, assignedUser: true }
        });
        const message = await tx.message.create({ data: { workspaceId, conversationId: conversation.id,
          providerEventId: `automation-webhook:${rule.id}:${eventKey}`, direction: 'inbound', type: 'system',
          body: typeof stored.teamNoteBody === 'string' ? stored.teamNoteBody : formatAutomationVariablesForTeam(FORM_NOTE_TITLE, submission.variables), status: 'delivered',
          metadata: { source: 'automation_webhook', automationId: rule.id, eventKey } } });
        const runInput = { ...stored, source: 'automation_webhook', trigger: 'webhook.received', phone: submission.phone, payload: submission.payload,
          submission, channelId: channel.id, messageId: message.id, conversationId: conversation.id, contactId: contact.id };
        await tx.automationRun.update({ where: { id: run.id }, data: { input: runInput } });
        return { messageId: message.id, channel, submission, runInput, created: { message, conversation } };
      }, { isolationLevel: 'ReadCommitted', timeout: 15000 });
      if ('terminal' in prepared) return prepared.terminal;
      if (prepared.created) {
        options.realtime?.publish({ type: 'message.created', workspaceId, payload: toMessageDto(prepared.created.message) });
        options.realtime?.publish({ type: 'conversation.updated', workspaceId, payload: toConversationDto(prepared.created.conversation) });
      }
      // The runner owns the execution lease and action checkpoints. BUSY, LOST and
      // uncertain results must never be overwritten by a preparation error handler.
      return options.runner.runForWebhookEvent({ workspaceId, rule, messageId: prepared.messageId, eventKey,
        variables: prepared.submission.variables, outboundBlockedReason: prepared.channel.provider === 'meta_cloud' ? META_FIRST_MESSAGE_BLOCKED_REASON : null,
        runInput: prepared.runInput });
    },

    async processDueSubmissions(input: { limit?: number; workspaceIds?: readonly string[] } = {}) {
      const at = now(), staleBefore = new Date(at.getTime() - 10 * 60_000), limit = Math.max(1, Math.min(100, input.limit ?? 25));
      const rows = await prisma.automationRun.findMany({ where: {
        input: { path: ['source'], equals: 'automation_webhook' },
        ...(input.workspaceIds ? { workspaceId: { in: [...input.workspaceIds] } } : {}),
        OR: [{ status: 'queued', executionToken: null, OR: [{ leaseUntil: null }, { leaseUntil: { lte: at } }] }, { status: 'running', executionToken: { not: null }, leaseUntil: { lte: at } }, { status: 'running', executionToken: null, updatedAt: { lte: staleBefore } }]
      }, orderBy: { createdAt: 'asc' }, take: limit });
      let processed = 0;
      for (const row of rows) {
        if (row.status === 'running' && !row.executionToken) {
          await prisma.automationRun.updateMany({ where: { id: row.id, workspaceId: row.workspaceId, status: 'running', executionToken: null, updatedAt: { lte: staleBefore } }, data: { status: 'failed', result: { mode: 'real', runner: 'graph', needsReview: true, error: 'Legacy webhook execution requires human review; no action was replayed.', actionResults: [] } } });
          continue;
        }
        const rule = await prisma.automationRule.findFirst({ where: { workspaceId: row.workspaceId, id: row.ruleId } });
        if (!rule || rule.status !== 'enabled' || !webhookTriggerFor(rule)) {
          await failRecoverableRun(prisma, row, 'Accepted webhook automation is no longer available.');
          continue;
        }
        const stored = isRecord(row.input) ? row.input : {};
        const parsed = parseWebhookSubmission(stored.payload);
        if (!parsed.ok) {
          await failRecoverableRun(prisma, row, 'Durable webhook payload is invalid.');
          continue;
        }
        try { await service.processSubmission({ rule, eventKey: row.eventKey, submission: parsed }); processed++; }
        catch (error) {
          options.onRecoveryError?.(error);
          // Only a queued run can have its preparation retried. Never overwrite a
          // runner lease or its action checkpoint after execution began.
          const prior = isRecord(row.result) ? row.result : {}, attempts = Number(prior.preparationAttempts ?? 0) + 1;
          await prisma.automationRun.updateMany({ where: { id: row.id, workspaceId: row.workspaceId, status: 'queued', executionToken: null }, data: {
            status: attempts >= 6 ? 'failed' : 'queued', leaseUntil: attempts >= 6 ? null : new Date(at.getTime() + Math.min(15 * 60_000, 30_000 * 2 ** (attempts - 1))),
            result: { ...prior, preparationAttempts: attempts, needsReview: attempts >= 6, error: 'WEBHOOK_PREPARATION_RETRY', actionResults: [] }
          } }).catch(() => undefined);
        }
      }
      return { processed };
    }

  };
  return service;
}

export type AutomationWebhookService = ReturnType<typeof createAutomationWebhookService>;
