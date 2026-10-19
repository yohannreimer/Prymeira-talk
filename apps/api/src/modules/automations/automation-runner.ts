import { enterCanonicalWorkspaceTransaction } from "../messaging/canonical-boundary.js";
import { claimAutomationExecution, type AutomationExecution } from './automation-execution.js';
import {
  automationFlowSchema,
  getAutomationBlock,
  type AutomationEdgeDefinition,
  type AutomationFlowDefinition,
  type AutomationNodeDefinition
} from "@prymeira-talk/shared";
import { EvolutionClientError } from "../evolution/evolution.client.js";
import type { EvolutionRuntime } from "../evolution/evolution-runtime.js";
import { interpolateAutomationText, type AutomationVariables } from "./automation-variables.js";

type DateLike = Date | string;

export interface AutomationRuleRecord {
  id: string;
  workspaceId: string;
  name: string;
  status: "enabled" | "disabled";
  trigger: string;
  conditions: unknown;
  actions: unknown;
  createdAt: DateLike;
  updatedAt: DateLike;
}

export interface AutomationRunRecord {
  id: string;
  workspaceId: string;
  ruleId: string;
  eventKey: string;
  status: string;
  input: unknown;
  result: unknown;
  createdAt: DateLike;
  updatedAt: DateLike;
  executionToken?: string | null;
  leaseUntil?: DateLike | null;
}

interface MessageRecord {
  id: string;
  workspaceId: string;
  conversationId: string;
  hiddenByReset?: boolean;
  providerMessageId?: string | null;
  providerEventId?: string | null;
  direction: "inbound" | "outbound";
  type: "text" | "image" | "audio" | "file" | "template" | "system" | "internal_note";
  body?: string | null;
  mediaUrl?: string | null;
  status: string;
  sentByUserId?: string | null;
  createdAt: DateLike;
  updatedAt: DateLike;
  conversation: ConversationRecord;
}

interface ConversationRecord {
  id: string;
  workspaceId: string;
  channelId: string;
  contactId: string;
  status: string;
  assignedUserId?: string | null;
  departmentId?: string | null;
  priority: string;
  historyResetAt?: DateLike | null;
  lastMessageAt?: DateLike | null;
  lastMessagePreview?: string | null;
  unreadCount: number;
  createdAt: DateLike;
  updatedAt: DateLike;
  contact: {
    id: string;
    phone: string;
    name?: string | null;
  };
  channel: {
    id: string;
    provider: string;
    providerKey: string;
    displayName?: string | null;
  };
  tags?: Array<{
    tag: {
      id: string;
      name: string;
    };
  }>;
}

export interface AutomationRunnerPrisma {
  automationRule: {
    findMany(args: {
      where: { workspaceId: string; status?: "enabled"; trigger: string; id?: string };
      orderBy: Array<{ createdAt: "asc" }>;
    }): Promise<AutomationRuleRecord[]>;
  };
  automationRun: {
    upsert(args: {
      where: {
        workspaceId_ruleId_eventKey: {
          workspaceId: string;
          ruleId: string;
          eventKey: string;
        };
      };
      create: {
        id?: string;
        workspaceId: string;
        ruleId: string;
        eventKey: string;
        status: string;
        input: unknown;
        result: unknown;
        executionToken?: string | null;
        leaseUntil?: Date | null;
      };
      update: {
        status?: string;
        input?: unknown;
        result?: unknown;
      };
    }): Promise<AutomationRunRecord>;
    updateMany?(args: unknown): Promise<{ count: number }>;
    findMany?(args: unknown): Promise<AutomationRunRecord[]>;
  };
  message: {
    findUnique(args: unknown): Promise<MessageRecord | null>;
    count(args: unknown): Promise<number>;
    findFirst(args: unknown): Promise<(MessageRecord & { conversation?: ConversationRecord }) | null>;
    create(args: unknown): Promise<unknown>;
  };
  conversation: {
    update(args: unknown): Promise<unknown>;
    updateMany(args: unknown): Promise<unknown>;
  };
  tag: {
    upsert(args: unknown): Promise<{ id: string; name: string }>;
    findFirst(args: unknown): Promise<{ id: string; name: string } | null>;
  };
  conversationTag: {
    create(args: unknown): Promise<unknown>;
    deleteMany(args: unknown): Promise<unknown>;
    findFirst(args: unknown): Promise<unknown>;
  };
  contactBoardStage: {
    findFirst(args: unknown): Promise<{ id: string; boardId: string; name: string } | null>;
  };
  contactBoardMembership: {
    findFirst(args: unknown): Promise<{ stageId: string; stage?: { id: string; name: string } } | null>;
    upsert(args: unknown): Promise<unknown>;
  };
  contactNote: {
    create(args: unknown): Promise<unknown>;
  };
}

interface AutomationRunnerRealtime {
  publish(event: unknown): void;
}

export interface AutomationRunnerEvolution {
  mode: EvolutionRuntime["mode"];
  client?: Pick<NonNullable<EvolutionRuntime["client"]>, "sendText" | "sendMedia" | "getGroupInfo"> | null;
}

export interface AutomationRunnerAgentRuntime {
  activateForMessage(input: {
    workspaceId: string;
    agentId: string;
    conversationId: string;
    messageId: string;
    instruction?: string | null;
  }): Promise<{
    status: "completed" | "handoff_requested" | "skipped" | "failed";
    sessionId?: string;
    message?: string;
  }>;
  runForMessage?: (input: {
    workspaceId: string;
    agentId: string;
    conversationId: string;
    messageId: string;
    trigger: "automation";
    instruction?: string | null;
  }) => Promise<{
    status: "completed" | "handoff_requested" | "skipped" | "failed";
    runId?: string;
    message?: string;
  }>;
}

export interface AutomationRunnerAgentReplyScheduler {
  scheduleActiveSessionForMessage(input: {
    workspaceId: string;
    conversationId: string;
    messageId: string;
  }): Promise<{
    scheduled: boolean;
    scheduledAt?: Date | string;
  }>;
}

export interface AutomationRunnerOptions {
  prisma: AutomationRunnerPrisma;
  onRecoveryError?: (failure: { id: string; code: string }) => void;
  agentRuntime?: AutomationRunnerAgentRuntime;
  agentReplyScheduler?: AutomationRunnerAgentReplyScheduler;
  evolution?: AutomationRunnerEvolution;
  realtime?: AutomationRunnerRealtime;
  boardRules?: {
    applyBoardRulesForConversationTags(input: {
      workspaceId: string;
      conversationId: string;
    }): Promise<unknown>;
  };
}

export interface RunForInboundMessageInput {
  workspaceId: string;
  messageId: string;
  eventKey: string;
  automationId?: string;
  includeDisabled?: boolean;
}

export interface RunForWebhookEventInput {
  workspaceId: string;
  rule: AutomationRuleRecord;
  /** System message that records the external event; anchors the conversation. */
  messageId: string;
  eventKey: string;
  variables: AutomationVariables;
  /** When set, steps that would send WhatsApp messages are skipped with this reason. */
  outboundBlockedReason?: string | null;
  runInput?: Record<string, unknown>;
}

export interface ActionResult {
  nodeId: string;
  type: string;
  label: string;
  status: "completed" | "failed" | "skipped";
  branch?: string;
  mode?: "real";
  message?: string;
  runId?: string;
  sessionId?: string;
  error?: string;
}

interface ExecuteContext {
  message: MessageRecord;
  conversation: ConversationRecord;
  eventKey: string;
  variables?: AutomationVariables;
  outboundBlockedReason?: string | null;
}

const OUTBOUND_BLOCK_TYPES = new Set([
  "send_message",
  "ask_open_reply",
  "send_quick_reply",
  "send_image",
  "send_file",
  "run_agent"
]);

const MAX_GRAPH_STEPS = 80;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectStrings(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.flatMap(collectStrings);
  }

  if (isRecord(value)) {
    return Object.values(value).flatMap(collectStrings);
  }

  return [];
}

function configValue(node: AutomationNodeDefinition, keys: string[]) {
  for (const key of keys) {
    const value = node.data.config[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }

  return null;
}

function configValues(node: AutomationNodeDefinition, keys: string[]) {
  return keys
    .flatMap((key) => collectStrings(node.data.config[key]))
    .flatMap((value) => value.split(/[,\n]/))
    .map((value) => value.trim())
    .filter(Boolean);
}

function configNumber(node: AutomationNodeDefinition, keys: string[]) {
  for (const key of keys) {
    const value = node.data.config[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const number = Number(value);
      if (Number.isFinite(number)) {
        return number;
      }
    }
  }

  return null;
}

function toDate(value: DateLike) {
  return value instanceof Date ? value : new Date(value);
}

function flowFromRule(rule: AutomationRuleRecord): AutomationFlowDefinition | null {
  const parsed = automationFlowSchema.safeParse(rule.actions);
  return parsed.success ? parsed.data : null;
}

function nodeLabel(node: AutomationNodeDefinition) {
  return getAutomationBlock(node.type)?.label ?? node.type;
}

function resultFor(
  node: AutomationNodeDefinition,
  status: ActionResult["status"],
  extra: Partial<ActionResult> = {}
): ActionResult {
  return {
    nodeId: node.id,
    type: node.type,
    label: nodeLabel(node),
    status,
    mode: "real",
    ...extra
  };
}

function outgoingEdges(
  flow: AutomationFlowDefinition,
  node: AutomationNodeDefinition,
  branch?: string,
  options: { exact?: boolean } = {}
) {
  const edges = flow.edges.filter((edge) => edge.source === node.id);

  if (!branch) {
    return (
      edges.filter((edge) => !edge.sourceHandle || edge.sourceHandle === "success")[0] ??
      edges[0] ??
      null
    );
  }

  if (options.exact) {
    return edges.find((edge) => edge.sourceHandle === branch) ?? null;
  }

  return (
    edges.find((edge) => edge.sourceHandle === branch) ??
    edges.find((edge) => edge.sourceHandle === (branch === "yes" ? "true" : "false")) ??
    edges.find((edge) => !edge.sourceHandle || edge.sourceHandle === "success") ??
    null
  );
}

function findTarget(flow: AutomationFlowDefinition, edge: AutomationEdgeDefinition | null) {
  if (!edge) {
    return null;
  }

  return flow.nodes.find((node) => node.id === edge.target) ?? null;
}

function messageText(context: ExecuteContext) {
  return context.message.body?.trim() ?? "";
}

// Only externally triggered runs carry variables; message-triggered flows keep
// their configured text untouched.
function withVariables(context: ExecuteContext, text: string): string;
function withVariables(context: ExecuteContext, text: string | null): string | null;
function withVariables(context: ExecuteContext, text: string | null) {
  return text !== null && context.variables
    ? interpolateAutomationText(text, context.variables)
    : text;
}

function textContains(haystack: string, needle: string) {
  return haystack.toLocaleLowerCase("pt-BR").includes(needle.toLocaleLowerCase("pt-BR"));
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function textMatchesKeyword(haystack: string, keyword: string) {
  const pattern = keyword.split(/\s+/).map(escapeRegExp).join("\\s+");
  const keywordPattern = new RegExp(`(^|[^\\p{L}\\p{N}])${pattern}(?=$|[^\\p{L}\\p{N}])`, "iu");
  return keywordPattern.test(haystack);
}

function timeToMinutes(value: string | null) {
  if (!value) {
    return null;
  }

  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) {
    return null;
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return null;
  }

  return hours * 60 + minutes;
}

function isWithinTimeWindow(date: Date, start: number, end: number) {
  const minutes = date.getHours() * 60 + date.getMinutes();

  if (start <= end) {
    return minutes >= start && minutes <= end;
  }

  return minutes >= start || minutes <= end;
}

function isPrismaKnownRequestErrorCode(error: unknown, code: string) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

async function createOutboundText(
  options: AutomationRunnerOptions,
  context: ExecuteContext,
  text: string
) {
  const providerSend =
    options.evolution?.mode === "real" && options.evolution.client
      ? await options.evolution.client.sendText({
          instanceName: context.conversation.channel.providerKey,
          number: context.conversation.contact.phone,
          text
        })
      : null;

  await options.prisma.message.create({
    data: {
      workspaceId: context.message.workspaceId,
      conversationId: context.conversation.id,
      direction: "outbound",
      type: "text",
      body: text,
      providerMessageId: providerSend?.providerMessageId ?? undefined,
      status: providerSend ? "sent" : "pending",
      sentByUserId: null
    }
  });
  if (!await sourceStillCurrent(options, context)) return;
  await options.prisma.conversation.update({
    where: {
      workspaceId_id: {
        workspaceId: context.message.workspaceId,
        id: context.conversation.id
      }
    },
    data: {
      lastMessageAt: new Date(),
      lastMessagePreview: text
    }
  });
}

async function createOutboundMedia(
  options: AutomationRunnerOptions,
  context: ExecuteContext,
  input: {
    mediaUrl: string;
    fileName: string;
    mimetype: string;
    caption?: string;
    mediatype: "image" | "document";
  }
) {
  const providerSend =
    options.evolution?.mode === "real" && options.evolution.client
      ? await options.evolution.client.sendMedia({
          instanceName: context.conversation.channel.providerKey,
          number: context.conversation.contact.phone,
          mediatype: input.mediatype,
          mimetype: input.mimetype,
          media: input.mediaUrl,
          fileName: input.fileName,
          caption: input.caption
        })
      : null;
  const body = input.caption?.trim() || input.fileName;

  await options.prisma.message.create({
    data: {
      workspaceId: context.message.workspaceId,
      conversationId: context.conversation.id,
      direction: "outbound",
      type: input.mediatype === "image" ? "image" : "file",
      body,
      mediaUrl: input.mediaUrl,
      providerMessageId: providerSend?.providerMessageId ?? undefined,
      status: providerSend ? "sent" : "pending",
      sentByUserId: null
    }
  });
  if (!await sourceStillCurrent(options, context)) return;
  await options.prisma.conversation.update({
    where: {
      workspaceId_id: {
        workspaceId: context.message.workspaceId,
        id: context.conversation.id
      }
    },
    data: {
      lastMessageAt: new Date(),
      lastMessagePreview: body
    }
  });
}

async function executeNode(
  options: AutomationRunnerOptions,
  context: ExecuteContext,
  node: AutomationNodeDefinition
): Promise<{ result: ActionResult; branch?: string; branchExact?: boolean; stop?: boolean }> {
  if (getAutomationBlock(node.type)?.category === "trigger") {
    return { result: resultFor(node, "completed") };
  }

  if (context.outboundBlockedReason && OUTBOUND_BLOCK_TYPES.has(node.type)) {
    return {
      result: resultFor(node, "skipped", { message: context.outboundBlockedReason }),
      stop: node.type === "run_agent"
    };
  }

  if (node.type === "send_message" || node.type === "ask_open_reply" || node.type === "send_quick_reply") {
    const configuredText = configValue(node, ["message", "body", "text"]);
    const text = configuredText ? withVariables(context, configuredText).trim() : null;
    if (!text) {
      return {
        result: resultFor(node, "failed", { error: "Message text is required." }),
        stop: true
      };
    }

    await createOutboundText(options, context, text);
    return { result: resultFor(node, "completed") };
  }

  if (node.type === "send_image" || node.type === "send_file") {
    const mediaUrl = configValue(node, ["fileUrl", "mediaUrl", "url"]);
    const fileName =
      configValue(node, ["fileName", "filename", "name"]) ??
      (node.type === "send_image" ? "imagem.jpg" : "arquivo");
    const mimetype =
      configValue(node, ["mimetype", "mimeType"]) ??
      (node.type === "send_image" ? "image/jpeg" : "application/octet-stream");
    const caption = withVariables(context, configValue(node, ["caption", "message", "body"])) ?? undefined;

    if (!mediaUrl) {
      return {
        result: resultFor(node, "failed", { error: "Media URL is required." }),
        stop: true
      };
    }

    await createOutboundMedia(options, context, {
      mediaUrl,
      fileName,
      mimetype,
      caption,
      mediatype: node.type === "send_image" ? "image" : "document"
    });
    return { result: resultFor(node, "completed") };
  }

  if (node.type === "condition_text") {
    const needle = configValue(node, ["text", "keyword", "contains"]) ?? "";
    const branch = needle && textContains(messageText(context), needle) ? "yes" : "no";
    return { result: resultFor(node, "completed", { branch }), branch };
  }

  if (node.type === "condition_tag") {
    const tagName = configValue(node, ["tagName", "name", "tag"]);
    const branch = tagName
      ? context.conversation.tags?.some((item) => item.tag.name === tagName) ? "yes" : "no"
      : "no";
    return { result: resultFor(node, "completed", { branch }), branch };
  }

  if (node.type === "condition_channel") {
    const channelId = configValue(node, ["channelId"]);
    const providerKey = configValue(node, ["providerKey", "instanceName"]);
    const channelName = configValue(node, ["channelName", "displayName", "name"]);
    const matches =
      (channelId ? context.conversation.channel.id === channelId : true) &&
      (providerKey ? context.conversation.channel.providerKey === providerKey : true) &&
      (channelName ? context.conversation.channel.displayName === channelName : true);
    const branch = matches ? "yes" : "no";

    return { result: resultFor(node, "completed", { branch }), branch };
  }

  if (node.type === "condition_time") {
    const start = timeToMinutes(configValue(node, ["startTime", "start", "from"]));
    const end = timeToMinutes(configValue(node, ["endTime", "end", "to"]));
    const matches =
      start === null || end === null
        ? true
        : isWithinTimeWindow(toDate(context.message.createdAt), start, end);
    const branch = matches ? "yes" : "no";

    return { result: resultFor(node, "completed", { branch }), branch };
  }

  if (node.type === "condition_board_stage") {
    const stageId = configValue(node, ["stageId"]);
    const stageName = configValue(node, ["stageName", "stageLabel", "stage", "name"]);
    const membership = await options.prisma.contactBoardMembership.findFirst({
      where: {
        workspaceId: context.message.workspaceId,
        contactId: context.conversation.contactId,
        isPrimary: true,
        ...(stageId ? { stageId } : {}),
        ...(stageName ? { stage: { name: stageName } } : {})
      },
      include: { stage: true }
    });
    const branch = membership ? "yes" : "no";

    return { result: resultFor(node, "completed", { branch }), branch };
  }

  if (node.type === "add_tag") {
    const tagName = configValue(node, ["tagName", "name", "tag"]);
    if (!tagName) {
      return { result: resultFor(node, "failed", { error: "Tag name is required." }), stop: true };
    }

    const tag = await options.prisma.tag.upsert({
      where: {
        workspaceId_name: {
          workspaceId: context.message.workspaceId,
          name: tagName
        }
      },
      create: {
        workspaceId: context.message.workspaceId,
        name: tagName,
        color: "#2f5f4f"
      },
      update: {}
    });
    try {
      if (!await sourceStillCurrent(options, context)) return { result: resultFor(node, "skipped", { message: "Conversation history was reset." }), stop: true };
      await options.prisma.conversationTag.create({
        data: {
          workspaceId: context.message.workspaceId,
          conversationId: context.conversation.id,
          tagId: tag.id
        }
      });
    } catch (error) {
      if (!isPrismaKnownRequestErrorCode(error, "P2002")) {
        throw error;
      }
    }

    await options.boardRules?.applyBoardRulesForConversationTags({
      workspaceId: context.message.workspaceId,
      conversationId: context.conversation.id
    });
    return { result: resultFor(node, "completed") };
  }

  if (node.type === "remove_tag") {
    const tagName = configValue(node, ["tagName", "name", "tag"]);
    if (!tagName) {
      return { result: resultFor(node, "failed", { error: "Tag name is required." }), stop: true };
    }

    const tag = await options.prisma.tag.findFirst({
      where: { workspaceId: context.message.workspaceId, name: tagName }
    });
    if (tag) {
      if (!await sourceStillCurrent(options, context)) return { result: resultFor(node, "skipped", { message: "Conversation history was reset." }), stop: true };
      await options.prisma.conversationTag.deleteMany({
        where: {
          workspaceId: context.message.workspaceId,
          conversationId: context.conversation.id,
          tagId: tag.id
        }
      });
    }
    return { result: resultFor(node, "completed") };
  }

  if (node.type === "move_board_stage") {
    const stageId = configValue(node, ["stageId"]);
    const stageName = configValue(node, ["stageName", "stageLabel", "stage", "name"]);
    const stage = await options.prisma.contactBoardStage.findFirst({
      where: {
        workspaceId: context.message.workspaceId,
        ...(stageId ? { id: stageId } : {}),
        ...(stageName ? { name: stageName } : {})
      },
      orderBy: [{ order: "asc" }]
    });

    if (!stage) {
      return { result: resultFor(node, "failed", { error: "Board stage was not found." }), stop: true };
    }

    if (!await sourceStillCurrent(options, context)) return { result: resultFor(node, "skipped", { message: "Conversation history was reset." }), stop: true };
    await options.prisma.contactBoardMembership.upsert({
      where: {
        workspaceId_contactId_boardId: {
          workspaceId: context.message.workspaceId,
          contactId: context.conversation.contactId,
          boardId: stage.boardId
        }
      },
      create: {
        workspaceId: context.message.workspaceId,
        contactId: context.conversation.contactId,
        boardId: stage.boardId,
        stageId: stage.id,
        isPrimary: true
      },
      update: {
        stageId: stage.id,
        isPrimary: true
      }
    });
    return { result: resultFor(node, "completed") };
  }

  if (node.type === "assign_user") {
    const userId = configValue(node, ["userId", "assignedUserId"]);
    if (!userId) {
      return { result: resultFor(node, "failed", { error: "User ID is required." }), stop: true };
    }

    if (!await sourceStillCurrent(options, context)) return { result: resultFor(node, "skipped", { message: "Conversation history was reset." }), stop: true };
  await options.prisma.conversation.update({
      where: { workspaceId_id: { workspaceId: context.message.workspaceId, id: context.conversation.id } },
      data: { assignedUserId: userId }
    });
    return { result: resultFor(node, "completed") };
  }

  if (node.type === "change_priority") {
    const priority = configValue(node, ["priority"]) ?? "normal";
    if (!await sourceStillCurrent(options, context)) return { result: resultFor(node, "skipped", { message: "Conversation history was reset." }), stop: true };
  await options.prisma.conversation.update({
      where: { workspaceId_id: { workspaceId: context.message.workspaceId, id: context.conversation.id } },
      data: { priority }
    });
    return { result: resultFor(node, "completed") };
  }

  if (node.type === "create_internal_note") {
    const configuredBody = configValue(node, ["note", "body", "message"]);
    const body = configuredBody ? withVariables(context, configuredBody).trim() : null;
    if (!body) {
      return { result: resultFor(node, "failed", { error: "Note body is required." }), stop: true };
    }

    await options.prisma.contactNote.create({
      data: {
        workspaceId: context.message.workspaceId,
        contactId: context.conversation.contactId,
        conversationId: context.conversation.id,
        body,
        createdById: null
      }
    });
    return { result: resultFor(node, "completed") };
  }

  if (node.type === "close_conversation") {
    if (!await sourceStillCurrent(options, context)) return { result: resultFor(node, "skipped", { message: "Conversation history was reset." }), stop: true };
  await options.prisma.conversation.update({
      where: { workspaceId_id: { workspaceId: context.message.workspaceId, id: context.conversation.id } },
      data: { status: "closed" }
    });
    return { result: resultFor(node, "completed") };
  }

  if (node.type === "run_agent") {
    const agentId = configValue(node, ["agentId"]);
    const instruction = withVariables(context, configValue(node, ["instruction", "prompt", "message"]));

    if (!agentId) {
      return { result: resultFor(node, "failed", { error: "Agent ID is required." }), stop: true };
    }

    if (!options.agentRuntime) {
      return {
        result: resultFor(node, "failed", { error: "Agent runtime is not configured." }),
        stop: true
      };
    }

    const runtimeResult = await options.agentRuntime.activateForMessage({
      workspaceId: context.message.workspaceId,
      agentId,
      conversationId: context.conversation.id,
      messageId: context.message.id,
      instruction
    });
    const actionStatus =
      runtimeResult.status === "failed" || runtimeResult.status === "skipped"
        ? runtimeResult.status
        : "completed";
    const graphBranch =
      runtimeResult.status === "handoff_requested"
        ? "handoff"
        : runtimeResult.status === "completed"
          ? "success"
          : undefined;
    let replySchedule: Awaited<
      ReturnType<AutomationRunnerAgentReplyScheduler["scheduleActiveSessionForMessage"]>
    > | null = null;

    if (runtimeResult.status === "completed" && options.agentReplyScheduler) {
      replySchedule = await options.agentReplyScheduler.scheduleActiveSessionForMessage({
        workspaceId: context.message.workspaceId,
        conversationId: context.conversation.id,
        messageId: context.message.id
      });
    }

    return {
      result: resultFor(node, actionStatus, {
        message: runtimeResult.message ?? `Agent runtime ${runtimeResult.status}.`,
        ...(runtimeResult.status === "failed"
          ? { error: runtimeResult.message ?? "Agent runtime failed." }
          : {}),
        ...(replySchedule
          ? {
              replyScheduled: replySchedule.scheduled,
              ...(replySchedule.scheduledAt
                ? {
                    replyScheduledAt:
                      replySchedule.scheduledAt instanceof Date
                        ? replySchedule.scheduledAt.toISOString()
                        : replySchedule.scheduledAt
                  }
                : {})
            }
          : {}),
        branch: runtimeResult.status,
        sessionId: runtimeResult.sessionId
      }),
      branch: graphBranch,
      branchExact: runtimeResult.status === "handoff_requested",
      stop: runtimeResult.status === "failed" || runtimeResult.status === "skipped"
    };
  }

  if (node.type === "log_event") {
    return { result: resultFor(node, "completed") };
  }

  if (node.type === "end_flow") {
    return { result: resultFor(node, "completed"), stop: true };
  }

  return {
    result: resultFor(node, "skipped", { message: "Block execution is not implemented yet." })
  };
}

async function triggerMatches(
  options: AutomationRunnerOptions,
  context: ExecuteContext,
  node: AutomationNodeDefinition
) {
  if (node.type === "trigger_message_received") {
    return true;
  }

  if (node.type === "trigger_first_message") {
    const previousInboundCount = await options.prisma.message.count({
      where: {
        workspaceId: context.message.workspaceId,
        conversationId: context.message.conversationId,
        direction: "inbound",
        hiddenByReset: false,
        id: { not: context.message.id }
      }
    });

    return previousInboundCount === 0;
  }

  if (node.type === "trigger_reengagement") {
    const previousInbound = await options.prisma.message.findFirst({
      where: {
        workspaceId: context.message.workspaceId,
        conversationId: context.message.conversationId,
        direction: "inbound",
        hiddenByReset: false,
        id: { not: context.message.id },
        createdAt: { lt: toDate(context.message.createdAt) }
      },
      orderBy: { createdAt: "desc" }
    });

    if (!previousInbound) {
      return false;
    }

    const pauseDays = configNumber(node, ["pauseDays", "days"]);
    const pauseHours = configNumber(node, ["pauseHours", "hours"]) ?? (pauseDays ? pauseDays * 24 : 72);
    const elapsedMs =
      toDate(context.message.createdAt).getTime() - toDate(previousInbound.createdAt).getTime();

    return elapsedMs >= pauseHours * 60 * 60 * 1000;
  }

  if (node.type === "trigger_keyword") {
    const keywords = configValues(node, ["keywords", "keywordInput", "keyword", "text"]);
    const text = messageText(context);
    return keywords.some((keyword) => textMatchesKeyword(text, keyword));
  }

  return false;
}

async function sourceStillCurrent(options: AutomationRunnerOptions, context: ExecuteContext) {
  const source = await options.prisma.message.findUnique({ where: { id: context.message.id }, include: { conversation: true } });
  const epoch = (value: DateLike | null | undefined) => value ? toDate(value).getTime() : null;
  return Boolean(source && !source.hiddenByReset && source.workspaceId === context.message.workspaceId &&
    epoch(source.conversation?.historyResetAt) === epoch(context.conversation.historyResetAt));
}

function fencedFlowOptions(options: AutomationRunnerOptions, context: ExecuteContext): AutomationRunnerOptions {
  const prisma = { ...options.prisma };
  const methods: Record<string, string[]> = {
    message: ["create"], conversation: ["update", "updateMany"], tag: ["upsert"],
    conversationTag: ["create", "deleteMany"], contactBoardMembership: ["upsert"], contactNote: ["create"], automationRun: ["upsert"]
  };
  for (const [model, writes] of Object.entries(methods)) {
    const delegate = (options.prisma as any)[model];
    (prisma as any)[model] = { ...delegate };
    for (const method of writes) {
      (prisma as any)[model][method] = async (args: unknown) => {
        const write = async (db: AutomationRunnerPrisma) => {
          const current = await sourceStillCurrent({ ...options, prisma: db }, context);
          if (!current && model === "message" && method === "create") {
            const record = args as { data: Record<string, unknown> };
            // A send already accepted by the provider remains a hidden transport fact.
            if (record.data.status === "sent") return db.message.create({ data: { ...record.data, hiddenByReset: true } });
          }
          if (!current) throw new Error("Conversation history was reset.");
          return (db as any)[model][method](args);
        };
        const transactional = options.prisma as AutomationRunnerPrisma & { $transaction?: (work: (tx: AutomationRunnerPrisma) => Promise<unknown>, options: { isolationLevel: "ReadCommitted" }) => Promise<unknown> };
        return transactional.$transaction ? transactional.$transaction(async tx => {
          if (typeof (tx as any).$queryRaw === "function") await enterCanonicalWorkspaceTransaction(tx as any, context.message.workspaceId);
          return write(tx);
        }, { isolationLevel: "ReadCommitted" }) : write(options.prisma);
      };
    }
  }
  return { ...options, prisma };
}

async function executeFlow(
  options: AutomationRunnerOptions,
  context: ExecuteContext,
  flow: AutomationFlowDefinition,
  triggerNode: AutomationNodeDefinition,
  lease?: AutomationExecution
) {
  const fenced = fencedFlowOptions(options, context);
  const results: ActionResult[] = [];
  let current: AutomationNodeDefinition | null = triggerNode;
  let steps = 0;

  while (current && steps < MAX_GRAPH_STEPS) {
    if (!await sourceStillCurrent(options, context)) break;
    steps += 1;

    let execution: Awaited<ReturnType<typeof executeNode>>;
    try {
      execution = lease ? await lease.step(steps - 1, current.id, () => executeNode(fenced, context, current!))
        : await executeNode(fenced, context, current);
    } catch (error) {
      results.push(resultFor(current, "failed", { error: sanitizeError(error) }));
      break;
    }

    results.push(execution.result);

    if (execution.result.status === "failed" || execution.stop) {
      break;
    }

    current = findTarget(
      flow,
      outgoingEdges(flow, current, execution.branch, { exact: execution.branchExact })
    );
  }

  if (steps >= MAX_GRAPH_STEPS) {
    results.push({
      nodeId: "graph",
      type: "graph_guard",
      label: "Graph guard",
      status: "failed",
      mode: "real",
      error: "Automation graph exceeded the maximum number of steps."
    });
  }

  return results;
}

function runStatus(results: ActionResult[]) {
  return results.some((result) => result.status === "failed") ? "failed" : "completed";
}

async function loadContext(options: AutomationRunnerOptions, input: RunForInboundMessageInput) {
  const message = await options.prisma.message.findUnique({
    where: {
      id: input.messageId
    },
    include: {
      conversation: {
        include: {
          contact: true,
          channel: true,
          tags: { include: { tag: true } }
        }
      }
    }
  });

  if (!message || message.hiddenByReset || message.workspaceId !== input.workspaceId || message.direction !== "inbound") {
    return null;
  }

  return {
    message,
    conversation: message.conversation,
    eventKey: input.eventKey
  };
}

function runInput(context: ExecuteContext) {
  return {
    source: "evolution_webhook",
    trigger: "message.received",
    messageId: context.message.id,
    conversationId: context.conversation.id,
    contactId: context.conversation.contactId
  };
}

function sanitizeError(error: unknown) {
  if (error instanceof EvolutionClientError) {
    const details = collectStrings(error.responseBody)
      .map((value) => value.trim())
      .filter(Boolean)
      .slice(0, 3)
      .join(" ");

    return details
      ? `Evolution API request failed with status ${error.statusCode}: ${details}`
      : error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  return "Automation execution failed.";
}

async function recordAutomationRun(
  options: AutomationRunnerOptions,
  input: Pick<RunForInboundMessageInput, "workspaceId" | "eventKey">,
  context: ExecuteContext,
  rule: AutomationRuleRecord,
  status: string,
  result: unknown,
  recordedInput: unknown = runInput(context),
  execution?: AutomationExecution
) {
  const run = execution ? await execution.finish(status, result, recordedInput)
    : await fencedFlowOptions(options, context).prisma.automationRun.upsert({
    where: {
      workspaceId_ruleId_eventKey: {
        workspaceId: input.workspaceId,
        ruleId: rule.id,
        eventKey: input.eventKey
      }
    },
    create: {
      workspaceId: input.workspaceId,
      ruleId: rule.id,
      eventKey: input.eventKey,
      status,
      input: recordedInput,
      result
    },
    update: {
      status,
      input: recordedInput,
      result
    }
  });

  options.realtime?.publish({
    type: "automation_run.created",
    workspaceId: input.workspaceId,
    payload: {
      id: run.id,
      workspaceId: run.workspaceId,
      ruleId: run.ruleId,
      eventKey: run.eventKey,
      status: run.status,
      input: run.input,
      result: run.result,
      createdAt: run.createdAt instanceof Date ? run.createdAt.toISOString() : run.createdAt,
      updatedAt: run.updatedAt instanceof Date ? run.updatedAt.toISOString() : run.updatedAt
    }
  });

  return run;
}

export function createAutomationRunner(options: AutomationRunnerOptions) {
  const runner = {
    /** Recovery of inbound runs whose process died outside a durable ingress
     * handler. Per-node checkpoints still decide whether replay is safe. */
    async recoverDueRuns(input: { now?: Date; limit?: number } = {}): Promise<string[]> {
      if (!options.prisma.automationRun.findMany || !options.prisma.automationRun.updateMany) return [];
      const at = input.now ?? new Date();
      const rows = await options.prisma.automationRun.findMany({ where: { status: 'running',
        OR: [{ executionToken: { not: null }, leaseUntil: { lte: at } }, { executionToken: null, updatedAt: { lte: new Date(at.getTime() - 5 * 60_000) } }],
        input: { path: ['source'], equals: 'evolution_webhook' } }, orderBy: { createdAt: 'asc' }, take: input.limit ?? 20 });
      const recovered: string[] = [];
      for (const row of rows) {
        const payload = isRecord(row.input) ? row.input : {};
        if (typeof payload.messageId !== 'string') continue;
        try {
          const runs = await runner.runForInboundMessage({ workspaceId: row.workspaceId, messageId: payload.messageId,
            eventKey: row.eventKey, automationId: row.ruleId });
          if (!runs.length) await options.prisma.automationRun.updateMany({ where: { workspaceId: row.workspaceId,
            id: row.id, status: 'running', executionToken: row.executionToken, ...(row.executionToken ? { leaseUntil: { lte: at } } : { updatedAt: row.updatedAt }) },
            data: { status: 'skipped', executionToken: null, leaseUntil: null,
              result: { reason: 'source_reset_or_rule_disabled', previous: row.result } } });
          recovered.push(row.id);
        } catch (error) {
          if ((error as { code?: string }).code !== 'AUTOMATION_EXECUTION_BUSY') {
            options.onRecoveryError?.({ id: row.id, code: (error as { code?: string }).code ?? 'RECOVERY_FAILED' });
          }
        }
      }
      return recovered;
    },
    async runForInboundMessage(input: RunForInboundMessageInput) {
      const context = await loadContext(options, input);
      if (!context) {
        return [];
      }

      const rules = await options.prisma.automationRule.findMany({
        where: {
          workspaceId: input.workspaceId,
          ...(input.includeDisabled ? {} : { status: "enabled" as const }),
          trigger: "message.received",
          ...(input.automationId ? { id: input.automationId } : {})
        },
        orderBy: [{ createdAt: "asc" }]
      });
      const runs: AutomationRunRecord[] = [];

      for (const rule of rules) {
        if (!await sourceStillCurrent(options, context)) break;
        const flow = flowFromRule(rule);
        if (!flow) {
          continue;
        }

        const triggerNodes = flow.nodes.filter(
          (node) => getAutomationBlock(node.type)?.category === "trigger"
        );
        if (triggerNodes.some((node) => node.type === "trigger_webhook")) {
          // External webhook flows only start from their public URL.
          continue;
        }

        const claim = await claimAutomationExecution(options.prisma, { workspaceId: input.workspaceId,
          ruleId: rule.id, eventKey: input.eventKey, input: runInput(context), flow });
        if (!claim.claimed) { runs.push(claim.run); continue; }
        try {
        const frozenTriggers = claim.flow.nodes.filter(node => getAutomationBlock(node.type)?.category === 'trigger');
        const triggerNode = claim.firstNodeId ? frozenTriggers.find(node => node.id === claim.firstNodeId) : (
          await Promise.all(
            frozenTriggers.map(async (node) => ({
              node,
              matches: await triggerMatches(options, context, node)
            }))
          )
        ).find((candidate) => candidate.matches)?.node;

        if (!triggerNode) {
          const skippedTriggerNode = triggerNodes[0];
          if (!skippedTriggerNode) {
            continue;
          }

          const result = {
            mode: "real",
            runner: "graph",
            triggerNodeId: skippedTriggerNode.id,
            skippedReason: "trigger_not_matched",
            actionResults: [
              resultFor(skippedTriggerNode, "skipped", {
                message: "Trigger did not match this event."
              })
            ]
          };
          const run = await recordAutomationRun(options, input, context, rule, "skipped", result, runInput(context), claim);
          runs.push(run);
          continue;
        }

        const results = await executeFlow(options, context, claim.flow, triggerNode, claim);

        const result = {
          mode: "real",
          runner: "graph",
          triggerNodeId: triggerNode.id,
          actionResults: results
        };
        if (!await sourceStillCurrent(options, context)) break;
        const run = await recordAutomationRun(options, input, context, rule, runStatus(results), result, runInput(context), claim);
        runs.push(run);
        } finally { claim.close(); }
      }

      return runs;
    },

    async runForWebhookEvent(input: RunForWebhookEventInput) {
      const flow = flowFromRule(input.rule);
      const triggerNode = flow?.nodes.find((node) => node.type === "trigger_webhook");
      if (!flow || !triggerNode) {
        return null;
      }

      const loaded = await loadContext(options, {
        workspaceId: input.workspaceId,
        messageId: input.messageId,
        eventKey: input.eventKey
      });
      if (!loaded) {
        return null;
      }

      const context: ExecuteContext = {
        ...loaded,
        variables: input.variables,
        outboundBlockedReason: input.outboundBlockedReason ?? null
      };
      const claim = await claimAutomationExecution(options.prisma, { workspaceId: input.workspaceId,
        ruleId: input.rule.id, eventKey: input.eventKey, input: input.runInput ?? runInput(context), flow });
      if (!claim.claimed) return claim.run;
      try {
      const frozenTrigger = claim.flow.nodes.find(node => node.type === 'trigger_webhook');
      if (!frozenTrigger) throw new Error('Webhook trigger missing from durable flow.');
      const results = await executeFlow(options, context, claim.flow, frozenTrigger, claim);
      const outboundBlocked = Boolean(
        context.outboundBlockedReason &&
          results.some((result) => result.status === "skipped" && OUTBOUND_BLOCK_TYPES.has(result.type))
      );
      const status = runStatus(results) === "failed" ? "failed" : outboundBlocked ? "skipped" : "completed";
      const result = {
        mode: "real",
        runner: "graph",
        triggerNodeId: triggerNode.id,
        ...(outboundBlocked
          ? { skippedReason: "outbound_blocked", skippedMessage: context.outboundBlockedReason }
          : {}),
        actionResults: results
      };

      if (!await sourceStillCurrent(options, context)) return null;
      return recordAutomationRun(
        options,
        input,
        context,
        input.rule,
        status,
        result,
        {
          source: "automation_webhook",
          trigger: "webhook.received",
          messageId: context.message.id,
          conversationId: context.conversation.id,
          contactId: context.conversation.contactId,
          ...input.runInput
        },
        claim
      );
      } finally { claim.close(); }
    }
  };
  return runner;
}
