import type { Prisma, PrismaClient } from "@prisma/client";

type DateLike = Date | string;
type AssistantActionType = "summary" | "suggested_reply";

interface AiActionRecord {
  id: string;
  workspaceId: string;
  conversationId: string | null;
  contactId: string | null;
  userId: string | null;
  actionType: string;
  mode: "simulated" | "real";
  input: Prisma.JsonValue;
  result: Prisma.JsonValue;
  status: string;
  createdAt: DateLike;
}

type AiActionCreateArgs = Parameters<PrismaClient["aiActionLog"]["create"]>[0];
type AiActionFindManyArgs = Parameters<PrismaClient["aiActionLog"]["findMany"]>[0];

export interface PrismaLike {
  aiActionLog: {
    create(args: AiActionCreateArgs): Promise<AiActionRecord>;
    findMany(args: AiActionFindManyArgs): Promise<AiActionRecord[]>;
  };
}

export interface AssistantActionDto {
  id: string;
  workspaceId: string;
  conversationId: string | null;
  contactId: string | null;
  userId: string | null;
  actionType: string;
  mode: "simulated" | "real";
  input: Prisma.JsonValue;
  result: Prisma.JsonValue;
  status: string;
  createdAt: string;
}

function toIsoString(value: DateLike) {
  return value instanceof Date ? value.toISOString() : value;
}

function toActionDto(record: AiActionRecord): AssistantActionDto {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    conversationId: record.conversationId,
    contactId: record.contactId,
    userId: record.userId,
    actionType: record.actionType,
    mode: record.mode,
    input: record.input,
    result: record.result,
    status: record.status,
    createdAt: toIsoString(record.createdAt)
  };
}

function readPrompt(input: unknown) {
  if (typeof input !== "object" || input === null) {
    return "";
  }

  const payload = input as Record<string, unknown>;
  return String(payload.transcript ?? payload.lastMessage ?? payload.prompt ?? "").trim();
}

function buildResult(actionType: AssistantActionType, input: unknown) {
  const prompt = readPrompt(input);

  if (actionType === "summary") {
    return {
      mode: "simulated",
      summary: prompt
        ? `Resumo simulado: ${prompt.slice(0, 180)}`
        : "Resumo simulado gerado para a conversa selecionada."
    };
  }

  return {
    mode: "simulated",
    suggestedReply: prompt
      ? `Resposta sugerida simulada: obrigado pelo contexto. Podemos seguir com ${prompt.slice(0, 120)}.`
      : "Resposta sugerida simulada: obrigado pelo contato, vou verificar e retorno em instantes."
  };
}

export function createAssistantService(prisma: PrismaLike) {
  return {
    async createAction(input: {
      workspaceId: string;
      actionType: AssistantActionType;
      conversationId?: string | null;
      contactId?: string | null;
      input?: Prisma.InputJsonValue;
    }): Promise<AssistantActionDto> {
      const actionInput = input.input ?? {};
      const action = await prisma.aiActionLog.create({
        data: {
          workspaceId: input.workspaceId,
          conversationId: input.conversationId ?? null,
          contactId: input.contactId ?? null,
          userId: null,
          actionType: input.actionType,
          mode: "simulated",
          input: actionInput,
          result: buildResult(input.actionType, actionInput),
          status: "completed"
        }
      });

      return toActionDto(action);
    },

    async listActions(input: { workspaceId: string }): Promise<AssistantActionDto[]> {
      const actions = await prisma.aiActionLog.findMany({
        where: { workspaceId: input.workspaceId },
        orderBy: [{ createdAt: "desc" }],
        take: 50
      });

      return actions.map(toActionDto);
    }
  };
}
