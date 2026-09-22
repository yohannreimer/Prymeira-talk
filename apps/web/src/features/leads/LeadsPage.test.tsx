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
  apiGetLeadLists: vi.fn(), apiGetLeadResults: vi.fn(), apiGetLeadJob: vi.fn(), apiStartGoogleLeadSearch: vi.fn(), apiStartReceitaLeadSearch: vi.fn(), apiLookupReceitaLeads: vi.fn(), apiUploadLeadCsv: vi.fn(), apiDownloadLeadErrors: vi.fn(), apiGetSimilarLeads: vi.fn(), apiSaveSimilarLeadList: vi.fn(), apiRetryLeadJob: vi.fn(), apiVerifyLeadWhatsapp: vi.fn(), apiImportLeadContacts: vi.fn(), apiCreateLeadCampaignDraft: vi.fn()
}));
vi.mock("../../app/auth", () => ({ useTalkAuth: () => ({ getToken }) }));
vi.mock("../../app/api", () => api);

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  api.apiGetLeadLists.mockResolvedValue([list]);
  api.apiGetLeadResults.mockResolvedValue({ items: [lead], page: 1, pageSize: 25, total: 1 });
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.clearAllMocks(); });
async function render() { await act(async () => { root.render(<LeadsPage />); }); }
async function click(label: string) { const button = [...container.querySelectorAll("button")].find(item => item.textContent?.includes(label)); expect(button).toBeDefined(); await act(async () => button!.click()); }

describe("LeadsPage", () => {
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
