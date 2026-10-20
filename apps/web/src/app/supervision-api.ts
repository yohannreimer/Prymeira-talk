import { aiAgentImprovementSchema, messageSchema, supervisionPageSchema, supervisionSummarySchema, supervisionThreadSchema, supervisionFollowupWeeksSchema, type SupervisionUnreadPeriod } from "@prymeira-talk/shared";
import { readConfigValue } from "./runtime-config";

const apiUrl = readConfigValue("VITE_API_URL") ?? "http://localhost:3002";
type GetToken = () => Promise<string | null>;
export type SupervisionFilter = {
  /** Operator-published week; latest selects the newest authorized publication. */
  followupWeek?: string;
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
export async function apiSupervisionFollowupWeeks(filters: SupervisionFilter, getToken: GetToken, signal?: AbortSignal) {
  const query = new URLSearchParams();
  if (filters.followupWeek && filters.followupWeek !== "latest") query.set("weekId", filters.followupWeek);
  if (filters.sellerCustomerId) query.set("sellerCustomerId", filters.sellerCustomerId);
  if (filters.search?.trim()) query.set("search", filters.search.trim());
  return supervisionFollowupWeeksSchema.parse(await (await request(`/supervision/followup-weeks?${query}`, getToken, signal)).json());
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
  campaigns?: { today: number; yesterday: number };
  acks: { pending: number; sent: number; delivered: number; read: number; failed: number };
  history: { status: string | null; completedAt: string | null };
  level: PlatformHealthLevel; issues: Array<{ level: Exclude<PlatformHealthLevel, "ok">; text: string }>;
};
/** The product owner's health board of every customer's numbers (Hub admins only). */
export async function apiPlatformHealth(getToken: GetToken, signal?: AbortSignal) {
  return await (await request("/supervision/admin/health", getToken, signal)).json() as { generatedAt: string; channels: PlatformHealthChannel[] };
}

/* ---------- The weekly evaluation of each customer's new attendance agent (Hub admins only) ---------- */

export type AgentEvaluationCase = {
  followupId: string;
  conversationId: string;
  /** The workspace of the conversation: a customer may run the agent in several. */
  workspaceId?: string;
  decididoEm: string;
  rotulo: "aprovado" | "editado" | "descartado" | "respondeu" | "sem_resposta";
  rascunho: string | null;
  enviado: string | null;
  resposta: string | null;
  ultimas: Array<{ autor: string; texto: string }>;
  erro?: { tipo: "nao_devia" | "assunto" | "texto" | "nenhum"; explicacao: string };
};
export type AgentEvaluationProposal = {
  id: string;
  regra: string;
  porque: string;
  casos: string[];
  validacao: { corrige: number; erradosTestados: number; quebra: number; bonsTestados: number } | null;
  status: "pendente" | "aprovada" | "recusada";
  decididaEm?: string;
};
export type AgentEvaluation = {
  id: string;
  clientKey: string;
  periodStart: string;
  periodEnd: string;
  status: "running" | "ready" | "failed";
  summary: {
    rotulos: Record<AgentEvaluationCase["rotulo"], number>;
    aprovacao: number | null;
    resposta: number | null;
    erros: { nao_devia: number; assunto: number; texto: number };
    decisoes: { mensagem: number; lembrete: number; nada: number };
  } | null;
  cases: AgentEvaluationCase[];
  proposals: AgentEvaluationProposal[];
  rules: string[];
  error: string | null;
  createdAt: string;
};
/** A customer and the agents it runs, one per workspace. */
export type EvaluationClient = {
  key: string;
  name: string;
  agents: Array<{ workspaceId: string; workspaceName: string | null; agentId: string; agentName: string; channels: number }>;
  rules: string[];
  latest: { periodStart: string; status: AgentEvaluation["status"] } | null;
  pendingProposals: number;
  pendingImprovements: number;
};
const evaluationPath = (clientKey: string) => `/supervision/admin/agent-evaluations/${encodeURIComponent(clientKey)}`;
export async function apiEvaluationClients(getToken: GetToken, signal?: AbortSignal) {
  return ((await (await request("/supervision/admin/agent-evaluations", getToken, signal)).json()) as { clients: EvaluationClient[] }).clients;
}
export async function apiClientEvaluations(clientKey: string, getToken: GetToken, signal?: AbortSignal) {
  return ((await (await request(evaluationPath(clientKey), getToken, signal)).json()) as { evaluations: AgentEvaluation[] }).evaluations;
}
/** Starts the evaluation of the last 7 days; it takes minutes and the page reloads the list meanwhile. */
export async function apiRunClientEvaluation(clientKey: string, getToken: GetToken) {
  return await (await request(`${evaluationPath(clientKey)}/run`, getToken, undefined, {})).json() as { started: boolean };
}
export async function apiDecideClientProposal(clientKey: string, evaluationId: string, proposalId: string, decision: "approve" | "reject", getToken: GetToken) {
  return await (await request(`${evaluationPath(clientKey)}/proposals`, getToken, undefined, { evaluationId, proposalId, decision })).json() as AgentEvaluation;
}
export async function apiRemoveClientRule(clientKey: string, rule: string, getToken: GetToken) {
  return await (await request(`${evaluationPath(clientKey)}/rules/remove`, getToken, undefined, { rule })).json() as { rules: string[] };
}

/* The suggestions learned from hand-overs, for every workspace of a customer. An approved one goes to all of them. */
const improvementPath = (clientKey: string, improvementId: string) => `/supervision/admin/agent-improvements/${encodeURIComponent(clientKey)}/${encodeURIComponent(improvementId)}`;
export async function apiClientImprovements(clientKey: string, getToken: GetToken, signal?: AbortSignal) {
  const body = await (await request(`/supervision/admin/agent-improvements/${encodeURIComponent(clientKey)}`, getToken, signal)).json() as { improvements: unknown[] };
  return body.improvements.map(item => aiAgentImprovementSchema.parse(item));
}
export async function apiUpdateClientImprovement(clientKey: string, improvementId: string, body: Partial<{ title: string; content: string; reject: true; clarificationAnswers: Record<string, string> }>, getToken: GetToken) {
  return aiAgentImprovementSchema.parse(await (await request(`${improvementPath(clientKey, improvementId)}/update`, getToken, undefined, body)).json());
}
export async function apiNormalizeClientImprovement(clientKey: string, improvementId: string, getToken: GetToken) {
  return aiAgentImprovementSchema.parse(await (await request(`${improvementPath(clientKey, improvementId)}/normalize`, getToken, undefined, {})).json());
}
export async function apiApproveClientImprovement(clientKey: string, improvementId: string, body: Partial<{ title: string; content: string }>, getToken: GetToken) {
  return aiAgentImprovementSchema.parse(await (await request(`${improvementPath(clientKey, improvementId)}/approve`, getToken, undefined, body)).json());
}
