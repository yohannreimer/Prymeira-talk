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

export interface AutomationWebhookPrismaLike {
  automationRule: {
    findFirst(args: unknown): Promise<AutomationRuleRecord | null>;
  };
  automationWebhookToken: {
    findUnique(args: unknown): Promise<(WebhookTokenRecord & { rule?: AutomationRuleRecord | null }) | null>;
    create(args: unknown): Promise<WebhookTokenRecord>;
    upsert(args: unknown): Promise<WebhookTokenRecord>;
  };
  automationRun: {
    findFirst(args: unknown): Promise<{ id: string } | null>;
    create(args: unknown): Promise<unknown>;
    update(args: unknown): Promise<unknown>;
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

function sanitizeError(error: unknown) {
  return error instanceof Error ? error.message : "Falha ao processar o webhook.";
}

export function createAutomationWebhookService(options: {
  prisma: AutomationWebhookPrismaLike;
  runner: AutomationWebhookRunner;
  realtime?: { publish(event: unknown): void };
  generateToken?: () => string;
  now?: () => Date;
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

  async function failRun(input: { workspaceId: string; ruleId: string; eventKey: string; error: string }) {
    await prisma.automationRun.update({
      where: {
        workspaceId_ruleId_eventKey: {
          workspaceId: input.workspaceId,
          ruleId: input.ruleId,
          eventKey: input.eventKey
        }
      },
      data: {
        status: "failed",
        result: { mode: "real", runner: "graph", error: input.error, actionResults: [] }
      }
    });
  }

  async function upsertContact(input: { workspaceId: string; phone: string; name: string | null }) {
    const phone = normalizePhoneForStorage(input.phone);
    const where = { workspaceId: input.workspaceId, phone: { in: buildPhoneLookupCandidates(phone) } };
    let contact = await prisma.contact.findFirst({ where, orderBy: { updatedAt: "desc" } });

    if (!contact) {
      try {
        contact = await prisma.contact.create({
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
        contact = await prisma.contact.findFirst({ where, orderBy: { updatedAt: "desc" } });
        if (!contact) {
          throw error;
        }
      }
    }

    if (input.name && !contact.name?.trim()) {
      // Conditional update: a name typed by the team in the meantime wins.
      await prisma.contact.updateMany({
        where: { workspaceId: input.workspaceId, id: contact.id, OR: [{ name: null }, { name: "" }] },
        data: { name: input.name }
      });
    }

    return contact;
  }

  return {
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
            status: "running",
            input: {
              source: "automation_webhook",
              trigger: "webhook.received",
              phone: input.submission.phone,
              payload: input.submission.payload
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
      const { rule, eventKey, submission } = input;
      const workspaceId = rule.workspaceId;

      try {
        const trigger = webhookTriggerFor(rule);
        const channelId = trigger ? readWebhookTriggerChannelId(trigger) : null;
        const channel = channelId
          ? await prisma.channel.findFirst({ where: { workspaceId, id: channelId } })
          : null;

        if (!channel) {
          await failRun({
            workspaceId,
            ruleId: rule.id,
            eventKey,
            error: "Canal do WhatsApp não encontrado. Escolha o canal no gatilho Webhook externo."
          });
          return null;
        }

        const contact = await upsertContact({ workspaceId, phone: submission.phone, name: submission.name });
        const body = formatAutomationVariablesForTeam(FORM_NOTE_TITLE, submission.variables);
        const receivedAt = now();
        const conversation = await prisma.conversation.upsert({
          where: {
            workspaceId_channelId_contactId: { workspaceId, channelId: channel.id, contactId: contact.id }
          },
          create: {
            workspaceId,
            channelId: channel.id,
            contactId: contact.id,
            status: "open",
            lastMessageAt: receivedAt,
            lastMessagePreview: FORM_NOTE_TITLE,
            unreadCount: 1
          },
          update: {
            status: "open",
            lastMessageAt: receivedAt,
            lastMessagePreview: FORM_NOTE_TITLE,
            unreadCount: { increment: 1 }
          },
          include: { contact: true, channel: true, department: true, assignedUser: true }
        });
        // System message (not a WhatsApp message): visible to the team and the
        // anchor the automation runner and agent work from.
        const message = await prisma.message.create({
          data: {
            workspaceId,
            conversationId: conversation.id,
            providerEventId: `automation-webhook:${rule.id}:${eventKey}`,
            direction: "inbound",
            type: "system",
            body,
            status: "delivered",
            metadata: { source: "automation_webhook", automationId: rule.id, eventKey }
          }
        });

        options.realtime?.publish({ type: "message.created", workspaceId, payload: toMessageDto(message) });
        options.realtime?.publish({
          type: "conversation.updated",
          workspaceId,
          payload: toConversationDto(conversation)
        });

        const run = await options.runner.runForWebhookEvent({
          workspaceId,
          rule,
          messageId: message.id,
          eventKey,
          variables: submission.variables,
          outboundBlockedReason: channel.provider === "meta_cloud" ? META_FIRST_MESSAGE_BLOCKED_REASON : null,
          runInput: { phone: submission.phone, payload: submission.payload }
        });
        if (!run) {
          await failRun({ workspaceId, ruleId: rule.id, eventKey, error: "O fluxo não pôde ser iniciado." });
        }

        return run;
      } catch (error) {
        await failRun({ workspaceId, ruleId: rule.id, eventKey, error: sanitizeError(error) }).catch(() => undefined);
        throw error;
      }
    }
  };
}

export type AutomationWebhookService = ReturnType<typeof createAutomationWebhookService>;
