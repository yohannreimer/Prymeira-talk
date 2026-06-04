import {
  automationFlowSchema,
  getAutomationBlock,
  type AutomationEdgeDefinition,
  type AutomationFlowDefinition,
  type AutomationNodeDefinition
} from "@prymeira-talk/shared";
import { EvolutionClientError } from "../evolution/evolution.client.js";
import type { EvolutionRuntime } from "../evolution/evolution-runtime.js";

type DateLike = Date | string;

interface AutomationRuleRecord {
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

interface AutomationRunRecord {
  id: string;
  workspaceId: string;
  ruleId: string;
  eventKey: string;
  status: string;
  input: unknown;
  result: unknown;
  createdAt: DateLike;
  updatedAt: DateLike;
}

interface MessageRecord {
  id: string;
  workspaceId: string;
  conversationId: string;
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
        workspaceId: string;
        ruleId: string;
        eventKey: string;
        status: string;
        input: unknown;
        result: unknown;
      };
      update: {
        status: string;
        input: unknown;
        result: unknown;
      };
    }): Promise<AutomationRunRecord>;
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
  client?: Pick<NonNullable<EvolutionRuntime["client"]>, "sendText" | "sendMedia"> | null;
}

export interface AutomationRunnerOptions {
  prisma: AutomationRunnerPrisma;
  evolution?: AutomationRunnerEvolution;
  realtime?: AutomationRunnerRealtime;
}

export interface RunForInboundMessageInput {
  workspaceId: string;
  messageId: string;
  eventKey: string;
  automationId?: string;
  includeDisabled?: boolean;
}

interface ActionResult {
  nodeId: string;
  type: string;
  label: string;
  status: "completed" | "failed" | "skipped";
  branch?: string;
  mode?: "real";
  message?: string;
  error?: string;
}

interface ExecuteContext {
  message: MessageRecord;
  conversation: ConversationRecord;
  eventKey: string;
}

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
  branch?: string
) {
  const edges = flow.edges.filter((edge) => edge.source === node.id);

  if (!branch) {
    return (
      edges.filter((edge) => !edge.sourceHandle || edge.sourceHandle === "success")[0] ??
      edges[0] ??
      null
    );
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

function textContains(haystack: string, needle: string) {
  return haystack.toLocaleLowerCase("pt-BR").includes(needle.toLocaleLowerCase("pt-BR"));
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
): Promise<{ result: ActionResult; branch?: string; stop?: boolean }> {
  if (getAutomationBlock(node.type)?.category === "trigger") {
    return { result: resultFor(node, "completed") };
  }

  if (node.type === "send_message" || node.type === "ask_open_reply" || node.type === "send_quick_reply") {
    const text = configValue(node, ["message", "body", "text"]);
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
    const caption = configValue(node, ["caption", "message", "body"]) ?? undefined;

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
    await options.prisma.conversationTag.create({
      data: {
        workspaceId: context.message.workspaceId,
        conversationId: context.conversation.id,
        tagId: tag.id
      }
    }).catch(() => undefined);
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

    await options.prisma.conversation.update({
      where: { workspaceId_id: { workspaceId: context.message.workspaceId, id: context.conversation.id } },
      data: { assignedUserId: userId }
    });
    return { result: resultFor(node, "completed") };
  }

  if (node.type === "change_priority") {
    const priority = configValue(node, ["priority"]) ?? "normal";
    await options.prisma.conversation.update({
      where: { workspaceId_id: { workspaceId: context.message.workspaceId, id: context.conversation.id } },
      data: { priority }
    });
    return { result: resultFor(node, "completed") };
  }

  if (node.type === "create_internal_note") {
    const body = configValue(node, ["note", "body", "message"]);
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
    await options.prisma.conversation.update({
      where: { workspaceId_id: { workspaceId: context.message.workspaceId, id: context.conversation.id } },
      data: { status: "closed" }
    });
    return { result: resultFor(node, "completed") };
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
  if (node.type === "trigger_first_message") {
    const previousInboundCount = await options.prisma.message.count({
      where: {
        workspaceId: context.message.workspaceId,
        conversationId: context.message.conversationId,
        direction: "inbound",
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
    const keywords = configValues(node, ["keywords", "keyword", "text"]);
    const text = messageText(context);
    return keywords.some((keyword) => textContains(text, keyword));
  }

  return false;
}

async function executeFlow(
  options: AutomationRunnerOptions,
  context: ExecuteContext,
  flow: AutomationFlowDefinition,
  triggerNode: AutomationNodeDefinition
) {
  const results: ActionResult[] = [];
  let current: AutomationNodeDefinition | null = triggerNode;
  let steps = 0;

  while (current && steps < MAX_GRAPH_STEPS) {
    steps += 1;

    let execution: Awaited<ReturnType<typeof executeNode>>;
    try {
      execution = await executeNode(options, context, current);
    } catch (error) {
      results.push(resultFor(current, "failed", { error: sanitizeError(error) }));
      break;
    }

    results.push(execution.result);

    if (execution.result.status === "failed" || execution.stop) {
      break;
    }

    current = findTarget(flow, outgoingEdges(flow, current, execution.branch));
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

  if (!message || message.workspaceId !== input.workspaceId || message.direction !== "inbound") {
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
  input: RunForInboundMessageInput,
  context: ExecuteContext,
  rule: AutomationRuleRecord,
  status: string,
  result: unknown
) {
  const run = await options.prisma.automationRun.upsert({
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
      input: runInput(context),
      result
    },
    update: {
      status,
      input: runInput(context),
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
  return {
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
        const flow = flowFromRule(rule);
        if (!flow) {
          continue;
        }

        const triggerNodes = flow.nodes.filter(
          (node) => getAutomationBlock(node.type)?.category === "trigger"
        );
        const triggerNode = (
          await Promise.all(
            triggerNodes.map(async (node) => ({
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
          const run = await recordAutomationRun(options, input, context, rule, "skipped", result);
          runs.push(run);
          continue;
        }

        const results = await executeFlow(options, context, flow, triggerNode);

        const result = {
          mode: "real",
          runner: "graph",
          triggerNodeId: triggerNode.id,
          actionResults: results
        };
        const run = await recordAutomationRun(options, input, context, rule, runStatus(results), result);
        runs.push(run);
      }

      return runs;
    }
  };
}
