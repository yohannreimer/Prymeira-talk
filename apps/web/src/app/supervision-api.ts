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
/** "Não precisa responder": the customer leaves the waiting queue until they write again (`false` undoes it). */
export async function apiSupervisionDismissWaiting(workspaceId: string, conversationId: string, dismissed: boolean, getToken: GetToken) {
  return await (await request(`${conversationPath(workspaceId, conversationId)}/waiting`, getToken, undefined, { dismissed })).json() as { dismissed: boolean };
}
export async function apiSupervisionMedia(workspaceId: string, conversationId: string, messageId: string, getToken: GetToken, signal?: AbortSignal) {
  return (await request(`${conversationPath(workspaceId, conversationId)}/messages/${encodeURIComponent(messageId)}/media`, getToken, signal)).blob();
}
export async function apiSupervisionPreview(workspaceId: string, conversationId: string, messageId: string, page: number, getToken: GetToken, signal?: AbortSignal): Promise<{ imageUrl: string; pages: number }> {
  return (await request(`${conversationPath(workspaceId, conversationId)}/messages/${encodeURIComponent(messageId)}/preview?page=${page}`, getToken, signal)).json();
}

export type PlatformHealthLevel = "ok" | "warning" | "critical";
export type PlatformHealthConnection = {
  provider: "evolution" | "waha"; status: string; health: string; eligible: boolean; verifiedPhone: string | null;
  lastError: string | null; lastHealthyAt: string | null; lastCheckedAt: string | null; consecutiveFailures: number;
  lastEventAt: string | null; events1h: number;
};
export type PlatformHealthChannel = {
  workspaceId: string; workspaceName: string | null; channelId: string; name: string; phone: string | null; status: string;
  connections: PlatformHealthConnection[];
  traffic: { lastInboundAt: string | null; lastOutboundAt: string | null; inbound1h: number; inbound24h: number; outbound24h: number };
  acks: { pending: number; sent: number; delivered: number; read: number; failed: number };
  history: { status: string | null; completedAt: string | null };
  level: PlatformHealthLevel; issues: Array<{ level: Exclude<PlatformHealthLevel, "ok">; text: string }>;
};
/** The product owner's health board of every customer's numbers (Hub admins only). */
export async function apiPlatformHealth(getToken: GetToken, signal?: AbortSignal) {
  return await (await request("/supervision/admin/health", getToken, signal)).json() as { generatedAt: string; channels: PlatformHealthChannel[] };
}
