import { describe, expect, it } from "vitest";
import {
  aiControlActionLabel,
  aiControlLabel,
  applyComposerMarker,
  insertComposerText,
  metaClosedWindowMessage,
  metaServiceWindowSendError,
  messageDisplayText,
  messageMediaKind,
  messageMediaLabel,
  outboundStatusLabel
} from "./InboxPage";
import { quickReplyMatchesQuery, quickReplyMutationErrorMessage } from "./QuickRepliesPopover";

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
