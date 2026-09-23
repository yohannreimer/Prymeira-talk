import { describe, expect, it } from "vitest";
import {
  audioMessageDisplayText,
  attachmentReadNotice,
  aiControlActionLabel,
  aiControlLabel,
  applyComposerMarker,
  canResetConversation,
  filterConversationsNeedingHuman,
  insertComposerText,
  isBrowserPlayableAudio,
  metaClosedWindowMessage,
  metaServiceWindowSendError,
  messageDisplayText,
  messageMediaFallbackLabel,
  messageMediaKind,
  messageMediaLabel,
  needsHumanAttention,
  outboundStatusLabel,
  sortConversationsByRecency,
  upsertConversation
} from "./InboxPage";
import { quickReplyMatchesQuery, quickReplyMutationErrorMessage } from "./QuickRepliesPopover";
import type { ConversationDto } from "@prymeira-talk/shared";

describe("messageDisplayText", () => {
  it("uses message body when present", () => {
    expect(messageDisplayText({ body: "Oi", type: "image" })).toBe("Oi");
  });

  it("uses media labels when the message has no text body", () => {
    expect(messageDisplayText({ body: null, type: "image" })).toBe("Imagem recebida");
    expect(messageDisplayText({ body: null, type: "audio" })).toBe("Áudio recebido");
    expect(messageDisplayText({ body: null, type: "file" })).toBe("Arquivo recebido");
  });
});

describe("AI control helpers", () => {
  it("labels AI control states", () => {
    expect(aiControlLabel({ aiControlStatus: "human_controlled", activeAgentName: null })).toBe("Humano no controle");
    expect(aiControlLabel({ aiControlStatus: "agent_allowed", activeAgentName: "Secretaria IA" })).toBe("IA ativa: Secretaria IA");
    expect(aiControlLabel({ aiControlStatus: "agent_allowed", activeAgentName: null })).toBe("IA liberada");
  });

  it("chooses the correct AI control action label", () => {
    expect(aiControlActionLabel({ aiControlStatus: "human_controlled" })).toBe("Liberar IA");
    expect(aiControlActionLabel({ aiControlStatus: "agent_allowed" })).toBe("Assumir");
  });

  it("detects conversations that need human attention", () => {
    expect(
      needsHumanAttention({
        aiControlStatus: "human_controlled",
        activeAgentSessionStatus: "handoff_requested",
        handoffReason: "Baixa confiança"
      })
    ).toBe(true);
    expect(
      needsHumanAttention({
        aiControlStatus: "human_controlled",
        activeAgentSessionStatus: null,
        handoffReason: "Cliente pediu atendimento humano"
      })
    ).toBe(true);
    expect(
      needsHumanAttention({
        aiControlStatus: "agent_allowed",
        activeAgentSessionStatus: "active",
        handoffReason: null
      })
    ).toBe(false);
    expect(needsHumanAttention({
      aiControlStatus: "human_controlled", activeAgentSessionStatus: "handoff_requested",
      handoffReason: "Confirmar pedido", handoffActionCompletedAt: "2026-09-23T12:00:00.000Z"
    })).toBe(false);
  });
});

describe("human attention view", () => {
  const conversation = (id: string, overrides: Partial<ConversationDto>): ConversationDto => ({
    id,
    workspaceId: "workspace-1",
    channelId: "channel-1",
    contactId: `contact-${id}`,
    status: "open",
    assignedUserId: null,
    departmentId: null,
    lastMessageAt: null,
    lastMessagePreview: null,
    unreadCount: 0,
    priority: "normal",
    ...overrides
  });

  it("shows only active conversations marked for human action", () => {
    const handoff = conversation("handoff", {
      activeAgentSessionStatus: "handoff_requested",
      aiControlStatus: "human_controlled",
      handoffReason: "Confirmar pedido"
    });
    const human = conversation("human", {
      aiControlStatus: "human_controlled",
      handoffReason: "Cliente pediu ajuda"
    });
    const agent = conversation("agent", {
      aiControlStatus: "agent_allowed",
      activeAgentSessionStatus: "active"
    });
    const completed = conversation("completed", {
      activeAgentSessionStatus: "handoff_requested", aiControlStatus: "human_controlled",
      handoffReason: "Confirmar pedido", handoffActionCompletedAt: "2026-09-23T12:00:00.000Z"
    });
    const closed = conversation("closed", {
      status: "closed",
      aiControlStatus: "human_controlled",
      handoffReason: "Pedido encerrado"
    });
    const all = [handoff, human, agent, completed, closed];

    expect(filterConversationsNeedingHuman(all, false)).toBe(all);
    expect(filterConversationsNeedingHuman(all, true).map(({ id }) => id)).toEqual(["handoff", "human"]);
  });
});

describe("temporary conversation reset", () => {
  it("is visible only to workspace owners", () => {
    expect(canResetConversation("owner")).toBe(true);
    expect(canResetConversation("manager")).toBe(false);
    expect(canResetConversation("agent")).toBe(false);
  });
});

describe("messageMediaLabel", () => {
  it("names media actions by message type", () => {
    expect(messageMediaLabel({ mediaUrl: "https://cdn.test/a.jpg", type: "image" })).toBe("Abrir imagem");
    expect(messageMediaLabel({ mediaUrl: "https://cdn.test/a.ogg", type: "audio" })).toBe("Reproduzir áudio");
    expect(messageMediaLabel({ mediaUrl: "https://cdn.test/a.pdf", type: "file" })).toBe("Baixar arquivo");
    expect(messageMediaLabel({ mediaUrl: "https://cdn.test/a.mp4", type: "file" })).toBe("Baixar vídeo");
    expect(messageMediaLabel({ mediaUrl: "data:video/mp4;base64,dmZk", type: "file" })).toBe("Baixar vídeo");
  });
});

describe("messageMediaFallbackLabel", () => {
  it("names the fallback action for media previews", () => {
    expect(messageMediaFallbackLabel({ mediaUrl: "https://cdn.test/a.ogg", type: "audio" })).toBe("Abrir áudio");
    expect(messageMediaFallbackLabel({ mediaUrl: "https://cdn.test/a.jpg", type: "image" })).toBe("Abrir imagem");
    expect(messageMediaFallbackLabel({ mediaUrl: "https://cdn.test/a.pdf", type: "file" })).toBe("Baixar arquivo");
  });
});

describe("messageMediaKind", () => {
  it("classifies media that can render inline", () => {
    expect(messageMediaKind({ mediaUrl: "https://cdn.test/a.webp", type: "image" })).toBe("image");
    expect(messageMediaKind({ mediaUrl: "https://cdn.test/a.ogg", type: "audio" })).toBe("audio");
    expect(messageMediaKind({ mediaUrl: "https://cdn.test/a.mp4", type: "file" })).toBe("file");
    expect(messageMediaKind({ mediaUrl: "data:video/mp4;base64,dmZk", type: "file" })).toBe("file");
    expect(messageMediaKind({ mediaUrl: "https://cdn.test/a.pdf", type: "file" })).toBe("file");
    expect(messageMediaKind({ mediaUrl: null, type: "image" })).toBeNull();
  });
});

describe("audio message presentation", () => {
  it('keeps unread warnings local to the attachment without a false processing label', () => {
    expect(attachmentReadNotice({ type: 'file', attachmentReadStatus: 'unread' })).toBe('Anexo não lido pela IA.');
    expect(attachmentReadNotice({ type: 'file' })).toBeNull();
    expect(audioMessageDisplayText({ type: 'audio', body: 'Áudio recebido', attachmentReadStatus: 'unread' })).toEqual({ kind: 'error', text: 'Áudio não lido pela IA.' });
  });
  it("does not mount Safari's native player for inline OGG/Opus data", () => {
    expect(isBrowserPlayableAudio({
      type: "audio",
      mediaUrl: "data:audio/ogg;base64,YQ=="
    })).toBe(false);
    expect(isBrowserPlayableAudio({
      type: "audio",
      mediaUrl: "data:audio/opus;base64,YQ=="
    })).toBe(false);
    expect(isBrowserPlayableAudio({
      type: "audio",
      mediaUrl: "data:audio/mpeg;base64,YQ=="
    })).toBe(true);
  });

  it("labels processing, transcript, and failure states", () => {
    expect(audioMessageDisplayText({ type: "audio", body: "Áudio recebido" })).toEqual({
      kind: "processing",
      text: "Processando áudio..."
    });
    expect(audioMessageDisplayText({ type: "audio", body: "Preciso de 42 chapas." })).toEqual({
      kind: "transcript",
      text: "Texto do áudio: Preciso de 42 chapas."
    });
    expect(audioMessageDisplayText({
      type: "audio",
      body: "Não foi possível transcrever este áudio."
    })).toEqual({
      kind: "error",
      text: "Não foi possível transcrever este áudio."
    });
  });
});

describe("composer formatting helpers", () => {
  it("wraps only the selected text with the requested WhatsApp marker", () => {
    expect(applyComposerMarker("oi tudo bem", 3, 7, "*")).toEqual({
      value: "oi *tudo* bem",
      selectionStart: 4,
      selectionEnd: 8
    });
  });

  it("inserts paired markers around the cursor when nothing is selected", () => {
    expect(applyComposerMarker("oi bem", 3, 3, "_")).toEqual({
      value: "oi __bem",
      selectionStart: 4,
      selectionEnd: 4
    });
  });

  it("inserts emoji at the current selection", () => {
    expect(insertComposerText("oi mundo", 3, 8, "😊")).toEqual({
      value: "oi 😊",
      selectionStart: 5,
      selectionEnd: 5
    });
  });
});

describe("outboundStatusLabel", () => {
  const outboundMessage = {
    id: "msg_1",
    direction: "outbound",
    status: "pending"
  } as const;

  it("shows sending only for optimistic pending messages", () => {
    expect(outboundStatusLabel(outboundMessage)).toBeNull();
    expect(outboundStatusLabel({ ...outboundMessage, id: "optimistic-1" })).toBe("Enviando...");
  });

  it("shows failed outbound messages", () => {
    expect(outboundStatusLabel({ ...outboundMessage, status: "failed" })).toBe("Falhou");
  });
});

describe("metaServiceWindowSendError", () => {
  const conversation = {
    id: "conv_1",
    workspaceId: "workspace_1",
    channelId: "channel_1",
    contactId: "contact_1",
    status: "open",
    assignedUserId: null,
    departmentId: null,
    lastMessageAt: null,
    lastMessagePreview: null,
    unreadCount: 0,
    priority: "normal",
    channelProvider: "meta_cloud",
    customerServiceWindowExpiresAt: null,
    metaServiceWindowOpen: false
  } as const;

  it("blocks Meta Cloud sends when the service window is closed", () => {
    expect(metaServiceWindowSendError(conversation)).toBe(metaClosedWindowMessage);
  });

  it("does not block Evolution sends", () => {
    expect(
      metaServiceWindowSendError({
        ...conversation,
        channelProvider: "evolution",
        metaServiceWindowOpen: false
      })
    ).toBeNull();
  });
});

describe("quick reply helpers", () => {
  it("matches quick replies by title, body, or category", () => {
    const reply = {
      id: "reply-1",
      workspaceId: "workspace-1",
      title: "Boas-vindas",
      body: "Olá, seja bem-vindo",
      category: "Atendimento",
      createdAt: "2026-05-24T12:00:00.000Z",
      updatedAt: "2026-05-24T12:00:00.000Z"
    };

    expect(quickReplyMatchesQuery(reply, "boas")).toBe(true);
    expect(quickReplyMatchesQuery(reply, "bem-vindo")).toBe(true);
    expect(quickReplyMatchesQuery(reply, "atendimento")).toBe(true);
    expect(quickReplyMatchesQuery(reply, "financeiro")).toBe(false);
  });

  it("uses mutation error messages when available", () => {
    expect(quickReplyMutationErrorMessage(new Error("Falha da API"), "Fallback")).toBe("Falha da API");
    expect(quickReplyMutationErrorMessage("erro", "Fallback")).toBe("Fallback");
  });
});

describe("conversation queue ordering", () => {
  function conversationFixture(overrides: Partial<ConversationDto> & { id: string }): ConversationDto {
    return {
      workspaceId: "workspace-1",
      channelId: "channel-1",
      contactId: `contact-${overrides.id}`,
      contactName: "Contato",
      status: "open",
      assignedUserId: null,
      departmentId: null,
      lastMessageAt: "2026-09-20T12:00:00.000Z",
      lastMessagePreview: null,
      unreadCount: 0,
      priority: "normal",
      ...overrides
    };
  }

  it("orders the queue by the latest activity", () => {
    const older = conversationFixture({ id: "older", lastMessageAt: "2026-09-20T10:00:00.000Z" });
    const newer = conversationFixture({ id: "newer", lastMessageAt: "2026-09-20T11:00:00.000Z" });

    expect(sortConversationsByRecency([older, newer]).map((item) => item.id)).toEqual([
      "newer",
      "older"
    ]);
  });

  it("does not move an opened older conversation to the top", () => {
    const older = conversationFixture({ id: "older", lastMessageAt: "2026-09-20T10:00:00.000Z" });
    const newer = conversationFixture({ id: "newer", lastMessageAt: "2026-09-20T11:00:00.000Z" });

    const markedRead = { ...older, unreadCount: 0 };
    expect(upsertConversation([newer, older], markedRead).map((item) => item.id)).toEqual([
      "newer",
      "older"
    ]);
  });

  it("moves a conversation up only when it receives newer activity", () => {
    const older = conversationFixture({ id: "older", lastMessageAt: "2026-09-20T10:00:00.000Z" });
    const newer = conversationFixture({ id: "newer", lastMessageAt: "2026-09-20T11:00:00.000Z" });

    const withNewMessage = { ...older, lastMessageAt: "2026-09-20T13:00:00.000Z" };
    expect(upsertConversation([newer, older], withNewMessage).map((item) => item.id)).toEqual([
      "older",
      "newer"
    ]);
  });
});
