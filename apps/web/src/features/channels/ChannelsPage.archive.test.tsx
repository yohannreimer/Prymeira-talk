// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelDto } from "@prymeira-talk/shared";
import { ChannelsPage } from "./ChannelsPage";

const getToken = vi.fn(async () => "token");
const diogo: ChannelDto = {
  id: "00000000-0000-4000-8000-000000000001",
  workspaceId: "workspace",
  provider: "evolution",
  providerKey: "Diogo",
  phoneNumber: null,
  displayName: "Diogo — Villefer",
  status: "disconnected",
  archivedAt: null,
  createdAt: "2026-09-22T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z"
};
const archived: ChannelDto = { ...diogo, id: "00000000-0000-4000-8000-000000000002", displayName: "Canal antigo", archivedAt: "2026-10-02T00:00:00.000Z" };
const api = vi.hoisted(() => ({
  apiCreateChannel: vi.fn(), apiCreateTestInbound: vi.fn(), apiDeleteChannel: vi.fn(), apiDisconnectChannel: vi.fn(),
  apiGetChannelDeletionImpact: vi.fn(), apiGetChannels: vi.fn(), apiGetSettings: vi.fn(), apiSetChannelArchived: vi.fn(), apiStartChannelQr: vi.fn()
}));
vi.mock("../../app/auth", () => ({ useTalkAuth: () => ({ getToken }) }));
vi.mock("../../app/api", () => api);
vi.mock("../inbox/useRealtimeEvents", () => ({ useRealtimeEvents: vi.fn() }));
vi.mock("./AssistantChannelSettings", () => ({ AssistantChannelSettings: () => null }));

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  api.apiGetChannels.mockResolvedValue([diogo, archived]);
  api.apiGetSettings.mockResolvedValue(null);
  api.apiGetChannelDeletionImpact.mockResolvedValue({ channelId: diogo.id, confirmationName: "Diogo — Villefer", conversations: 149, messages: 2864 });
  api.apiDeleteChannel.mockResolvedValue({ ok: true, channelId: diogo.id });
  api.apiSetChannelArchived.mockImplementation(async (_getToken: unknown, _id: string, value: boolean) => ({ ...diogo, archivedAt: value ? "2026-10-02T12:00:00.000Z" : null }));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.clearAllMocks(); });
async function render() { await act(async () => { root.render(<ChannelsPage />); }); }
function button(label: string) { const found = [...container.querySelectorAll("button")].find((item) => item.textContent?.trim() === label); expect(found).toBeDefined(); return found!; }
async function click(label: string) { await act(async () => button(label).click()); }
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("ChannelsPage", () => {
  it("lists only active channels and keeps archived ones behind a toggle", async () => {
    await render();

    expect(api.apiGetChannels).toHaveBeenCalledWith(getToken, undefined, { includeArchived: true });
    expect(container.textContent).toContain("Diogo — Villefer");
    expect(container.textContent).not.toContain("Canal antigo");

    await click("Arquivados (1)");

    expect(container.textContent).toContain("Canal antigo");
    expect(button("Restaurar")).toBeDefined();
  });

  it("archives a channel without deleting it", async () => {
    await render();
    await click("Arquivar");

    expect(api.apiSetChannelArchived).toHaveBeenCalledWith(getToken, diogo.id, true);
    expect(api.apiDeleteChannel).not.toHaveBeenCalled();
    expect(container.textContent).toContain("As conversas continuam no Atendimento");
    expect(container.textContent).toContain("Arquivados (2)");
  });

  it("shows what a deletion removes and only deletes after the channel name is typed", async () => {
    await render();
    await click("Apagar");

    expect(container.textContent).toContain("149 conversas");
    expect(container.textContent).toContain("2864 mensagens");
    expect(button("Apagar definitivamente").disabled).toBe(true);

    const input = container.querySelector<HTMLInputElement>('input[aria-label="Nome do canal para confirmar"]')!;
    await type(input, "Diogo");
    expect(button("Apagar definitivamente").disabled).toBe(true);

    await type(input, "Diogo — Villefer");
    await click("Apagar definitivamente");

    expect(api.apiDeleteChannel).toHaveBeenCalledWith(getToken, diogo.id, "Diogo — Villefer");
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.textContent).toContain("Canal apagado.");
  });

  it("offers archiving from the delete dialog", async () => {
    await render();
    await click("Apagar");
    await click("Arquivar em vez disso");

    expect(api.apiSetChannelArchived).toHaveBeenCalledWith(getToken, diogo.id, true);
    expect(api.apiDeleteChannel).not.toHaveBeenCalled();
  });
});
