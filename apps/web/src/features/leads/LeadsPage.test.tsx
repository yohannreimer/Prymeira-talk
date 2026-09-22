// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LeadListDto, LeadResultDto } from "@prymeira-talk/shared";
import { LeadsPage } from "./LeadsPage";

const getToken = vi.fn(async () => "token");
const list: LeadListDto = { id: "00000000-0000-4000-8000-000000000001", workspaceId: "workspace", name: "Clínicas", source: "receita_federal", criteria: {}, totalCount: 1, processedCount: 1, failedCount: 0, startedAt: null, completedAt: null, createdAt: "2026-09-22T00:00:00.000Z", updatedAt: "2026-09-22T00:00:00.000Z" };
const lead: LeadResultDto = { id: "00000000-0000-4000-8000-000000000002", workspaceId: "workspace", listId: list.id, source: "receita_federal", companyName: "Clínica Aurora", tradeName: null, cnpj: "12345678000190", cnaePrimary: "8630", cnaeSecondary: [], category: null, address: "Rua A, 10", city: "Campinas", state: "SP", postalCode: null, phones: ["5511999999999"], normalizedPhone: "5511999999999", email: null, website: null, rating: null, reviewCount: null, latitude: null, longitude: null, sourceUrl: null, whatsappStatus: "unverified", whatsappVerifications: [], createdAt: "2026-09-22T00:00:00.000Z", updatedAt: "2026-09-22T00:00:00.000Z" };
const api = vi.hoisted(() => ({
  apiGetLeadLists: vi.fn(), apiDeleteLeadList: vi.fn(), apiGetLeadResults: vi.fn(), apiGetLeadJob: vi.fn(), apiStartGoogleLeadSearch: vi.fn(), apiStartReceitaLeadSearch: vi.fn(), apiLookupReceitaLeads: vi.fn(), apiUploadLeadCsv: vi.fn(), apiDownloadLeadErrors: vi.fn(), apiGetSimilarLeads: vi.fn(), apiSaveSimilarLeadList: vi.fn(), apiRetryLeadJob: vi.fn(), apiVerifyLeadWhatsapp: vi.fn(), apiImportLeadContacts: vi.fn(), apiCreateLeadCampaignDraft: vi.fn()
}));
vi.mock("../../app/auth", () => ({ useTalkAuth: () => ({ getToken }) }));
vi.mock("../../app/api", () => api);

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  api.apiGetLeadLists.mockResolvedValue([list]);
  api.apiDeleteLeadList.mockResolvedValue(undefined);
  api.apiGetLeadResults.mockResolvedValue({ items: [lead], page: 1, pageSize: 25, total: 1 });
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.clearAllMocks(); });
async function render() { await act(async () => { root.render(<LeadsPage />); }); }
async function click(label: string) { const button = [...container.querySelectorAll("button")].find(item => item.textContent?.includes(label)); expect(button).toBeDefined(); await act(async () => button!.click()); }

describe("LeadsPage", () => {
  const savedList = (index: number): LeadListDto => ({
    ...list,
    id: `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
    name: `Lista ${index}`,
    updatedAt: new Date(Date.UTC(2026, 8, 22) - index * 1000).toISOString()
  });

  it("shows three recent lists until expanded and can collapse them again", async () => {
    api.apiGetLeadLists.mockResolvedValue([1, 2, 3, 4].map(savedList));
    await render();
    expect(container.querySelectorAll(".leads-list-row")).toHaveLength(3);
    await click("Ver todas");
    expect(container.querySelectorAll(".leads-list-row")).toHaveLength(4);
    await click("Mostrar menos");
    expect(container.querySelectorAll(".leads-list-row")).toHaveLength(3);
  });

  it("loads older lists beyond the first page on demand", async () => {
    api.apiGetLeadLists.mockImplementation(async (_token: unknown, page: number) =>
      page === 1 ? Array.from({ length: 50 }, (_, index) => savedList(index + 1)) : [savedList(51)]);
    await render();
    expect(container.querySelectorAll(".leads-list-row")).toHaveLength(3);
    await click("Ver todas");
    expect(container.querySelectorAll(".leads-list-row")).toHaveLength(50);
    await click("Carregar mais");
    expect(container.querySelectorAll(".leads-list-row")).toHaveLength(51);
    expect(api.apiGetLeadLists).toHaveBeenCalledWith(getToken, 2, 50);
  });

  it("keeps loaded older lists visible when refreshing the selected one", async () => {
    api.apiGetLeadLists.mockImplementation(async (_token: unknown, page: number) =>
      page === 1 ? Array.from({ length: 50 }, (_, index) => savedList(index + 1)) : [savedList(51)]);
    await render();
    await click("Ver todas");
    await click("Carregar mais");
    await click("Lista 51");
    await click("Atualizar");
    expect(container.querySelectorAll(".leads-list-row")).toHaveLength(51);
    expect(container.querySelector(".leads-results-head h2")?.textContent).toBe("Lista 51");
  });

  it("requires confirmation and selects another list after deletion", async () => {
    const first = savedList(1);
    const second = savedList(2);
    api.apiGetLeadLists.mockResolvedValueOnce([first, second]).mockResolvedValue([second]);
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>(`[aria-label="Excluir lista ${first.name}"]`)!.click());
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain(first.name);
    await click("Cancelar");
    expect(api.apiDeleteLeadList).not.toHaveBeenCalled();
    await act(async () => container.querySelector<HTMLButtonElement>(`[aria-label="Excluir lista ${first.name}"]`)!.click());
    await click("Excluir definitivamente");
    expect(api.apiDeleteLeadList).toHaveBeenCalledExactlyOnceWith(getToken, first.id);
    expect(container.querySelectorAll(".leads-list-row")).toHaveLength(1);
    expect(container.querySelector(".leads-results-head h2")?.textContent).toBe(second.name);
  });

  it("keeps a list and selection after a delete conflict", async () => {
    const first = savedList(1);
    api.apiGetLeadLists.mockResolvedValue([first]);
    api.apiDeleteLeadList.mockRejectedValue(new Error("Esta lista já originou contatos e não pode ser excluída."));
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>(`[aria-label="Excluir lista ${first.name}"]`)!.click());
    await click("Excluir definitivamente");
    expect(container.querySelectorAll(".leads-list-row")).toHaveLength(1);
    expect(container.querySelector(".leads-results-head h2")?.textContent).toBe(first.name);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("originou contatos");
  });

  it("shows the empty state after deleting the last list", async () => {
    const only = savedList(1);
    api.apiGetLeadLists.mockResolvedValueOnce([only]).mockResolvedValue([]);
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>(`[aria-label="Excluir lista ${only.name}"]`)!.click());
    await click("Excluir definitivamente");
    expect(container.querySelectorAll(".leads-list-row")).toHaveLength(0);
    expect(container.querySelector(".leads-results-head h2")?.textContent).toBe("Resultados");
    expect(container.textContent).toContain("Suas buscas salvas aparecem aqui.");
  });

  it("switches source forms while keeping saved lists visible", async () => {
    await render();
    expect(container.textContent).toContain("Minhas listas");
    expect(container.textContent).toContain("Google Maps");
    const tab = container.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="false"]')!;
    await act(async () => tab.click());
    expect(container.textContent).toContain("Consultar empresa");
    expect(container.textContent).toContain("Importar CNPJs");
  });

  it("shows unverified status and requires selected-count confirmation before importing", async () => {
    await render();
    expect(container.textContent).toContain("Não verificado");
    const select = container.querySelector<HTMLInputElement>(`input[aria-label="Selecionar Clínica Aurora"]`)!;
    await act(async () => select.click());
    await click("Cadastrar contatos");
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain("1 lead selecionado");
    expect(api.apiImportLeadContacts).not.toHaveBeenCalled();
  });

  it("disables bulk actions when nothing is selected", async () => {
    await render();
    const button = [...container.querySelectorAll("button")].find(item => item.textContent?.includes("Verificar WhatsApp"))!;
    expect(button.disabled).toBe(true);
  });

  it("rejects an oversized CSV before sending it", async () => {
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="false"]')!.click());
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File([new Uint8Array(5 * 1024 * 1024 + 1)], "empresas.csv", { type: "text/csv" });
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    await act(async () => input.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("excede 5 MiB");
    expect(api.apiUploadLeadCsv).not.toHaveBeenCalled();
  });

  it("shows a failed job with progress and starts a retry", async () => {
    const googleList = { ...list, id: "00000000-0000-4000-8000-000000000003", source: "google_maps" as const, name: "Clínicas em Campinas", processedCount: 4, failedCount: 1 };
    const failedJob = { id: "00000000-0000-4000-8000-000000000004", workspaceId: "workspace", listId: googleList.id, operation: "google_maps_search", status: "failed" as const, attempts: 1, leaseUntil: null, startedAt: null, finishedAt: null, errorMessage: "Tempo esgotado", retryable: true, createdAt: "2026-09-22T00:00:00.000Z", updatedAt: "2026-09-22T00:00:00.000Z" };
    api.apiStartGoogleLeadSearch.mockResolvedValue({ list: googleList, job: failedJob, replayed: false });
    api.apiRetryLeadJob.mockResolvedValue({ ...failedJob, status: "queued", errorMessage: null });
    await render();
    const inputs = container.querySelectorAll<HTMLInputElement>(".leads-search-form input.text-input");
    for (const [index, value] of [[1, "clínicas"], [2, "Campinas"], [3, "SP"]] as const) {
      await act(async () => { const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!; setter.call(inputs[index], value); inputs[index].dispatchEvent(new Event("input", { bubbles: true })); });
    }
    await act(async () => container.querySelector(".leads-search-form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(container.textContent).toContain("Tempo esgotado");
    expect(container.textContent).toContain("4 processados · 1 falhas");
    await click("Tentar novamente");
    expect(api.apiRetryLeadJob).toHaveBeenCalledWith(getToken, failedJob.id);
  });
});
