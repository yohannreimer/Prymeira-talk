// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupervisionConversation, SupervisionPage as QueuePage, SupervisionSummary, SupervisionThread, MessageDto } from "@prymeira-talk/shared";
import { SupervisionPage } from "./SupervisionPage";
import { apiSupervisionConversations, apiSupervisionSummary, apiSupervisionThread, apiSupervisionMedia, apiSupervisionReply, SupervisionApiError } from "../../app/supervision-api";
import { apiGetAudioTranscription, apiGetInboxMedia } from "../../app/api";

const getToken = vi.hoisted(() => vi.fn(async () => "supervisor-token"));
vi.mock("../../app/auth", () => ({ useTalkAuth: () => ({ getToken }) }));
vi.mock("../../app/supervision-api", async importOriginal => ({
  ...await importOriginal<typeof import("../../app/supervision-api")>(),
  apiSupervisionConversations: vi.fn(), apiSupervisionSummary: vi.fn(), apiSupervisionThread: vi.fn(),
  apiSupervisionMedia: vi.fn(), apiSupervisionPreview: vi.fn(), apiSupervisionReply: vi.fn()
}));
vi.mock("../../app/api", () => ({ apiGetAudioTranscription: vi.fn(), apiGetInboxMedia: vi.fn(), apiGetPdfPreview: vi.fn(), apiGetVideoPoster: vi.fn() }));

const seller1 = "00000000-0000-4000-8000-000000000001";
const seller2 = "00000000-0000-4000-8000-000000000002";
const summary: SupervisionSummary = { sellers: [
  { sellerCustomerId: seller1, sellerName: "Marina", sellerEmail: "marina@example.com", nextActionCount: 60, unreadConversationCount: 32 },
  { sellerCustomerId: seller2, sellerName: "Rafael", sellerEmail: "rafael@example.com", nextActionCount: 15, unreadConversationCount: 11 }
] };
const conversation = (id = "c1", overrides: Partial<SupervisionConversation> = {}): SupervisionConversation => ({
  id, workspaceId: "workspace-1", channelId: "channel-1", contactId: `contact-${id}`, contactName: `Cliente ${id}`, contactPhone: "+5511988888888",
  assignedUserId: null, departmentId: null, status: "open", priority: "normal", lastMessageAt: "2026-09-29T14:00:00Z",
  lastMessagePreview: "Preciso confirmar meu pedido", unreadCount: 2, aiControlStatus: "human_controlled", handoffReason: "Confirmar pedido",
  activeAgentSessionStatus: "handoff_requested", sellerCustomerId: seller1, sellerName: "Marina", sellerEmail: "marina@example.com", channelPhoneNumber: "+5511999999999", ...overrides
});
const message = (overrides: Partial<MessageDto> = {}): MessageDto => ({
  id: "m1", conversationId: "c1", workspaceId: "workspace-1", providerMessageId: null, direction: "inbound", type: "text",
  body: "Histórico privado", mediaUrl: null, status: "delivered", sentByUserId: null, createdAt: "2026-09-29T14:00:00Z", ...overrides
});
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; }

describe("supervisão somente de leitura", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    vi.mocked(apiSupervisionSummary).mockResolvedValue(summary);
    vi.mocked(apiSupervisionConversations).mockResolvedValue({ conversations: [conversation()], nextCursor: null });
    vi.mocked(apiSupervisionThread).mockResolvedValue({ conversation: conversation(), messages: [message()] });
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove(); vi.resetAllMocks(); vi.useRealTimers();
  });
  const render = async () => { await act(async () => root.render(<SupervisionPage />)); };
  const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find(element => element.textContent === text)!;
  const click = async (element: HTMLElement) => { expect(element).toBeTruthy(); await act(async () => element.click()); };
  const select = async (index: number, value: string) => { await act(async () => {
    const element = container.querySelectorAll("select")[index]; element.value = value; element.dispatchEvent(new Event("change", { bubbles: true }));
  }); };
  const open = async (index = 0) => click(container.querySelectorAll<HTMLButtonElement>(".supervision-conversation")[index]);

  it("shows shared location in the read-only history without fetching media or sending messages", async () => {
    vi.mocked(apiSupervisionThread).mockResolvedValue({ conversation: conversation(), messages: [message({
      type: "text", body: null, location: { latitude: -23.55, longitude: -46.63, name: "Loja de teste", address: "Endereço de teste", isLive: false }
    })] });
    await render(); await open();
    expect(container.textContent).toContain("Loja de teste");
    expect(container.textContent).toContain("Endereço de teste");
    expect(container.textContent).not.toContain("Mensagem sem texto");
    const link = [...container.querySelectorAll<HTMLAnchorElement>("a")].find(element => element.textContent === "Abrir no mapa")!;
    expect(link.href).toContain("-23.55"); expect(link.href).toContain("-46.63");
    expect(apiSupervisionMedia).not.toHaveBeenCalled();
    expect(apiSupervisionReply).not.toHaveBeenCalled();
  });

  it("uses full server summary counts beyond the first 50 rows and starts with the customers waiting for an answer", async () => {
    vi.mocked(apiSupervisionConversations).mockResolvedValue({ conversations: Array.from({ length: 50 }, (_, index) => conversation(`c${index}`)), nextCursor: "opaque-page-2" });
    await render();
    expect(apiSupervisionConversations).toHaveBeenCalledWith({ status: "active", nextAction: false, unread: false, unreadPeriod: "24h", waiting: true }, expect.any(Function), expect.any(AbortSignal));
    expect(apiSupervisionSummary).toHaveBeenCalledWith(expect.any(Function), expect.any(AbortSignal), "24h");
    expect(container.querySelector(".supervision-period-label")?.textContent).toBe("Últimas 24 horas");
    expect(container.querySelector('[aria-label="Próxima ação de todos: 75"]')?.textContent).toContain("75");
    expect(container.querySelector('[aria-label="Não lidas de todos: 43"]')).not.toBeNull();
    expect(container.querySelectorAll(".supervision-conversation")).toHaveLength(50);
    expect(container.textContent).toContain("50 carregadas");
  });

  it("passes seller, status and both indicator filters as an intersection; summary clicks return to the active queue", async () => {
    await render(); await select(0, seller2); await select(1, "closed"); await click(button("Próxima ação")); await click(button("Não lidas"));
    expect(apiSupervisionConversations).toHaveBeenLastCalledWith({ sellerCustomerId: seller2, status: "closed", nextAction: true, unread: true, unreadPeriod: "24h" }, expect.any(Function), expect.any(AbortSignal));
    await click(container.querySelector<HTMLButtonElement>('[aria-label="Não lidas de Marina: 32"]')!);
    expect(apiSupervisionConversations).toHaveBeenLastCalledWith({ sellerCustomerId: seller1, status: "active", nextAction: false, unread: true, unreadPeriod: "24h" }, expect.any(Function), expect.any(AbortSignal));
    await click(container.querySelector<HTMLButtonElement>('[aria-label="Próxima ação de todos: 75"]')!);
    expect(apiSupervisionConversations).toHaveBeenLastCalledWith({ sellerCustomerId: undefined, status: "active", nextAction: true, unread: false, unreadPeriod: "24h" }, expect.any(Function), expect.any(AbortSignal));
  });

  it("keeps the unread period selector visible and applies its choice to summary and combined filters", async () => {
    await render(); expect(container.querySelectorAll("select")[2].value).toBe("24h");
    // The period remains selectable while unread is off; next-action totals
    // stay independent of the server's selected unread window.
    vi.mocked(apiSupervisionSummary).mockResolvedValue({ sellers: summary.sellers.map(seller => ({ ...seller, unreadConversationCount: 5 })) });
    await select(2, "7d");
    expect(apiSupervisionSummary).toHaveBeenLastCalledWith(expect.any(Function), expect.any(AbortSignal), "7d");
    expect(container.querySelector(".supervision-period-label")?.textContent).toBe("Últimos 7 dias");
    expect(container.querySelector('[aria-label="Próxima ação de todos: 75"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Não lidas de todos: 10"]')).not.toBeNull();
    await select(0, seller1); await select(1, "all"); await click(button("Próxima ação")); await click(button("Não lidas"));
    expect(apiSupervisionConversations).toHaveBeenLastCalledWith({ sellerCustomerId: seller1, status: "all", nextAction: true, unread: true, unreadPeriod: "7d" }, expect.any(Function), expect.any(AbortSignal));
    await click(container.querySelector<HTMLButtonElement>('[aria-label="Não lidas de Marina: 5"]')!);
    expect(apiSupervisionConversations).toHaveBeenLastCalledWith({ sellerCustomerId: seller1, status: "active", nextAction: false, unread: true, unreadPeriod: "7d" }, expect.any(Function), expect.any(AbortSignal));
    await select(2, "all");
    expect(apiSupervisionSummary).toHaveBeenLastCalledWith(expect.any(Function), expect.any(AbortSignal), "all");
    expect(container.querySelector(".supervision-period-label")?.textContent).toBe("Todo o período");
  });

  it("opens every seller conversation from the seller name, including read and closed history with full timestamps", async () => {
    await render(); await select(2, "7d"); await select(1, "closed"); await click(button("Não lidas"));
    const read = conversation("read", { unreadCount: 0, aiControlStatus: "agent_allowed", handoffReason: null, activeAgentSessionStatus: null });
    const closed = conversation("closed", { status: "closed", unreadCount: 0, aiControlStatus: "agent_allowed", handoffReason: null, activeAgentSessionStatus: null });
    vi.mocked(apiSupervisionConversations).mockResolvedValueOnce({ conversations: [read, closed], nextCursor: null });
    const oldMessage = message({ id: "old", conversationId: "closed", body: "Pedido de 2025", createdAt: "2025-03-10T14:25:30Z" });
    vi.mocked(apiSupervisionThread).mockResolvedValueOnce({ conversation: closed, messages: [oldMessage, message({ conversationId: "closed", direction: "outbound", body: "Pedido respondido" })] });
    await click(container.querySelector<HTMLButtonElement>('[aria-label="Ver todas as conversas de Marina"]')!);
    expect(apiSupervisionConversations).toHaveBeenLastCalledWith({ sellerCustomerId: seller1, status: "all", nextAction: false, unread: false, unreadPeriod: "7d" }, expect.any(Function), expect.any(AbortSignal));
    expect(container.textContent).toContain("Cliente read"); expect(container.textContent).toContain("Cliente closed"); expect(container.textContent).toContain("Encerrada");
    expect(button("Próxima ação").getAttribute("aria-pressed")).toBe("false"); expect(button("Não lidas").getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelectorAll("select")[2].value).toBe("7d");
    await open(1);
    const timestamp = container.querySelector<HTMLTimeElement>('.supervision-message time[datetime="2025-03-10T14:25:30Z"]')!;
    expect(timestamp.textContent).toBe(new Date(oldMessage.createdAt).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }));
    expect(container.textContent).toContain("Pedido respondido"); expect(container.textContent).toContain("o vendedor verá que foi o supervisor");
    expect(apiSupervisionReply).not.toHaveBeenCalled(); expect(apiGetAudioTranscription).not.toHaveBeenCalled();
  });

  it("aborts stale unread-period summaries and lists before showing the new period's counts", async () => {
    await render();
    const oldSummary = deferred<SupervisionSummary>(); const oldList = deferred<QueuePage>(); const newSummary = deferred<SupervisionSummary>();
    vi.mocked(apiSupervisionSummary).mockReturnValueOnce(oldSummary.promise).mockReturnValueOnce(newSummary.promise);
    vi.mocked(apiSupervisionConversations).mockReturnValueOnce(oldList.promise).mockResolvedValue({ conversations: [conversation("current-period")], nextCursor: null });
    await select(2, "7d");
    const summarySignal = vi.mocked(apiSupervisionSummary).mock.calls.at(-1)![1]!;
    const listSignal = vi.mocked(apiSupervisionConversations).mock.calls.at(-1)![2]!;
    await select(2, "all");
    expect(summarySignal.aborted).toBe(true); expect(listSignal.aborted).toBe(true);
    expect(container.querySelector('[aria-label="Não lidas de Marina: 32"]')).toBeNull();
    await act(async () => {
      oldSummary.resolve({ sellers: summary.sellers.map(seller => ({ ...seller, unreadConversationCount: 999 })) });
      oldList.resolve({ conversations: [conversation("old-period")], nextCursor: "stale-page" });
    });
    expect(container.querySelector('[aria-label="Não lidas de Marina: 999"]')).toBeNull(); expect(container.textContent).not.toContain("old-period");
    await act(async () => newSummary.resolve({ sellers: summary.sellers.map(seller => ({ ...seller, unreadConversationCount: 7 })) }));
    expect(container.querySelector('[aria-label="Não lidas de todos: 14"]')).not.toBeNull();
    expect(container.querySelector(".supervision-period-label")?.textContent).toBe("Todo o período");
  });

  it("preserves the chosen unread period through polling and opaque cursor pagination", async () => {
    vi.useFakeTimers(); await render(); await select(2, "7d"); await click(button("Próxima ação")); await click(button("Não lidas"));
    vi.mocked(apiSupervisionConversations).mockResolvedValueOnce({ conversations: [conversation()], nextCursor: "period-page-2" });
    await click(button("Atualizar"));
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(apiSupervisionSummary).toHaveBeenLastCalledWith(expect.any(Function), expect.any(AbortSignal), "7d");
    expect(apiSupervisionConversations).toHaveBeenLastCalledWith({ status: "active", nextAction: true, unread: true, unreadPeriod: "7d" }, expect.any(Function), expect.any(AbortSignal));
    vi.mocked(apiSupervisionConversations).mockResolvedValueOnce({ conversations: [conversation()], nextCursor: "period-page-2" });
    await click(button("Atualizar")); await click(button("Carregar mais conversas"));
    expect(apiSupervisionConversations).toHaveBeenLastCalledWith({ status: "active", nextAction: true, unread: true, unreadPeriod: "7d" }, expect.any(Function), expect.any(AbortSignal), "period-page-2");
  });

  it("keeps the persistent red pending alert and seller unread after opening without ordinary inbox requests", async () => {
    vi.mocked(apiSupervisionThread).mockResolvedValue({ conversation: conversation(), messages: [message({ type: "audio", body: "Áudio recebido", mediaUrl: "https://example.com/audio.ogg" })] });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await render(); await open();
    expect(container.querySelector(".supervision-conversation.has-pending")).not.toBeNull();
    expect(container.querySelectorAll(".supervision-pending")).toHaveLength(2);
    expect(container.textContent).toContain("2 não lidas");
    expect(container.textContent).toContain("+5511999999999");
    expect(button("Ver transcrição")).toBeUndefined();
    expect(apiSupervisionReply).not.toHaveBeenCalled();
    expect(apiGetAudioTranscription).not.toHaveBeenCalled(); expect(apiGetInboxMedia).not.toHaveBeenCalled(); expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("lets the supervisor answer a customer through the seller's conversation, only when they press Enviar", async () => {
    vi.mocked(apiSupervisionReply).mockResolvedValue(message({ id: "sent", direction: "outbound", body: "Oi, aqui é o gerente", sentBySupervisor: true }));
    await render(); await open();
    const box = container.querySelector<HTMLTextAreaElement>('[aria-label="Resposta do supervisor"]')!;
    expect(container.textContent).toContain("Sua resposta sai pelo WhatsApp de Marina");
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, "Oi, aqui é o gerente"); box.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(apiSupervisionReply).not.toHaveBeenCalled();
    await click(container.querySelector<HTMLButtonElement>('[aria-label="Enviar resposta do supervisor"]')!);
    expect(apiSupervisionReply).toHaveBeenCalledWith("workspace-1", "c1", "Oi, aqui é o gerente", expect.any(Function));
    expect(box.value).toBe("");
  });
  it("searches every conversation by customer name or phone", async () => {
    await render();
    const search = container.querySelector<HTMLInputElement>('input[type="search"]')!;
    await act(async () => { search.value = "Jackson"; search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    expect(apiSupervisionConversations).toHaveBeenLastCalledWith(expect.objectContaining({ search: "Jackson", status: "all", nextAction: false, unread: false, waiting: undefined }), expect.any(Function), expect.any(AbortSignal));
    await click(button("Todas as conversas"));
    expect(apiSupervisionConversations).toHaveBeenLastCalledWith(expect.objectContaining({ status: "all", nextAction: false, unread: false }), expect.any(Function), expect.any(AbortSignal));
  });
  it("can display an existing transcription without generating one", async () => {
    vi.mocked(apiSupervisionThread).mockResolvedValue({ conversation: conversation(), messages: [message({ type: "audio", body: "Transcrição: Quero um orçamento", mediaUrl: "https://example.com/audio.ogg" })] });
    await render(); await open(); await click(button("Ver transcrição"));
    expect(container.textContent).toContain("Quero um orçamento"); expect(apiGetAudioTranscription).not.toHaveBeenCalled();
  });

  it("loads opaque cursor pages and deduplicates by workspace plus conversation", async () => {
    vi.mocked(apiSupervisionConversations).mockResolvedValueOnce({ conversations: [conversation()], nextCursor: "opaque-token" })
      .mockResolvedValueOnce({ conversations: [conversation(), conversation("c2"), conversation("c1", { workspaceId: "workspace-2", sellerCustomerId: seller2 })], nextCursor: null });
    await render(); await click(button("Carregar mais conversas"));
    expect(apiSupervisionConversations).toHaveBeenLastCalledWith({ status: "active", nextAction: false, unread: false, unreadPeriod: "24h", waiting: true }, expect.any(Function), expect.any(AbortSignal), "opaque-token");
    expect(container.querySelectorAll(".supervision-conversation")).toHaveLength(3);
    expect(container.querySelector('[aria-label="Próxima ação de todos: 75"]')).not.toBeNull();
  });

  it("refreshes all loaded pages with fresh cursors and removes stale completed rows", async () => {
    vi.mocked(apiSupervisionConversations).mockResolvedValueOnce({ conversations: [conversation("completed-old")], nextCursor: "old-page-2" })
      .mockResolvedValueOnce({ conversations: [conversation("second-page")], nextCursor: "old-page-3" })
      .mockResolvedValueOnce({ conversations: [conversation("new-first-page")], nextCursor: "fresh-page-2" })
      .mockResolvedValueOnce({ conversations: [conversation("second-page")], nextCursor: "fresh-page-3" });
    await render(); await click(button("Carregar mais conversas")); await click(button("Atualizar"));
    expect(apiSupervisionConversations).toHaveBeenLastCalledWith({ status: "active", nextAction: false, unread: false, unreadPeriod: "24h", waiting: true }, expect.any(Function), expect.any(AbortSignal), "fresh-page-2");
    expect(container.textContent).not.toContain("completed-old"); expect(container.textContent).toContain("new-first-page"); expect(container.textContent).toContain("second-page");
    expect(container.querySelectorAll(".supervision-conversation")).toHaveLength(2);
    // A filter change resets the loaded depth to the first page.
    vi.mocked(apiSupervisionConversations).mockResolvedValueOnce({ conversations: [conversation("filtered")], nextCursor: "unused-second-page" });
    const calls = vi.mocked(apiSupervisionConversations).mock.calls.length;
    await click(button("Não lidas")); expect(apiSupervisionConversations).toHaveBeenCalledTimes(calls + 1);
  });

  it("aborts between refreshed cursor pages on filter change without replacing with partial stale data", async () => {
    const pending = deferred<QueuePage>();
    vi.mocked(apiSupervisionConversations).mockResolvedValueOnce({ conversations: [conversation()], nextCursor: "page-2" })
      .mockResolvedValueOnce({ conversations: [conversation("loaded-second")], nextCursor: "page-3" })
      .mockResolvedValueOnce({ conversations: [conversation("stale-first")], nextCursor: "fresh-page-2" })
      .mockReturnValueOnce(pending.promise);
    await render(); await click(button("Carregar mais conversas")); await click(button("Atualizar"));
    const signal = vi.mocked(apiSupervisionConversations).mock.calls[3][2]!;
    expect(container.textContent).not.toContain("stale-first");
    vi.mocked(apiSupervisionConversations).mockResolvedValue({ conversations: [conversation("filtered")], nextCursor: null });
    await click(button("Não lidas")); expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve({ conversations: [conversation("stale-second")], nextCursor: "page-3" }));
    expect(container.textContent).toContain("filtered"); expect(container.textContent).not.toContain("stale-first"); expect(container.textContent).not.toContain("stale-second");
  });

  it("polls list, summary and an open thread only while visible, immediately resuming on visibility", async () => {
    vi.useFakeTimers(); await render(); await open();
    const counts = () => [vi.mocked(apiSupervisionSummary).mock.calls.length, vi.mocked(apiSupervisionConversations).mock.calls.length, vi.mocked(apiSupervisionThread).mock.calls.length];
    expect(counts()).toEqual([1, 1, 1]);
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); }); expect(counts()).toEqual([2, 2, 2]);
    await act(async () => { Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" }); document.dispatchEvent(new Event("visibilitychange")); await vi.advanceTimersByTimeAsync(45_000); });
    expect(counts()).toEqual([2, 2, 2]);
    await act(async () => { Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" }); document.dispatchEvent(new Event("visibilitychange")); });
    expect(counts()).toEqual([3, 3, 3]);
  });

  it("does not overlap slow polls and preserves an authorized selected thread outside the refreshed first page", async () => {
    vi.useFakeTimers(); await render(); await open();
    const pending = deferred<QueuePage>(); vi.mocked(apiSupervisionConversations).mockReturnValueOnce(pending.promise);
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(apiSupervisionConversations).toHaveBeenCalledTimes(2);
    await act(async () => pending.resolve({ conversations: [conversation("new-top-row")], nextCursor: null }));
    expect(container.querySelector(".supervision-thread")?.textContent).toContain("Histórico privado");
    expect(container.querySelector(".supervision-thread")?.textContent).toContain("Cliente c1");
  });

  it("aborts stale filters and ignores a response resolving after cancellation", async () => {
    const pending = deferred<QueuePage>(); vi.mocked(apiSupervisionConversations).mockReturnValueOnce(pending.promise);
    await render(); const signal = vi.mocked(apiSupervisionConversations).mock.calls[0][2]!;
    vi.mocked(apiSupervisionConversations).mockResolvedValue({ conversations: [conversation("current")], nextCursor: null });
    await click(button("Não lidas")); expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve({ conversations: [conversation("stale")], nextCursor: "stale-cursor" }));
    expect(container.textContent).toContain("Cliente current"); expect(container.textContent).not.toContain("Cliente stale");
    expect(button("Carregar mais conversas")).toBeUndefined();
  });

  it("aborts old history when selection changes and clears selection on a seller change", async () => {
    const pending = deferred<SupervisionThread>();
    vi.mocked(apiSupervisionConversations).mockResolvedValue({ conversations: [conversation(), conversation("c2")], nextCursor: null });
    vi.mocked(apiSupervisionThread).mockReturnValueOnce(pending.promise).mockResolvedValueOnce({ conversation: conversation("c2"), messages: [message({ id: "m2", conversationId: "c2", body: "Histórico atual" })] });
    await render(); await open(); const signal = vi.mocked(apiSupervisionThread).mock.calls[0][3]!;
    await open(1); expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve({ conversation: conversation(), messages: [message({ body: "Histórico antigo" })] }));
    expect(container.textContent).toContain("Histórico atual"); expect(container.textContent).not.toContain("Histórico antigo");
    await select(0, seller2); expect(container.textContent).not.toContain("Histórico atual");
  });

  it.each([401, 403])("clears all cached data and history when access is denied with %s", async status => {
    await render(); await open();
    const pending = deferred<QueuePage>();
    vi.mocked(apiSupervisionSummary).mockRejectedValueOnce(new SupervisionApiError(status, "denied"));
    vi.mocked(apiSupervisionConversations).mockReturnValueOnce(pending.promise);
    await click(button("Atualizar"));
    await act(async () => pending.resolve({ conversations: [conversation("cached")], nextCursor: null }));
    expect(container.textContent).toContain("Acesso à supervisão indisponível");
    expect(container.textContent).not.toContain("Histórico privado"); expect(container.textContent).not.toContain("marina@example.com");
    expect(container.querySelector(".supervision-summary")).toBeNull(); expect(container.querySelector(".supervision-thread")).toBeNull();
  });

  it.each(["list-first", "summary-first"])("recovers remaining seller access when the filtered seller is revoked (%s)", async order => {
    vi.useFakeTimers(); await render(); await select(2, "7d"); await select(0, seller1); await open();
    const revokedList = deferred<QueuePage>(); const remainingSummary = deferred<SupervisionSummary>();
    const remainingConversation = conversation("remaining", { sellerCustomerId: seller2, sellerName: "Rafael", sellerEmail: "rafael@example.com", workspaceId: "workspace-2" });
    vi.mocked(apiSupervisionSummary).mockReturnValueOnce(remainingSummary.promise).mockResolvedValue({ sellers: [summary.sellers[1]] });
    vi.mocked(apiSupervisionConversations).mockReturnValueOnce(revokedList.promise).mockResolvedValue({ conversations: [remainingConversation], nextCursor: null });
    await click(button("Atualizar"));
    if (order === "list-first") {
      await act(async () => revokedList.reject(new SupervisionApiError(403, "Vendedor não autorizado")));
      expect(container.textContent).not.toContain("Histórico privado"); expect(container.querySelectorAll(".supervision-conversation")).toHaveLength(0);
      expect(container.textContent).not.toContain("Acesso à supervisão indisponível");
      await act(async () => remainingSummary.resolve({ sellers: [summary.sellers[1]] }));
    } else {
      await act(async () => remainingSummary.resolve({ sellers: [summary.sellers[1]] }));
      await act(async () => revokedList.reject(new SupervisionApiError(403, "Vendedor não autorizado")));
    }
    expect(container.querySelector<HTMLSelectElement>("select")?.value).toBe("");
    expect(container.textContent).toContain("Cliente remaining"); expect(container.textContent).toContain("rafael@example.com");
    expect(container.textContent).not.toContain("marina@example.com"); expect(container.textContent).not.toContain("Histórico privado");
    expect(container.textContent).not.toContain("Acesso à supervisão indisponível");
    expect(apiSupervisionConversations).toHaveBeenLastCalledWith({ sellerCustomerId: undefined, status: "active", nextAction: false, unread: false, unreadPeriod: "7d", waiting: true }, expect.any(Function), expect.any(AbortSignal));
    expect(container.querySelectorAll("select")[2].value).toBe("7d");
    expect(vi.mocked(apiSupervisionSummary).mock.calls.slice(1).every(call => call[2] === "7d")).toBe(true);
    const polls = vi.mocked(apiSupervisionConversations).mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(apiSupervisionConversations).toHaveBeenCalledTimes(polls + 1);
  });

  it("revalidates a summary that preceded a filtered denial and confirms a fully denied session", async () => {
    await render(); await select(0, seller1); await open();
    const revokedList = deferred<QueuePage>();
    vi.mocked(apiSupervisionConversations).mockReturnValueOnce(revokedList.promise);
    vi.mocked(apiSupervisionSummary).mockResolvedValueOnce(summary).mockRejectedValueOnce(new SupervisionApiError(403, "Nenhum vendedor autorizado"));
    await click(button("Atualizar"));
    await act(async () => revokedList.reject(new SupervisionApiError(403, "Vendedor não autorizado")));
    expect(container.textContent).toContain("Acesso à supervisão indisponível"); expect(container.textContent).not.toContain("Histórico privado");
  });

  it("shows a retry if scope revalidation fails without showing cached data or a successful update", async () => {
    await render(); await select(0, seller1); await open();
    const revokedList = deferred<QueuePage>();
    vi.mocked(apiSupervisionConversations).mockReturnValueOnce(revokedList.promise);
    vi.mocked(apiSupervisionSummary).mockResolvedValueOnce(summary).mockRejectedValueOnce(new Error("network"));
    await click(button("Atualizar"));
    await act(async () => revokedList.reject(new SupervisionApiError(403, "Vendedor não autorizado")));
    expect(container.textContent).toContain("Não foi possível verificar os vendedores autorizados");
    expect(container.textContent).not.toContain("Acesso à supervisão indisponível"); expect(container.textContent).not.toContain("Histórico privado");
    expect(container.textContent).not.toContain("Atualizado às"); expect(container.querySelectorAll(".supervision-conversation")).toHaveLength(0);
  });

  it("never restores a revoked seller from a late old summary if post-denial revalidation fails", async () => {
    await render(); await select(0, seller1); await open();
    const revokedList = deferred<QueuePage>(); const oldSummary = deferred<SupervisionSummary>(); const recheck = deferred<SupervisionSummary>();
    vi.mocked(apiSupervisionConversations).mockReturnValueOnce(revokedList.promise);
    vi.mocked(apiSupervisionSummary).mockReturnValueOnce(oldSummary.promise).mockReturnValueOnce(recheck.promise);
    await click(button("Atualizar"));
    await act(async () => revokedList.reject(new SupervisionApiError(403, "Vendedor não autorizado")));
    expect(container.textContent).not.toContain("marina@example.com"); expect(container.textContent).not.toContain("Histórico privado");
    await act(async () => oldSummary.resolve(summary));
    // The stale A+B summary is ignored while the authoritative recheck waits.
    expect(container.textContent).not.toContain("marina@example.com");
    expect(container.querySelector('[aria-label="Próxima ação de Marina: 60"]')).toBeNull();
    await act(async () => recheck.reject(new Error("network")));
    expect(container.textContent).toContain("Não foi possível verificar os vendedores autorizados");
    expect(container.textContent).not.toContain("marina@example.com"); expect(container.textContent).not.toContain("Histórico privado");
    expect(container.textContent).not.toContain("Atualizado às"); expect(container.querySelectorAll(".supervision-conversation")).toHaveLength(0);
  });

  it("recovers the remaining sellers after a filtered pagination denial", async () => {
    vi.mocked(apiSupervisionConversations).mockResolvedValue({ conversations: [conversation()], nextCursor: "old-page-2" });
    await render(); await select(2, "7d"); await select(0, seller1); await open();
    const remainingConversation = conversation("remaining", { sellerCustomerId: seller2, sellerName: "Rafael", workspaceId: "workspace-2" });
    vi.mocked(apiSupervisionConversations).mockRejectedValueOnce(new SupervisionApiError(403, "Vendedor não autorizado"))
      .mockResolvedValue({ conversations: [remainingConversation], nextCursor: null });
    vi.mocked(apiSupervisionSummary).mockResolvedValue({ sellers: [summary.sellers[1]] });
    await click(button("Carregar mais conversas"));
    expect(container.querySelector<HTMLSelectElement>("select")?.value).toBe(""); expect(container.textContent).toContain("Cliente remaining");
    expect(container.textContent).not.toContain("Histórico privado"); expect(container.textContent).not.toContain("Acesso à supervisão indisponível");
    expect(vi.mocked(apiSupervisionSummary).mock.calls.slice(1).every(call => call[2] === "7d")).toBe(true);
    expect(apiSupervisionConversations).toHaveBeenLastCalledWith({ sellerCustomerId: undefined, status: "active", nextAction: false, unread: false, unreadPeriod: "7d", waiting: true }, expect.any(Function), expect.any(AbortSignal));
  });

  it("unmounts cached history on a revoked seller scope or a missing thread", async () => {
    await render(); await open();
    vi.mocked(apiSupervisionSummary).mockResolvedValueOnce({ sellers: [summary.sellers[1]] });
    await click(button("Atualizar")); expect(container.textContent).not.toContain("Histórico privado");
    expect(container.querySelectorAll(".supervision-conversation")).toHaveLength(0);
    vi.mocked(apiSupervisionSummary).mockResolvedValue(summary); await click(button("Atualizar"));
    vi.mocked(apiSupervisionThread).mockRejectedValueOnce(new SupervisionApiError(404, "missing"));
    await open(); expect(container.textContent).toContain("Esta conversa não está mais disponível"); expect(container.textContent).not.toContain("Histórico privado");
  });

  it("handles media access denial through the supervisor transport and clears the viewer", async () => {
    vi.mocked(apiSupervisionThread).mockResolvedValue({ conversation: conversation(), messages: [message({ type: "file", body: "Documento.pdf", mediaUrl: "https://example.com/file.pdf" })] });
    vi.mocked(apiSupervisionMedia).mockRejectedValue(new SupervisionApiError(403, "denied"));
    await render(); await open(); await click(container.querySelector<HTMLButtonElement>('[aria-label="Abrir documento"]')!);
    expect(apiSupervisionMedia).toHaveBeenCalledWith("workspace-1", "c1", "m1", expect.any(Function), expect.any(AbortSignal));
    expect(container.textContent).toContain("Acesso à supervisão indisponível"); expect(container.querySelector(".talk-attachment")).toBeNull();
    expect(apiGetInboxMedia).not.toHaveBeenCalled();
  });

  it("shows an explicit retry on network errors without claiming an update", async () => {
    vi.mocked(apiSupervisionSummary).mockRejectedValueOnce(new Error("network")); await render();
    expect(container.textContent).toContain("Não foi possível atualizar a supervisão"); expect(container.textContent).not.toContain("Atualizado às");
    await click(button("Tentar novamente")); expect(container.textContent).toContain("Atualizado às");
  });
});
