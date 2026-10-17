import type {
  PriceHistoryDto, PriceHistoryRow, PurchaseQuoteInput, PurchaseRequestDetailDto, PurchaseRequestInput, PurchaseStartInput,
  PurchaseRequestSummaryDto, SupplierDto, SupplierImportResult, SupplierInput
} from "@prymeira-talk/shared";
import { fetchJson } from "../../app/api";

type GetToken = () => Promise<string | null>;
const id = <T,>(value: unknown) => value as T;
const json = (body: unknown) => ({ body: JSON.stringify(body) });
const post = (body: unknown = {}) => ({ method: "POST", ...json(body) });

export const purchasingApi = {
  listRequests: (getToken: GetToken) =>
    fetchJson(getToken, "/purchasing/requests", {}, id<PurchaseRequestSummaryDto[]>, "Não foi possível carregar os pedidos."),
  getRequest: (getToken: GetToken, requestId: string) =>
    fetchJson(getToken, `/purchasing/requests/${requestId}`, {}, id<PurchaseRequestDetailDto>, "Não foi possível abrir o pedido."),
  createRequest: (getToken: GetToken, input: PurchaseRequestInput) =>
    fetchJson(getToken, "/purchasing/requests", post(input), id<PurchaseRequestDetailDto>, "Não foi possível criar o pedido."),
  startQuoting: (getToken: GetToken, requestId: string, input: PurchaseStartInput = {}) =>
    fetchJson(getToken, `/purchasing/requests/${requestId}/start`, post(input), id<PurchaseRequestDetailDto>, "Não foi possível iniciar a cotação."),
  sendDraft: (getToken: GetToken, requestId: string, inviteId: string, text?: string) =>
    fetchJson(getToken, `/purchasing/requests/${requestId}/invites/${inviteId}/draft/send`, post(text ? { text } : {}), id<PurchaseRequestDetailDto>, "Não foi possível enviar a mensagem."),
  discardDraft: (getToken: GetToken, requestId: string, inviteId: string) =>
    fetchJson(getToken, `/purchasing/requests/${requestId}/invites/${inviteId}/draft/discard`, post(), id<PurchaseRequestDetailDto>, "Não foi possível descartar."),
  resumeAgent: (getToken: GetToken, requestId: string, inviteId: string) =>
    fetchJson(getToken, `/purchasing/requests/${requestId}/invites/${inviteId}/agent/resume`, post(), id<PurchaseRequestDetailDto>, "Não foi possível devolver ao agente."),
  addSuppliers: (getToken: GetToken, requestId: string, supplierIds: string[]) =>
    fetchJson(getToken, `/purchasing/requests/${requestId}/suppliers`, post({ supplierIds }), id<PurchaseRequestDetailDto>, "Não foi possível adicionar."),
  removeInvite: (getToken: GetToken, requestId: string, inviteId: string) =>
    fetchJson(getToken, `/purchasing/requests/${requestId}/invites/${inviteId}`, { method: "DELETE" }, id<PurchaseRequestDetailDto>, "Não foi possível remover."),
  recordQuote: (getToken: GetToken, requestId: string, inviteId: string, input: PurchaseQuoteInput) =>
    fetchJson(getToken, `/purchasing/requests/${requestId}/invites/${inviteId}/quotes`, post(input), id<PurchaseRequestDetailDto>, "Não foi possível registrar a proposta."),
  decline: (getToken: GetToken, requestId: string, inviteId: string, reason: string | null) =>
    fetchJson(getToken, `/purchasing/requests/${requestId}/invites/${inviteId}/decline`, post({ reason }), id<PurchaseRequestDetailDto>, "Não foi possível marcar."),
  approve: (getToken: GetToken, requestId: string, inviteId: string) =>
    fetchJson(getToken, `/purchasing/requests/${requestId}/invites/${inviteId}/approve`, post(), id<PurchaseRequestDetailDto>, "Não foi possível aprovar."),
  cancel: (getToken: GetToken, requestId: string) =>
    fetchJson(getToken, `/purchasing/requests/${requestId}/cancel`, post(), id<PurchaseRequestDetailDto>, "Não foi possível cancelar."),
  complete: (getToken: GetToken, requestId: string) =>
    fetchJson(getToken, `/purchasing/requests/${requestId}/complete`, post(), id<PurchaseRequestDetailDto>, "Não foi possível concluir."),

  listSuppliers: (getToken: GetToken, search = "") =>
    fetchJson(getToken, `/purchasing/suppliers${search ? `?search=${encodeURIComponent(search)}` : ""}`, {}, id<SupplierDto[]>, "Não foi possível carregar os fornecedores."),
  createSupplier: (getToken: GetToken, input: SupplierInput) =>
    fetchJson(getToken, "/purchasing/suppliers", post(input), id<SupplierDto>, "Não foi possível salvar o fornecedor."),
  updateSupplier: (getToken: GetToken, supplierId: string, input: Partial<SupplierInput>) =>
    fetchJson(getToken, `/purchasing/suppliers/${supplierId}`, { method: "PATCH", ...json(input) }, id<SupplierDto>, "Não foi possível salvar o fornecedor."),
  archiveSupplier: (getToken: GetToken, supplierId: string) =>
    fetchJson(getToken, `/purchasing/suppliers/${supplierId}`, { method: "DELETE" }, id<{ ok: true }>, "Não foi possível remover o fornecedor."),
  importSuppliers: (getToken: GetToken, rows: SupplierInput[]) =>
    fetchJson(getToken, "/purchasing/suppliers/import", post({ rows }), id<SupplierImportResult>, "Não foi possível importar."),
  listPrices: (getToken: GetToken, search = "") =>
    fetchJson(getToken, `/purchasing/prices${search ? `?search=${encodeURIComponent(search)}` : ""}`, {}, id<PriceHistoryDto[]>, "Não foi possível carregar os preços."),
  importPrices: (getToken: GetToken, rows: PriceHistoryRow[]) =>
    fetchJson(getToken, "/purchasing/prices/import", post({ rows }), id<{ created: number; rejected: Array<{ row: number; reason: string }> }>, "Não foi possível importar.")
};
