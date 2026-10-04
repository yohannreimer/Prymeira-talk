// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SupervisionPage, responseLabel, sellerLabel, waitLabel, waitTone } from "./SupervisionPage";
import { apiSupervisionConversations, apiSupervisionSummary } from "../../app/supervision-api";

vi.mock("../../app/auth", () => ({ useTalkAuth: () => ({ getToken: async () => "t" }) }));
vi.mock("../../app/supervision-api", async importOriginal => ({ ...await importOriginal<typeof import("../../app/supervision-api")>(),
  apiSupervisionConversations: vi.fn(), apiSupervisionSummary: vi.fn(), apiSupervisionThread: vi.fn(), apiSupervisionMedia: vi.fn(), apiSupervisionPreview: vi.fn() }));
vi.mock("../../app/api", () => ({ apiGetAudioTranscription: vi.fn(), apiGetInboxMedia: vi.fn(), apiGetPdfPreview: vi.fn(), apiGetVideoPoster: vi.fn() }));

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
describe("supervision for a manager", () => {
  it("reads waits, response times and seller names like a person would", () => {
    const now = Date.now();
    const minutesAgo = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
    expect(waitLabel(minutesAgo(0.2), now)).toBe("agora"); expect(waitLabel(minutesAgo(12), now)).toBe("12 min");
    expect(waitLabel(minutesAgo(92), now)).toBe("1h32"); expect(waitLabel(minutesAgo(3000), now)).toBe("2 dias");
    expect([waitTone(minutesAgo(5), now), waitTone(minutesAgo(30), now), waitTone(minutesAgo(90), now)]).toEqual(["ok", "warning", "late"]);
    expect(responseLabel(42)).toBe("42 s"); expect(responseLabel(600)).toBe("10 min"); expect(responseLabel(null)).toBeNull();
    expect(sellerLabel({ sellerName: "vendas5@villefer.com.br", sellerEmail: "vendas5@villefer.com.br" })).toBe("vendas5");
    expect(sellerLabel({ sellerName: "Junior", sellerEmail: "vendas5@villefer.com.br" })).toBe("Junior");
  });
  let root: ReturnType<typeof createRoot> | null = null; let container: HTMLDivElement | null = null;
  afterEach(async () => { await act(async () => root?.unmount()); container?.remove(); vi.resetAllMocks(); });
  it("opens on the customers waiting for an answer, with the team pulse, late sellers and the next action to take", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.mocked(apiSupervisionSummary).mockResolvedValue({ sellers: [
      { sellerCustomerId: "00000000-0000-4000-8000-000000000001", sellerName: "vendas5@villefer.com.br", sellerEmail: "vendas5@villefer.com.br", nextActionCount: 6, unreadConversationCount: 0,
        waitingCount: 2, oldestWaitingSince: minutesAgo(95), today: { received: 40, sent: 31, conversations: 12, medianResponseSeconds: 480 } },
      { sellerCustomerId: "00000000-0000-4000-8000-000000000002", sellerName: "Diogo", sellerEmail: "vendas6@villefer.com.br", nextActionCount: 0, unreadConversationCount: 1,
        waitingCount: 0, oldestWaitingSince: null, today: { received: 5, sent: 6, conversations: 3, medianResponseSeconds: 120 } }] });
    vi.mocked(apiSupervisionConversations).mockResolvedValue({ nextCursor: null, conversations: [{ id: "c1", workspaceId: "w", channelId: "ch", contactId: "ct", contactName: "Jackson Cappelli",
      contactPhone: "+5547999990000", status: "open", assignedUserId: null, departmentId: null, lastMessageAt: minutesAgo(95), lastMessagePreview: "Preciso de 20 chapas xadrez",
      unreadCount: 0, priority: "normal", sellerCustomerId: "00000000-0000-4000-8000-000000000001", sellerName: "vendas5@villefer.com.br", sellerEmail: "vendas5@villefer.com.br",
      channelPhoneNumber: null, waitingSince: minutesAgo(95), nextActionText: "Confirme o estoque de chapa xadrez 3 mm e envie o orçamento" }] });
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    await act(async () => root!.render(<SupervisionPage />));
    expect(apiSupervisionConversations).toHaveBeenCalledWith(expect.objectContaining({ waiting: true, nextAction: false }), expect.any(Function), expect.any(AbortSignal));
    expect(container.querySelector('[aria-label="Esperando resposta de todos: 2"]')?.textContent).toContain("1h35");
    expect(container.textContent).toContain("Clientes esperando resposta");
    expect(container.querySelector(".supervision-seller.is-late")?.textContent).toContain("Atrasado");
    expect(container.querySelector(".supervision-seller.is-ok")?.textContent).toContain("Em dia");
    expect(container.textContent).toContain("vendas5"); expect(container.textContent).not.toContain("WhatsApp sem número");
    expect(container.querySelector(".supervision-conversation .supervision-wait.is-late")?.textContent).toContain("esperando há 1h35");
    expect(container.querySelector(".supervision-next-action")?.textContent).toContain("Confirme o estoque de chapa xadrez");
    expect(container.textContent).toContain("1ª resposta em ~");
  });
});
