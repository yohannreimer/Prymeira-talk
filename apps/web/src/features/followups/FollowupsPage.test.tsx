// @vitest-environment jsdom
import type { ConversationDto, ConversationFollowupDto, RealtimeEvent } from "@prymeira-talk/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getToken: vi.fn(async () => "token"),
  list: vi.fn(),
  getConversations: vi.fn(),
  send: vi.fn(),
  postpone: vi.fn(),
  cancel: vi.fn(),
  noFollowup: vi.fn(),
  realtimeHandler: null as ((event: RealtimeEvent) => void) | null
}));

vi.mock("../../app/auth", () => ({
  useTalkAuth: () => ({ getToken: mocks.getToken })
}));

vi.mock("../../app/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../app/api")>();
  return {
    ...original,
    apiListFollowups: mocks.list,
    apiGetConversations: mocks.getConversations,
    apiSendFollowup: mocks.send,
    apiPostponeFollowup: mocks.postpone,
    apiCancelFollowup: mocks.cancel,
    apiMarkFollowupNoFollowup: mocks.noFollowup
  };
});
vi.mock("../inbox/useRealtimeEvents", () => ({
  useRealtimeEvents: (input: { onEvent: (event: RealtimeEvent) => void }) => {
    mocks.realtimeHandler = input.onEvent;
  }
}));

import { FollowupStaleError } from "../../app/api";
import { talkModules } from "../shell/moduleRegistry";
import { FollowupsPage } from "./FollowupsPage";

const review: ConversationFollowupDto = {
  id: "followup-1",
  workspaceId: "workspace-1",
  conversationId: "conversation-1",
  agentId: "agent-1",
  kind: "human_commercial",
  status: "review",
  stepIndex: 1,
  scheduledAt: "2026-09-22T15:00:00.000Z",
  draftBody: "Oi, Ana! Conseguiu avaliar a proposta?",
  contact: { name: "Ana Souza", phone: "+55 47 99999-1010" },
  channel: { displayName: "Villefer Geral" },
  anchorMessage: {
    id: "message-anchor-1",
    body: "Vou verificar a proposta e retorno.",
    type: "text",
    createdAt: "2026-09-22T11:55:00.000Z"
  },
  purpose: "proposal_checkin",
  reasonCode: "jev_human_review",
  createdAt: "2026-09-22T12:00:00.000Z",
  updatedAt: "2026-09-22T14:00:00.000Z"
};

const scheduled: ConversationFollowupDto = {
  ...review,
  id: "followup-2",
  status: "scheduled",
  kind: "qualification",
  draftBody: null,
  purpose: "missing_qualification",
  reasonCode: null,
  updatedAt: "2026-09-22T14:30:00.000Z"
};

const cancelled: ConversationFollowupDto = {
  ...review,
  status: "cancelled",
  reason: "customer_replied",
  cancelledAt: "2026-09-22T14:45:00.000Z",
  cancelledByUserId: null,
  reasonCode: null,
  updatedAt: "2026-09-22T14:45:00.000Z"
};

const conversation: ConversationDto = {
  id: "conversation-1",
  workspaceId: "workspace-1",
  channelId: "channel-1",
  contactId: "contact-1",
  contactName: "Ana Souza",
  contactPhone: "+55 47 99999-1010",
  channelName: "Villefer Geral",
  status: "open",
  assignedUserId: null,
  departmentId: null,
  lastMessageAt: "2026-09-22T12:00:00.000Z",
  lastMessagePreview: "Mensagem atual que não é a âncora",
  unreadCount: 0,
  priority: "normal"
};

function buttonByText(container: HTMLElement, text: string) {
  return Array.from(container.querySelectorAll("button")).find((button) =>
    button.textContent?.includes(text)
  ) ?? null;
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("FollowupsPage", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.list.mockReset().mockImplementation(async (_getToken, status: string) => {
      if (status === "review") return [review];
      if (status === "scheduled") return [scheduled];
      return [];
    });
    mocks.getConversations.mockReset().mockResolvedValue([conversation]);
    mocks.send.mockReset();
    mocks.postpone.mockReset();
    mocks.cancel.mockReset();
    mocks.noFollowup.mockReset();
    mocks.realtimeHandler = null;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function renderPage() {
    await act(async () => root.render(<FollowupsPage />));
    await settle();
  }

  it("starts on review and switches between queue filters", async () => {
    await renderPage();

    expect(mocks.list).toHaveBeenCalledWith(mocks.getToken, "review");
    expect(container.textContent).toContain("Ana Souza");
    expect(container.textContent).toContain("Villefer Geral");
    expect(container.textContent).toContain("Vou verificar a proposta e retorno.");
    expect(container.textContent).toContain("Retomar proposta enviada");
    expect(container.textContent).toContain("A análise indicou revisão humana");
    expect(container.textContent).toContain("Etapa 1 de 3");
    expect(mocks.getConversations).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Para revisar");
    expect(buttonByText(container, "Para revisar")?.getAttribute("aria-pressed")).toBe("true");

    await act(async () => buttonByText(container, "Agendados")?.click());
    await settle();

    expect(mocks.list).toHaveBeenCalledWith(mocks.getToken, "scheduled");
    expect(container.textContent).toContain("Completar dados da qualificação");
    expect(buttonByText(container, "Agendados")?.getAttribute("aria-pressed")).toBe("true");
  });

  it("edits the draft inline and sends body with the expected version", async () => {
    const sent: ConversationFollowupDto = {
      ...review,
      status: "sent",
      finalBody: "Oi, Ana! Posso ajudar com a proposta?",
      sentAt: "2026-09-22T15:05:00.000Z",
      sentByUserId: "user-1",
      updatedAt: "2026-09-22T15:05:00.000Z"
    };
    mocks.send.mockResolvedValue(sent);
    await renderPage();

    await act(async () => buttonByText(container, "Editar e enviar")?.click());
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    expect(textarea).not.toBeNull();

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(textarea, sent.finalBody);
      textarea?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => buttonByText(container, "Confirmar envio")?.click());
    await settle();

    expect(mocks.send).toHaveBeenCalledWith(mocks.getToken, review.id, {
      body: sent.finalBody,
      expectedUpdatedAt: review.updatedAt
    });
    expect(container.textContent).toContain("Follow-up enviado.");
    expect(container.textContent).not.toContain("Ana Souza");
  });

  it("cancels a review with optimistic concurrency", async () => {
    mocks.cancel.mockResolvedValue(cancelled);
    await renderPage();

    await act(async () => buttonByText(container, "Cancelar")?.click());
    await settle();

    expect(mocks.cancel).toHaveBeenCalledWith(mocks.getToken, review.id, {
      reason: "manual_cancelled",
      expectedUpdatedAt: review.updatedAt
    });
    expect(container.textContent).toContain("Acompanhamento cancelado.");
  });

  it("removes a stale card and explains that the context changed without retrying", async () => {
    mocks.send.mockRejectedValue(new FollowupStaleError(cancelled));
    await renderPage();

    await act(async () => buttonByText(container, "Enviar")?.click());
    await settle();

    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("O contexto mudou");
    expect(container.textContent).toContain("nenhuma mensagem foi reenviada");
    expect(container.textContent).not.toContain("Ana Souza");
  });

  it("reloads the active queue after relevant realtime activity", async () => {
    await renderPage();
    const callsBeforeEvent = mocks.list.mock.calls.length;
    expect(mocks.realtimeHandler).not.toBeNull();

    await act(async () => {
      mocks.realtimeHandler?.({
        type: "conversation.updated",
        workspaceId: conversation.workspaceId,
        payload: conversation
      });
      await new Promise((resolve) => setTimeout(resolve, 120));
    });
    await settle();

    expect(mocks.list.mock.calls.length).toBeGreaterThan(callsBeforeEvent);
    expect(mocks.getConversations).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Vou verificar a proposta e retorno.");
    expect(container.textContent).not.toContain("Mensagem atual que não é a âncora");
  });

  it("registers Follow-ups immediately after Atendimento", () => {
    expect(talkModules.slice(0, 2).map((module) => [module.key, module.label])).toEqual([
      ["atendimento", "Atendimento"],
      ["followups", "Follow-ups"]
    ]);
  });
});
