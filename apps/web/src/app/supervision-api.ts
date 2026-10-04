import { messageSchema, supervisionPageSchema, supervisionSummarySchema, supervisionThreadSchema, type SupervisionUnreadPeriod } from "@prymeira-talk/shared";
import { readConfigValue } from "./runtime-config";

const apiUrl = readConfigValue("VITE_API_URL") ?? "http://localhost:3002";
type GetToken = () => Promise<string | null>;
export type SupervisionFilter = {
  sellerCustomerId?: string;
  status: "active" | "closed" | "all";
  nextAction: boolean;
  unread: boolean;
  unreadPeriod?: SupervisionUnreadPeriod;
  /** Only customers waiting for an answer, the longest wait first (present only when on). */
  waiting?: boolean;
  /** Customer name or phone. */
  search?: string;
};

export class SupervisionApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "SupervisionApiError";
  }
}

async function request(path: string, getToken: GetToken, signal?: AbortSignal, body?: unknown) {
  const token = await getToken();
  if (!token) throw new SupervisionApiError(401, "Entre novamente pelo Hub para consultar a supervisão.");
  const response = await fetch(`${apiUrl}${path}`, {
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, signal, cache: "no-store",
    ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) })
  });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const message = body && typeof body === "object" && "message" in body && typeof body.message === "string" ? body.message
      : body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error
      : "Não foi possível consultar a supervisão. Atualize para tentar novamente.";
    throw new SupervisionApiError(response.status, message);
  }
  return response;
}

export async function apiSupervisionSummary(getToken: GetToken, signal?: AbortSignal, unreadPeriod: SupervisionUnreadPeriod = "all") {
  const query = unreadPeriod === "all" ? "" : `?${new URLSearchParams({ unreadPeriod })}`;
  return supervisionSummarySchema.parse(await (await request(`/supervision/summary${query}`, getToken, signal)).json());
}
export async function apiSupervisionConversations(filters: SupervisionFilter, getToken: GetToken, signal?: AbortSignal, cursor?: string) {
  const query = new URLSearchParams({ status: filters.status, nextAction: String(filters.nextAction), unread: String(filters.unread) });
  if (filters.sellerCustomerId) query.set("sellerCustomerId", filters.sellerCustomerId);
  if (filters.unreadPeriod) query.set("unreadPeriod", filters.unreadPeriod);
  if (filters.waiting) query.set("waiting", "true");
  if (filters.search?.trim()) query.set("search", filters.search.trim());
  if (cursor) query.set("cursor", cursor);
  return supervisionPageSchema.parse(await (await request(`/supervision/conversations?${query}`, getToken, signal)).json());
}
function conversationPath(workspaceId: string, conversationId: string) {
  return `/supervision/workspaces/${encodeURIComponent(workspaceId)}/conversations/${encodeURIComponent(conversationId)}`;
}
export async function apiSupervisionThread(workspaceId: string, conversationId: string, getToken: GetToken, signal?: AbortSignal) {
  return supervisionThreadSchema.parse(await (await request(`${conversationPath(workspaceId, conversationId)}/messages`, getToken, signal)).json());
}
/** The supervisor answers the customer through the seller's channel; the seller sees it was the supervisor. */
export async function apiSupervisionReply(workspaceId: string, conversationId: string, text: string, getToken: GetToken) {
  return messageSchema.parse(await (await request(`${conversationPath(workspaceId, conversationId)}/messages`, getToken, undefined, { body: text })).json());
}
export async function apiSupervisionMedia(workspaceId: string, conversationId: string, messageId: string, getToken: GetToken, signal?: AbortSignal) {
  return (await request(`${conversationPath(workspaceId, conversationId)}/messages/${encodeURIComponent(messageId)}/media`, getToken, signal)).blob();
}
export async function apiSupervisionPreview(workspaceId: string, conversationId: string, messageId: string, page: number, getToken: GetToken, signal?: AbortSignal): Promise<{ imageUrl: string; pages: number }> {
  return (await request(`${conversationPath(workspaceId, conversationId)}/messages/${encodeURIComponent(messageId)}/preview?page=${page}`, getToken, signal)).json();
}
