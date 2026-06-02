import {
  contactBoardMembershipSchema,
  contactBoardSchema,
  contactBoardStageSchema,
  channelOperationResultSchema,
  channelQrResultSchema,
  channelSchema,
  channelTestInboundResultSchema,
  contactSchema,
  conversationSchema,
  messageSchema,
  type ChannelDto,
  type ChannelOperationResultDto,
  type ChannelQrResultDto,
  type ChannelTestInboundResultDto,
  type ContactBoardDto,
  type ContactBoardMembershipDto,
  type ContactBoardStageDto,
  type ContactDto,
  type ConversationDto,
  type MessageDto
} from "@prymeira-talk/shared";
import { readConfigValue } from "./runtime-config";

const apiUrl = readConfigValue("VITE_API_URL") ?? "http://localhost:3002";
const localAuthBypass = readConfigValue("VITE_LOCAL_AUTH_BYPASS") === "true";

export interface ContactBoardWithStagesDto extends ContactBoardDto {
  stages: ContactBoardStageDto[];
}

export interface BoardContactCardDto extends ContactBoardMembershipDto {
  contact: ContactDto;
}

export interface BoardContactsDto {
  board: ContactBoardDto;
  stages: ContactBoardStageDto[];
  memberships: BoardContactCardDto[];
}

export interface BoardDeleteResultDto {
  ok: true;
  boardId: string;
}

export interface BoardStageDeleteResultDto {
  ok: true;
  stageId: string;
}

export interface BoardMembershipDeleteResultDto {
  ok: true;
  membershipId: string;
  boardId: string;
  contactId: string;
}

export interface ContactContextDto {
  primaryBoardStage: {
    membershipId: string;
    boardId: string;
    boardName: string;
    stageId: string;
    stageName: string;
    stageColor: string;
  } | null;
  tags: Array<{
    id: string;
    name: string;
    color: string;
  }>;
  notes: Array<{
    id: string;
    body: string;
    createdAt: string;
    createdByName: string | null;
  }>;
  departments: Array<{
    id: string;
    name: string;
  }>;
  boardStages: Array<{
    id: string;
    boardId: string;
    boardName: string;
    name: string;
    color: string;
    order: number;
  }>;
}

export type ConversationActionBody =
  | { action: "add_note"; body: string }
  | { action: "assign_current_user" }
  | { action: "change_department"; departmentId: string | null }
  | { action: "change_priority"; priority: ConversationDto["priority"] }
  | { action: "change_primary_board_stage"; stageId: string }
  | { action: "add_tag"; name: string }
  | { action: "remove_tag"; tagId: string }
  | { action: "request_ai_suggestion" }
  | { action: "create_crm_note" }
  | { action: "close_conversation" };

export interface ConversationActionResultDto {
  conversation: ConversationDto;
  context: ContactContextDto;
  aiSuggestion?: string;
  crmAction?: {
    id: string;
    status: string;
  };
}

export type AutomationStatus = "enabled" | "disabled";

export interface AutomationActionDto {
  type: string;
  label?: string;
  config?: Record<string, unknown>;
}

export type AutomationActionsDto = AutomationActionDto[] | Record<string, unknown>;

export interface AutomationRuleDto {
  id: string;
  workspaceId: string;
  name: string;
  status: AutomationStatus;
  trigger: string;
  conditions: unknown;
  actions: AutomationActionsDto;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationRunDto {
  id: string;
  workspaceId: string;
  ruleId: string;
  eventKey: string;
  status: string;
  input: unknown;
  result: unknown;
  createdAt: string;
  updatedAt: string;
}

export type CampaignStatus = "draft" | "scheduled" | "sending" | "completed" | "failed";

export interface CampaignAudienceDto {
  type: "board" | "imported";
  boardId?: string;
  stageId?: string;
  rows?: Array<{
    name?: string;
    phone: string;
    fields?: Record<string, string>;
  }>;
}

export interface CampaignCadenceDto {
  minDelaySeconds: number;
  maxDelaySeconds: number;
  batchSize: number;
  pauseMinSeconds: number;
  pauseMaxSeconds: number;
  windowStart?: string;
  windowEnd?: string;
}

export interface CampaignDto {
  id: string;
  workspaceId: string;
  name: string;
  status: CampaignStatus;
  audience: CampaignAudienceDto;
  messageBody: string;
  templates: string[];
  fallbackName: string;
  cadence: CampaignCadenceDto;
  scheduledAt: string | null;
  mode: "simulated" | "real";
  createdAt: string;
  updatedAt: string;
}

export interface CampaignAudienceContactDto {
  contactId: string | null;
  audienceKey: string;
  name: string | null;
  phone: string;
  fields: Record<string, string>;
}

export interface CampaignRecipientDto {
  id: string;
  workspaceId: string;
  campaignId: string;
  contactId: string | null;
  audienceKey: string | null;
  providerMessageId: string | null;
  status: string;
  result: unknown;
  contactSnapshot: unknown;
  scheduledAt: string | null;
  sentAt: string | null;
  attempts: number;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  contactName: string | null;
  contactPhone: string | null;
}

export interface CampaignSendResultDto {
  mode: "simulated" | "real";
  result: "queued_simulated" | "sent";
  recipientsCreated: number;
  recipientsSent?: number;
  recipientsFailed?: number;
}

export interface ReportMetricDto {
  key: string;
  label: string;
  value: number;
  helper?: string;
}

export interface ReportTimeSeriesPointDto {
  date: string;
  conversations: number;
  inboundMessages: number;
  outboundMessages: number;
}

export type ReportPeriodPresetDto = "today" | "7d" | "30d" | "month" | "custom";

export interface ReportFiltersDto {
  preset: ReportPeriodPresetDto;
  startDate: string | null;
  endDate: string | null;
  status?: "open" | "pending" | "closed";
  channelId?: string;
  departmentId?: string;
}

export interface ReportsOverviewDto {
  filters: ReportFiltersDto;
  cards: ReportMetricDto[];
  conversationsByStatus: ReportMetricDto[];
  messagesByDirection: ReportMetricDto[];
  campaignResults: ReportMetricDto[];
  automationRuns: ReportMetricDto[];
  timeSeries: ReportTimeSeriesPointDto[];
  breakdowns: {
    departments: ReportMetricDto[];
    tags: ReportMetricDto[];
    channels: ReportMetricDto[];
  };
}

export type TeamUserRole = "owner" | "manager" | "agent";
export type IntegrationModeDto = "simulated" | "real";

export interface MetaCloudSettingsPayload {
  enabled: boolean;
  wabaId?: string;
  phoneNumberId?: string;
  accessToken?: string;
  webhookVerifyToken?: string;
  appSecret?: string;
}

export interface TeamUserDto {
  id: string;
  workspaceId: string;
  clerkUserId: string;
  role: TeamUserRole;
  displayName: string;
  avatarUrl: string | null;
  presenceState: string;
  createdAt: string;
  updatedAt: string;
}

export interface TeamDepartmentDto {
  id: string;
  workspaceId: string;
  name: string;
  routingOrder: number;
  createdAt: string;
  updatedAt: string;
}

export type AssistantActionType = "summary" | "suggested_reply";

export interface AssistantActionDto {
  id: string;
  workspaceId: string;
  conversationId: string | null;
  contactId: string | null;
  userId: string | null;
  actionType: AssistantActionType | string;
  mode: IntegrationModeDto;
  input: unknown;
  result: unknown;
  status: string;
  createdAt: string;
}

export interface CrmSyncActionDto {
  id: string;
  workspaceId: string;
  contactId: string | null;
  actionType: string;
  mode: IntegrationModeDto;
  status: string;
  payload: unknown;
  result: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceSettingsDto {
  workspaceId: string;
  name: string | null;
  plan: string | null;
  limits: unknown;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface IntegrationConfigDto {
  id: string;
  workspaceId: string;
  provider: string;
  mode: IntegrationModeDto;
  status: string;
  settings: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface SettingsDto {
  workspace: WorkspaceSettingsDto;
  integrations: IntegrationConfigDto[];
}

export interface AuditLogDto {
  id: string;
  workspaceId: string;
  actorUserId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  metadata: unknown;
  createdAt: string;
}

export interface QuickReplyDto {
  id: string;
  workspaceId: string;
  title: string;
  body: string;
  category: string | null;
  createdAt: string;
  updatedAt: string;
}

async function getRequiredToken(getToken: () => Promise<string | null>) {
  const token = await getToken();

  if (!token && localAuthBypass) {
    return "local-dev-bypass";
  }

  if (!token) {
    throw new Error("Missing Clerk auth token.");
  }

  return token;
}

function asRecord(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
}

function parseBoardWithStages(data: unknown): ContactBoardWithStagesDto {
  const board = contactBoardSchema.parse(data);

  return {
    ...board,
    stages: contactBoardStageSchema.array().parse(
      typeof data === "object" && data !== null && "stages" in data ? data.stages : []
    )
  };
}

function parseBoardContactCard(data: unknown): BoardContactCardDto {
  const membership = contactBoardMembershipSchema.parse(data);

  return {
    ...membership,
    contact: contactSchema.parse(
      typeof data === "object" && data !== null && "contact" in data ? data.contact : null
    )
  };
}

function parseBoardContacts(data: unknown): BoardContactsDto {
  const payload = data as {
    board?: unknown;
    stages?: unknown;
    memberships?: unknown;
  };

  return {
    board: contactBoardSchema.parse(payload.board),
    stages: contactBoardStageSchema.array().parse(payload.stages),
    memberships: Array.isArray(payload.memberships)
      ? payload.memberships.map(parseBoardContactCard)
      : []
  };
}

function parseBoardDeleteResult(data: unknown): BoardDeleteResultDto {
  const payload = data as { ok?: unknown; boardId?: unknown };

  if (payload.ok !== true || typeof payload.boardId !== "string") {
    throw new Error("Invalid board delete response.");
  }

  return { ok: true, boardId: payload.boardId };
}

function parseBoardStageDeleteResult(data: unknown): BoardStageDeleteResultDto {
  const payload = data as { ok?: unknown; stageId?: unknown };

  if (payload.ok !== true || typeof payload.stageId !== "string") {
    throw new Error("Invalid board stage delete response.");
  }

  return { ok: true, stageId: payload.stageId };
}

function parseBoardMembershipDeleteResult(data: unknown): BoardMembershipDeleteResultDto {
  const payload = data as {
    ok?: unknown;
    membershipId?: unknown;
    boardId?: unknown;
    contactId?: unknown;
  };

  if (
    payload.ok !== true ||
    typeof payload.membershipId !== "string" ||
    typeof payload.boardId !== "string" ||
    typeof payload.contactId !== "string"
  ) {
    throw new Error("Invalid board membership delete response.");
  }

  return {
    ok: true,
    membershipId: payload.membershipId,
    boardId: payload.boardId,
    contactId: payload.contactId
  };
}

function parseContactContext(data: unknown): ContactContextDto {
  const payload = data as ContactContextDto;

  return {
    primaryBoardStage: payload.primaryBoardStage ?? null,
    tags: Array.isArray(payload.tags) ? payload.tags : [],
    notes: Array.isArray(payload.notes) ? payload.notes : [],
    departments: Array.isArray(payload.departments) ? payload.departments : [],
    boardStages: Array.isArray(payload.boardStages) ? payload.boardStages : []
  };
}

function parseQuickReply(payload: unknown): QuickReplyDto {
  const record = asRecord(payload);
  return {
    id: String(record.id ?? ""),
    workspaceId: String(record.workspaceId ?? ""),
    title: String(record.title ?? ""),
    body: String(record.body ?? ""),
    category: typeof record.category === "string" ? record.category : null,
    createdAt: String(record.createdAt ?? ""),
    updatedAt: String(record.updatedAt ?? "")
  };
}

function parseConversationActionResult(data: unknown): ConversationActionResultDto {
  const payload = data as {
    conversation?: unknown;
    context?: unknown;
    aiSuggestion?: unknown;
    crmAction?: unknown;
  };
  const crmAction = payload.crmAction as ConversationActionResultDto["crmAction"] | undefined;

  return {
    conversation: conversationSchema.parse(payload.conversation),
    context: parseContactContext(payload.context),
    ...(typeof payload.aiSuggestion === "string" ? { aiSuggestion: payload.aiSuggestion } : {}),
    ...(crmAction ? { crmAction } : {})
  };
}

function parseAutomationAction(data: unknown): AutomationActionDto {
  const payload = data as {
    type?: unknown;
    label?: unknown;
    config?: unknown;
  };

  return {
    type: typeof payload.type === "string" ? payload.type : "local_action",
    ...(typeof payload.label === "string" ? { label: payload.label } : {}),
    ...(payload.config && typeof payload.config === "object"
      ? { config: payload.config as Record<string, unknown> }
      : {})
  };
}

function parseAutomationActions(data: unknown): AutomationActionsDto {
  if (Array.isArray(data)) {
    return data.map(parseAutomationAction);
  }

  if (data && typeof data === "object") {
    return data as Record<string, unknown>;
  }

  return [];
}

function parseAutomationRule(data: unknown): AutomationRuleDto {
  const payload = data as AutomationRuleDto;

  return {
    id: payload.id,
    workspaceId: payload.workspaceId,
    name: payload.name,
    status: payload.status === "enabled" ? "enabled" : "disabled",
    trigger: payload.trigger,
    conditions: payload.conditions ?? {},
    actions: parseAutomationActions(payload.actions),
    createdAt: payload.createdAt,
    updatedAt: payload.updatedAt
  };
}

function parseAutomationRun(data: unknown): AutomationRunDto {
  const payload = data as AutomationRunDto;

  return {
    id: payload.id,
    workspaceId: payload.workspaceId,
    ruleId: payload.ruleId,
    eventKey: payload.eventKey,
    status: payload.status,
    input: payload.input ?? {},
    result: payload.result ?? {},
    createdAt: payload.createdAt,
    updatedAt: payload.updatedAt
  };
}

function parseCampaignAudience(data: unknown): CampaignAudienceDto {
  const payload = data as {
    type?: unknown;
    boardId?: unknown;
    stageId?: unknown;
    rows?: unknown;
  };

  if (payload.type === "imported") {
    return {
      type: "imported",
      rows: Array.isArray(payload.rows)
        ? payload.rows.map((row) => {
            const importedRow = row as { name?: unknown; phone?: unknown; fields?: unknown };
            return {
              ...(typeof importedRow.name === "string" ? { name: importedRow.name } : {}),
              phone: typeof importedRow.phone === "string" ? importedRow.phone : "",
              fields:
                importedRow.fields && typeof importedRow.fields === "object"
                  ? Object.fromEntries(
                      Object.entries(importedRow.fields as Record<string, unknown>).map(([key, value]) => [
                        key,
                        value == null ? "" : String(value)
                      ])
                    )
                  : {}
            };
          })
        : []
    };
  }

  return {
    type: "board",
    boardId: typeof payload.boardId === "string" ? payload.boardId : "",
    ...(typeof payload.stageId === "string" ? { stageId: payload.stageId } : {})
  };
}

function parseCampaignCadence(data: unknown): CampaignCadenceDto {
  const payload = data as Partial<CampaignCadenceDto>;

  return {
    minDelaySeconds: Number(payload?.minDelaySeconds ?? 30),
    maxDelaySeconds: Number(payload?.maxDelaySeconds ?? 90),
    batchSize: Number(payload?.batchSize ?? 25),
    pauseMinSeconds: Number(payload?.pauseMinSeconds ?? 300),
    pauseMaxSeconds: Number(payload?.pauseMaxSeconds ?? 900),
    ...(typeof payload?.windowStart === "string" ? { windowStart: payload.windowStart } : {}),
    ...(typeof payload?.windowEnd === "string" ? { windowEnd: payload.windowEnd } : {})
  };
}

function parseCampaign(data: unknown): CampaignDto {
  const payload = data as CampaignDto;

  return {
    id: payload.id,
    workspaceId: payload.workspaceId,
    name: payload.name,
    status: payload.status,
    audience: parseCampaignAudience(payload.audience),
    messageBody: payload.messageBody,
    templates: Array.isArray(payload.templates) ? payload.templates : [payload.messageBody],
    fallbackName: typeof payload.fallbackName === "string" ? payload.fallbackName : "cliente",
    cadence: parseCampaignCadence(payload.cadence),
    scheduledAt: payload.scheduledAt,
    mode: payload.mode === "real" ? "real" : "simulated",
    createdAt: payload.createdAt,
    updatedAt: payload.updatedAt
  };
}

function parseCampaignAudienceContact(data: unknown): CampaignAudienceContactDto {
  const payload = data as CampaignAudienceContactDto;

  return {
    contactId: payload.contactId ?? null,
    audienceKey: payload.audienceKey ?? payload.contactId ?? payload.phone,
    name: payload.name ?? null,
    phone: payload.phone,
    fields: payload.fields ?? {}
  };
}

function parseCampaignRecipient(data: unknown): CampaignRecipientDto {
  const payload = data as CampaignRecipientDto;

  return {
    id: payload.id,
    workspaceId: payload.workspaceId,
    campaignId: payload.campaignId,
    contactId: payload.contactId ?? null,
    audienceKey: payload.audienceKey ?? null,
    providerMessageId: payload.providerMessageId ?? null,
    status: payload.status,
    result: payload.result ?? {},
    contactSnapshot: payload.contactSnapshot ?? {},
    scheduledAt: payload.scheduledAt ?? null,
    sentAt: payload.sentAt ?? null,
    attempts: Number(payload.attempts ?? 0),
    errorMessage: payload.errorMessage ?? null,
    createdAt: payload.createdAt,
    updatedAt: payload.updatedAt,
    contactName: payload.contactName ?? null,
    contactPhone: payload.contactPhone ?? null
  };
}

function parseCampaignSendResult(data: unknown): CampaignSendResultDto {
  const payload = data as CampaignSendResultDto;

  return {
    mode: payload.mode === "real" ? "real" : "simulated",
    result: payload.result === "sent" ? "sent" : "queued_simulated",
    recipientsCreated: Number(payload.recipientsCreated ?? 0),
    recipientsSent: Number(payload.recipientsSent ?? 0),
    recipientsFailed: Number(payload.recipientsFailed ?? 0)
  };
}

function parseReportMetric(data: unknown): ReportMetricDto {
  const payload = data as ReportMetricDto;

  return {
    key: String(payload.key ?? ""),
    label: String(payload.label ?? payload.key ?? ""),
    value: Number(payload.value ?? 0),
    ...(typeof payload.helper === "string" ? { helper: payload.helper } : {})
  };
}

function parseReportTimeSeriesPoint(data: unknown): ReportTimeSeriesPointDto {
  const payload = data as ReportTimeSeriesPointDto;

  return {
    date: String(payload.date ?? ""),
    conversations: Number(payload.conversations ?? 0),
    inboundMessages: Number(payload.inboundMessages ?? 0),
    outboundMessages: Number(payload.outboundMessages ?? 0)
  };
}

function parseReportFilters(data: unknown): ReportFiltersDto {
  const payload = data as Partial<ReportFiltersDto>;
  const preset = ["today", "7d", "30d", "month", "custom"].includes(String(payload?.preset))
    ? payload?.preset as ReportPeriodPresetDto
    : "30d";

  return {
    preset,
    startDate: typeof payload?.startDate === "string" ? payload.startDate : null,
    endDate: typeof payload?.endDate === "string" ? payload.endDate : null,
    ...(payload?.status === "open" || payload?.status === "pending" || payload?.status === "closed"
      ? { status: payload.status }
      : {}),
    ...(typeof payload?.channelId === "string" ? { channelId: payload.channelId } : {}),
    ...(typeof payload?.departmentId === "string" ? { departmentId: payload.departmentId } : {})
  };
}

function parseReportsOverview(data: unknown): ReportsOverviewDto {
  const payload = data as ReportsOverviewDto;
  const breakdowns = payload.breakdowns ?? {
    departments: [],
    tags: [],
    channels: []
  };

  return {
    filters: parseReportFilters(payload.filters),
    cards: Array.isArray(payload.cards) ? payload.cards.map(parseReportMetric) : [],
    conversationsByStatus: Array.isArray(payload.conversationsByStatus)
      ? payload.conversationsByStatus.map(parseReportMetric)
      : [],
    messagesByDirection: Array.isArray(payload.messagesByDirection)
      ? payload.messagesByDirection.map(parseReportMetric)
      : [],
    campaignResults: Array.isArray(payload.campaignResults)
      ? payload.campaignResults.map(parseReportMetric)
      : [],
    automationRuns: Array.isArray(payload.automationRuns)
      ? payload.automationRuns.map(parseReportMetric)
      : [],
    timeSeries: Array.isArray(payload.timeSeries)
      ? payload.timeSeries.map(parseReportTimeSeriesPoint)
      : [],
    breakdowns: {
      departments: Array.isArray(breakdowns.departments)
        ? breakdowns.departments.map(parseReportMetric)
        : [],
      tags: Array.isArray(breakdowns.tags) ? breakdowns.tags.map(parseReportMetric) : [],
      channels: Array.isArray(breakdowns.channels)
        ? breakdowns.channels.map(parseReportMetric)
        : []
    }
  };
}

function parseTeamUser(data: unknown): TeamUserDto {
  const payload = data as TeamUserDto;

  return {
    id: String(payload.id ?? ""),
    workspaceId: String(payload.workspaceId ?? ""),
    clerkUserId: String(payload.clerkUserId ?? ""),
    role: payload.role === "owner" || payload.role === "manager" ? payload.role : "agent",
    displayName: String(payload.displayName ?? ""),
    avatarUrl: typeof payload.avatarUrl === "string" ? payload.avatarUrl : null,
    presenceState: String(payload.presenceState ?? "offline"),
    createdAt: String(payload.createdAt ?? ""),
    updatedAt: String(payload.updatedAt ?? "")
  };
}

function parseTeamDepartment(data: unknown): TeamDepartmentDto {
  const payload = data as TeamDepartmentDto;

  return {
    id: String(payload.id ?? ""),
    workspaceId: String(payload.workspaceId ?? ""),
    name: String(payload.name ?? ""),
    routingOrder: Number(payload.routingOrder ?? 0),
    createdAt: String(payload.createdAt ?? ""),
    updatedAt: String(payload.updatedAt ?? "")
  };
}

function parseAssistantAction(data: unknown): AssistantActionDto {
  const payload = data as AssistantActionDto;

  return {
    id: String(payload.id ?? ""),
    workspaceId: String(payload.workspaceId ?? ""),
    conversationId: typeof payload.conversationId === "string" ? payload.conversationId : null,
    contactId: typeof payload.contactId === "string" ? payload.contactId : null,
    userId: typeof payload.userId === "string" ? payload.userId : null,
    actionType: String(payload.actionType ?? ""),
    mode: payload.mode === "real" ? "real" : "simulated",
    input: payload.input ?? {},
    result: payload.result ?? {},
    status: String(payload.status ?? ""),
    createdAt: String(payload.createdAt ?? "")
  };
}

function parseCrmSyncAction(data: unknown): CrmSyncActionDto {
  const payload = data as CrmSyncActionDto;

  return {
    id: String(payload.id ?? ""),
    workspaceId: String(payload.workspaceId ?? ""),
    contactId: typeof payload.contactId === "string" ? payload.contactId : null,
    actionType: String(payload.actionType ?? ""),
    mode: payload.mode === "real" ? "real" : "simulated",
    status: String(payload.status ?? ""),
    payload: payload.payload ?? {},
    result: payload.result ?? {},
    createdAt: String(payload.createdAt ?? ""),
    updatedAt: String(payload.updatedAt ?? "")
  };
}

function parseIntegrationConfig(data: unknown): IntegrationConfigDto {
  const payload = data as IntegrationConfigDto;

  return {
    id: String(payload.id ?? ""),
    workspaceId: String(payload.workspaceId ?? ""),
    provider: String(payload.provider ?? ""),
    mode: payload.mode === "real" ? "real" : "simulated",
    status: String(payload.status ?? ""),
    settings: payload.settings ?? {},
    createdAt: String(payload.createdAt ?? ""),
    updatedAt: String(payload.updatedAt ?? "")
  };
}

function parseSettings(data: unknown): SettingsDto {
  const payload = data as SettingsDto;
  const workspace = payload.workspace ?? ({} as WorkspaceSettingsDto);

  return {
    workspace: {
      workspaceId: String(workspace.workspaceId ?? ""),
      name: typeof workspace.name === "string" ? workspace.name : null,
      plan: typeof workspace.plan === "string" ? workspace.plan : null,
      limits: workspace.limits ?? {},
      createdAt: typeof workspace.createdAt === "string" ? workspace.createdAt : null,
      updatedAt: typeof workspace.updatedAt === "string" ? workspace.updatedAt : null
    },
    integrations: Array.isArray(payload.integrations)
      ? payload.integrations.map(parseIntegrationConfig)
      : []
  };
}

function parseAuditLog(data: unknown): AuditLogDto {
  const payload = data as AuditLogDto;

  return {
    id: String(payload.id ?? ""),
    workspaceId: String(payload.workspaceId ?? ""),
    actorUserId: typeof payload.actorUserId === "string" ? payload.actorUserId : null,
    action: String(payload.action ?? ""),
    targetType: String(payload.targetType ?? ""),
    targetId: typeof payload.targetId === "string" ? payload.targetId : null,
    metadata: payload.metadata ?? {},
    createdAt: String(payload.createdAt ?? "")
  };
}

async function fetchJson<T>(
  getToken: () => Promise<string | null>,
  path: string,
  options: RequestInit,
  parse: (data: unknown) => T,
  errorLabel: string
): Promise<T> {
  const token = await getRequiredToken(getToken);

  const response = await fetch(`${apiUrl}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers
    }
  });

  if (!response.ok) {
    throw new Error(await readApiErrorMessage(response, errorLabel));
  }

  return parse(await response.json());
}

export async function readApiErrorMessage(response: Response, fallbackLabel: string) {
  try {
    const data = await response.clone().json() as unknown;

    if (data && typeof data === "object" && "error" in data) {
      const error = (data as { error?: unknown }).error;

      if (typeof error === "string" && error.trim().length > 0) {
        return error;
      }
    }
  } catch {
    // Non-JSON error bodies fall back to the HTTP status message.
  }

  return `${fallbackLabel}: ${response.status}`;
}

export async function apiGetConversations(
  getToken: () => Promise<string | null>
): Promise<ConversationDto[]> {
  const token = await getRequiredToken(getToken);

  const response = await fetch(`${apiUrl}/conversations`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to load conversations: ${response.status}`);
  }

  const data = await response.json();
  return conversationSchema.array().parse(data);
}

export async function apiGetContacts(
  getToken: () => Promise<string | null>,
  search?: string
): Promise<ContactDto[]> {
  const token = await getRequiredToken(getToken);

  const url = new URL(`${apiUrl}/contacts`);
  if (search?.trim()) {
    url.searchParams.set("search", search.trim());
  }

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to load contacts: ${response.status}`);
  }

  const data = await response.json();
  return contactSchema.array().parse(data);
}

export async function apiCreateContact(
  getToken: () => Promise<string | null>,
  body: {
    name?: string;
    phone: string;
    email?: string;
    company?: string;
  }
): Promise<ContactDto> {
  const token = await getRequiredToken(getToken);

  const response = await fetch(`${apiUrl}/contacts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`Failed to create contact: ${response.status}`);
  }

  const data = await response.json();
  return contactSchema.parse(data);
}

export async function apiUpdateContact(
  getToken: () => Promise<string | null>,
  contactId: string,
  body: {
    name?: string;
    phone?: string;
    email?: string;
    company?: string;
  }
): Promise<ContactDto> {
  const token = await getRequiredToken(getToken);

  const response = await fetch(`${apiUrl}/contacts/${contactId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`Failed to update contact: ${response.status}`);
  }

  const data = await response.json();
  return contactSchema.parse(data);
}

export async function apiStartContactConversation(
  getToken: () => Promise<string | null>,
  contactId: string,
  body: {
    channelId: string;
  }
): Promise<ConversationDto> {
  const token = await getRequiredToken(getToken);

  const response = await fetch(`${apiUrl}/contacts/${contactId}/conversations`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(await readApiErrorMessage(response, "Failed to start conversation"));
  }

  const data = await response.json();
  return conversationSchema.parse(data);
}

export async function apiMarkConversationRead(
  getToken: () => Promise<string | null>,
  conversationId: string
): Promise<ConversationDto> {
  return fetchJson(
    getToken,
    `/conversations/${conversationId}/read`,
    { method: "POST" },
    (data) => conversationSchema.parse(data),
    "Failed to mark conversation read"
  );
}

export async function apiGetBoards(
  getToken: () => Promise<string | null>
): Promise<ContactBoardWithStagesDto[]> {
  const token = await getRequiredToken(getToken);

  const response = await fetch(`${apiUrl}/boards`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to load boards: ${response.status}`);
  }

  const data = await response.json();
  return Array.isArray(data) ? data.map(parseBoardWithStages) : [];
}

export async function apiCreateBoard(
  getToken: () => Promise<string | null>,
  body: {
    name: string;
    description?: string;
  }
): Promise<ContactBoardWithStagesDto> {
  return fetchJson(
    getToken,
    "/boards",
    {
      method: "POST",
      body: JSON.stringify(body)
    },
    parseBoardWithStages,
    "Failed to create board"
  );
}

export async function apiUpdateBoard(
  getToken: () => Promise<string | null>,
  boardId: string,
  body: {
    name?: string;
    description?: string;
  }
): Promise<ContactBoardWithStagesDto> {
  return fetchJson(
    getToken,
    `/boards/${boardId}`,
    {
      method: "PATCH",
      body: JSON.stringify(body)
    },
    parseBoardWithStages,
    "Failed to update board"
  );
}

export async function apiDeleteBoard(
  getToken: () => Promise<string | null>,
  boardId: string
): Promise<BoardDeleteResultDto> {
  return fetchJson(
    getToken,
    `/boards/${boardId}`,
    { method: "DELETE" },
    parseBoardDeleteResult,
    "Failed to delete board"
  );
}

export async function apiGetBoardContacts(
  getToken: () => Promise<string | null>,
  boardId: string
): Promise<BoardContactsDto> {
  const token = await getRequiredToken(getToken);

  const response = await fetch(`${apiUrl}/boards/${boardId}/contacts`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to load board contacts: ${response.status}`);
  }

  const data = await response.json();
  return parseBoardContacts(data);
}

export async function apiCreateBoardStage(
  getToken: () => Promise<string | null>,
  boardId: string,
  body: {
    name: string;
    color: string;
    order: number;
  }
): Promise<ContactBoardStageDto> {
  return fetchJson(
    getToken,
    `/boards/${boardId}/stages`,
    {
      method: "POST",
      body: JSON.stringify(body)
    },
    (data) => contactBoardStageSchema.parse(data),
    "Failed to create board stage"
  );
}

export async function apiUpdateBoardStage(
  getToken: () => Promise<string | null>,
  boardId: string,
  stageId: string,
  body: {
    name?: string;
    color?: string;
  }
): Promise<ContactBoardStageDto> {
  return fetchJson(
    getToken,
    `/boards/${boardId}/stages/${stageId}`,
    {
      method: "PATCH",
      body: JSON.stringify(body)
    },
    (data) => contactBoardStageSchema.parse(data),
    "Failed to update board stage"
  );
}

export async function apiReorderBoardStages(
  getToken: () => Promise<string | null>,
  boardId: string,
  stageIds: string[]
): Promise<ContactBoardStageDto[]> {
  return fetchJson(
    getToken,
    `/boards/${boardId}/stages/reorder`,
    {
      method: "PATCH",
      body: JSON.stringify({ stageIds })
    },
    (data) => contactBoardStageSchema.array().parse(data),
    "Failed to reorder board stages"
  );
}

export async function apiDeleteBoardStage(
  getToken: () => Promise<string | null>,
  boardId: string,
  stageId: string
): Promise<BoardStageDeleteResultDto> {
  return fetchJson(
    getToken,
    `/boards/${boardId}/stages/${stageId}`,
    { method: "DELETE" },
    parseBoardStageDeleteResult,
    "Failed to delete board stage"
  );
}

export async function apiAddContactToBoard(
  getToken: () => Promise<string | null>,
  boardId: string,
  body: {
    contactId: string;
    stageId: string;
    isPrimary?: boolean;
  }
): Promise<BoardContactCardDto> {
  const token = await getRequiredToken(getToken);

  const response = await fetch(`${apiUrl}/boards/${boardId}/memberships`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`Failed to add contact to board: ${response.status}`);
  }

  const data = await response.json();
  return parseBoardContactCard(data);
}

export async function apiRemoveBoardMembership(
  getToken: () => Promise<string | null>,
  membershipId: string
): Promise<BoardMembershipDeleteResultDto> {
  return fetchJson(
    getToken,
    `/board-memberships/${membershipId}`,
    { method: "DELETE" },
    parseBoardMembershipDeleteResult,
    "Failed to remove contact from board"
  );
}

export async function apiMoveBoardMembership(
  getToken: () => Promise<string | null>,
  membershipId: string,
  body: {
    stageId: string;
    isPrimary?: boolean;
  }
): Promise<BoardContactCardDto> {
  const token = await getRequiredToken(getToken);

  const response = await fetch(`${apiUrl}/board-memberships/${membershipId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`Failed to move board contact: ${response.status}`);
  }

  const data = await response.json();
  return parseBoardContactCard(data);
}

export async function apiGetChannels(
  getToken: () => Promise<string | null>
): Promise<ChannelDto[]> {
  const token = await getRequiredToken(getToken);

  const response = await fetch(`${apiUrl}/channels`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to load channels: ${response.status}`);
  }

  const data = await response.json();
  return channelSchema.array().parse(data);
}

export async function apiCreateChannel(
  getToken: () => Promise<string | null>,
  body: {
    displayName: string;
    providerKey?: string;
    phoneNumber?: string;
  }
): Promise<ChannelDto> {
  const token = await getRequiredToken(getToken);

  const response = await fetch(`${apiUrl}/channels`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`Failed to create channel: ${response.status}`);
  }

  const data = await response.json();
  return channelSchema.parse(data);
}

export interface DeleteChannelResultDto {
  ok: boolean;
  channelId: string;
}

export async function apiDeleteChannel(
  getToken: () => Promise<string | null>,
  channelId: string
): Promise<DeleteChannelResultDto> {
  const token = await getRequiredToken(getToken);

  const response = await fetch(`${apiUrl}/channels/${channelId}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    throw new Error(await readApiErrorMessage(response, "Failed to delete channel"));
  }

  const data = await response.json() as { ok?: unknown; channelId?: unknown };
  if (
    data.ok !== true ||
    typeof data.channelId !== "string" ||
    data.channelId.trim().length === 0
  ) {
    throw new Error("Invalid delete channel response.");
  }

  return {
    ok: true,
    channelId: data.channelId
  };
}

export async function apiStartChannelQr(
  getToken: () => Promise<string | null>,
  channelId: string
): Promise<ChannelQrResultDto> {
  const token = await getRequiredToken(getToken);

  const response = await fetch(`${apiUrl}/channels/${channelId}/qr`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    throw new Error(await readApiErrorMessage(response, "Failed to start channel QR"));
  }

  const data = await response.json();
  return channelQrResultSchema.parse(data);
}

export async function apiReconnectChannel(
  getToken: () => Promise<string | null>,
  channelId: string
): Promise<ChannelOperationResultDto> {
  const token = await getRequiredToken(getToken);

  const response = await fetch(`${apiUrl}/channels/${channelId}/reconnect`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to reconnect channel: ${response.status}`);
  }

  const data = await response.json();
  return channelOperationResultSchema.parse(data);
}

export async function apiDisconnectChannel(
  getToken: () => Promise<string | null>,
  channelId: string
): Promise<ChannelOperationResultDto> {
  const token = await getRequiredToken(getToken);

  const response = await fetch(`${apiUrl}/channels/${channelId}/disconnect`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to disconnect channel: ${response.status}`);
  }

  const data = await response.json();
  return channelOperationResultSchema.parse(data);
}

export async function apiCreateTestInbound(
  getToken: () => Promise<string | null>,
  channelId: string
): Promise<ChannelTestInboundResultDto> {
  const token = await getRequiredToken(getToken);

  const response = await fetch(`${apiUrl}/channels/${channelId}/test-inbound`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({})
  });

  if (!response.ok) {
    throw new Error(`Failed to create test inbound message: ${response.status}`);
  }

  const data = await response.json();
  return channelTestInboundResultSchema.parse(data);
}

export async function apiGetConversationMessages(
  conversationId: string,
  getToken: () => Promise<string | null>
): Promise<MessageDto[]> {
  const token = await getRequiredToken(getToken);

  const response = await fetch(`${apiUrl}/conversations/${conversationId}/messages`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to load messages: ${response.status}`);
  }

  const data = await response.json();
  return messageSchema.array().parse(data);
}

export interface CreateConversationMessageInput {
  body?: string;
  attachment?: {
    fileName: string;
    mediaUrl: string;
    mimetype: string;
  };
}

export async function apiCreateConversationMessage(
  conversationId: string,
  input: CreateConversationMessageInput,
  getToken: () => Promise<string | null>
): Promise<MessageDto> {
  const token = await getRequiredToken(getToken);

  const response = await fetch(`${apiUrl}/conversations/${conversationId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input)
  });

  if (!response.ok) {
    throw new Error(`Failed to send message: ${response.status}`);
  }

  const data = await response.json();
  return messageSchema.parse(data);
}

export async function apiGetConversationContext(
  conversationId: string,
  getToken: () => Promise<string | null>
): Promise<ContactContextDto> {
  const token = await getRequiredToken(getToken);

  const response = await fetch(`${apiUrl}/conversations/${conversationId}/context`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to load contact context: ${response.status}`);
  }

  const data = await response.json();
  return parseContactContext(data);
}

export async function apiRunConversationAction(
  conversationId: string,
  body: ConversationActionBody,
  getToken: () => Promise<string | null>
): Promise<ConversationActionResultDto> {
  const token = await getRequiredToken(getToken);

  const response = await fetch(`${apiUrl}/conversations/${conversationId}/actions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`Failed to run conversation action: ${response.status}`);
  }

  const data = await response.json();
  return parseConversationActionResult(data);
}

export async function apiGetQuickReplies(getToken: () => Promise<string | null>): Promise<QuickReplyDto[]> {
  const token = await getRequiredToken(getToken);
  const response = await fetch(`${apiUrl}/quick-replies`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok) {
    throw new Error(`Failed to load quick replies: ${response.status}`);
  }
  const data = await response.json();
  return Array.isArray(data) ? data.map(parseQuickReply) : [];
}

export async function apiCreateQuickReply(
  getToken: () => Promise<string | null>,
  body: { title: string; body: string; category?: string | null }
): Promise<QuickReplyDto> {
  const token = await getRequiredToken(getToken);
  const response = await fetch(`${apiUrl}/quick-replies`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(`Failed to create quick reply: ${response.status}`);
  }
  return parseQuickReply(await response.json());
}

export async function apiUpdateQuickReply(
  getToken: () => Promise<string | null>,
  quickReplyId: string,
  body: Partial<{ title: string; body: string; category: string | null }>
): Promise<QuickReplyDto> {
  const token = await getRequiredToken(getToken);
  const response = await fetch(`${apiUrl}/quick-replies/${quickReplyId}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(`Failed to update quick reply: ${response.status}`);
  }
  return parseQuickReply(await response.json());
}

export async function apiDeleteQuickReply(
  getToken: () => Promise<string | null>,
  quickReplyId: string
): Promise<void> {
  const token = await getRequiredToken(getToken);
  const response = await fetch(`${apiUrl}/quick-replies/${quickReplyId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok) {
    throw new Error(`Failed to delete quick reply: ${response.status}`);
  }
}

export async function apiGetAutomations(
  getToken: () => Promise<string | null>
): Promise<AutomationRuleDto[]> {
  const token = await getRequiredToken(getToken);

  const response = await fetch(`${apiUrl}/automations`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to load automations: ${response.status}`);
  }

  const data = await response.json();
  return Array.isArray(data) ? data.map(parseAutomationRule) : [];
}

export async function apiCreateAutomation(
  getToken: () => Promise<string | null>,
  body: {
    name: string;
    status?: AutomationStatus;
    trigger: string;
    conditions?: Record<string, unknown>;
    actions?: AutomationActionsDto;
  }
): Promise<AutomationRuleDto> {
  const token = await getRequiredToken(getToken);

  const response = await fetch(`${apiUrl}/automations`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`Failed to create automation: ${response.status}`);
  }

  const data = await response.json();
  return parseAutomationRule(data);
}

export async function apiUpdateAutomation(
  getToken: () => Promise<string | null>,
  automationId: string,
  body: Partial<{
    name: string;
    status: AutomationStatus;
    trigger: string;
    conditions: Record<string, unknown>;
    actions: AutomationActionsDto;
  }>
): Promise<AutomationRuleDto> {
  const token = await getRequiredToken(getToken);

  const response = await fetch(`${apiUrl}/automations/${automationId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`Failed to update automation: ${response.status}`);
  }

  const data = await response.json();
  return parseAutomationRule(data);
}

export async function apiDeleteAutomation(
  getToken: () => Promise<string | null>,
  automationId: string
): Promise<void> {
  const token = await getRequiredToken(getToken);

  const response = await fetch(`${apiUrl}/automations/${automationId}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to delete automation: ${response.status}`);
  }
}

export async function apiTestAutomation(
  getToken: () => Promise<string | null>,
  automationId: string,
  body: {
    channelId?: string;
    contactId?: string;
    eventKey?: string;
    input?: Record<string, unknown>;
    messageBody?: string;
  } = {}
): Promise<AutomationRunDto> {
  const token = await getRequiredToken(getToken);

  const response = await fetch(`${apiUrl}/automations/${automationId}/test`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`Failed to test automation: ${response.status}`);
  }

  const data = await response.json();
  return parseAutomationRun(data);
}

export async function apiGetAutomationRuns(
  getToken: () => Promise<string | null>,
  automationId: string
): Promise<AutomationRunDto[]> {
  const token = await getRequiredToken(getToken);

  const response = await fetch(`${apiUrl}/automations/${automationId}/runs`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to load automation runs: ${response.status}`);
  }

  const data = await response.json();
  return Array.isArray(data) ? data.map(parseAutomationRun) : [];
}

export async function apiGetCampaigns(
  getToken: () => Promise<string | null>
): Promise<CampaignDto[]> {
  const token = await getRequiredToken(getToken);

  const response = await fetch(`${apiUrl}/campaigns`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to load campaigns: ${response.status}`);
  }

  const data = await response.json();
  return Array.isArray(data) ? data.map(parseCampaign) : [];
}

export async function apiCreateCampaign(
  getToken: () => Promise<string | null>,
  body: {
    name: string;
    audience: CampaignAudienceDto;
    messageBody: string;
    templates?: string[];
    fallbackName?: string;
    cadence?: CampaignCadenceDto;
    scheduledAt?: string | null;
  }
): Promise<CampaignDto> {
  const token = await getRequiredToken(getToken);

  const response = await fetch(`${apiUrl}/campaigns`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`Failed to create campaign: ${response.status}`);
  }

  const data = await response.json();
  return parseCampaign(data);
}

export async function apiUpdateCampaign(
  getToken: () => Promise<string | null>,
  campaignId: string,
  body: Partial<{
    name: string;
    status: CampaignStatus;
    audience: CampaignAudienceDto;
    messageBody: string;
    templates: string[];
    fallbackName: string;
    cadence: CampaignCadenceDto;
    scheduledAt: string | null;
  }>
): Promise<CampaignDto> {
  const token = await getRequiredToken(getToken);

  const response = await fetch(`${apiUrl}/campaigns/${campaignId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`Failed to update campaign: ${response.status}`);
  }

  const data = await response.json();
  return parseCampaign(data);
}

export async function apiResolveCampaignAudience(
  getToken: () => Promise<string | null>,
  campaignId: string
): Promise<CampaignAudienceContactDto[]> {
  const token = await getRequiredToken(getToken);

  const response = await fetch(`${apiUrl}/campaigns/${campaignId}/resolve-audience`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to resolve campaign audience: ${response.status}`);
  }

  const data = await response.json();
  return Array.isArray(data) ? data.map(parseCampaignAudienceContact) : [];
}

export async function apiSendCampaignSimulated(
  getToken: () => Promise<string | null>,
  campaignId: string
): Promise<CampaignSendResultDto> {
  const token = await getRequiredToken(getToken);

  const response = await fetch(`${apiUrl}/campaigns/${campaignId}/send-simulated`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to send simulated campaign: ${response.status}`);
  }

  const data = await response.json();
  return parseCampaignSendResult(data);
}

export async function apiSendCampaignReal(
  getToken: () => Promise<string | null>,
  campaignId: string
): Promise<CampaignSendResultDto> {
  const token = await getRequiredToken(getToken);

  const response = await fetch(`${apiUrl}/campaigns/${campaignId}/send-real`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to send real campaign: ${response.status}`);
  }

  const data = await response.json();
  return parseCampaignSendResult(data);
}

export async function apiGetCampaignRecipients(
  getToken: () => Promise<string | null>,
  campaignId: string
): Promise<CampaignRecipientDto[]> {
  const token = await getRequiredToken(getToken);

  const response = await fetch(`${apiUrl}/campaigns/${campaignId}/recipients`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to load campaign recipients: ${response.status}`);
  }

  const data = await response.json();
  return Array.isArray(data) ? data.map(parseCampaignRecipient) : [];
}

export async function apiGetReportsOverview(
  getToken: () => Promise<string | null>,
  filters: Partial<ReportFiltersDto> = {}
): Promise<ReportsOverviewDto> {
  const token = await getRequiredToken(getToken);
  const searchParams = new URLSearchParams();

  for (const [key, value] of Object.entries(filters)) {
    if (value) {
      searchParams.set(key, String(value));
    }
  }

  const queryString = searchParams.toString();
  const response = await fetch(`${apiUrl}/reports/overview${queryString ? `?${queryString}` : ""}`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to load reports overview: ${response.status}`);
  }

  const data = await response.json();
  return parseReportsOverview(data);
}

export async function apiGetTeamUsers(
  getToken: () => Promise<string | null>
): Promise<TeamUserDto[]> {
  return fetchJson(
    getToken,
    "/team/users",
    {},
    (data) => (Array.isArray(data) ? data.map(parseTeamUser) : []),
    "Failed to load team users"
  );
}

export async function apiGetTeamDepartments(
  getToken: () => Promise<string | null>
): Promise<TeamDepartmentDto[]> {
  return fetchJson(
    getToken,
    "/team/departments",
    {},
    (data) => (Array.isArray(data) ? data.map(parseTeamDepartment) : []),
    "Failed to load team departments"
  );
}

export async function apiCreateTeamDepartment(
  getToken: () => Promise<string | null>,
  body: {
    name: string;
    routingOrder?: number;
  }
): Promise<TeamDepartmentDto> {
  return fetchJson(
    getToken,
    "/team/departments",
    {
      method: "POST",
      body: JSON.stringify(body)
    },
    parseTeamDepartment,
    "Failed to create team department"
  );
}

export async function apiUpdateTeamUserRole(
  getToken: () => Promise<string | null>,
  userId: string,
  body: {
    role: TeamUserRole;
  }
): Promise<TeamUserDto> {
  return fetchJson(
    getToken,
    `/team/users/${userId}`,
    {
      method: "PATCH",
      body: JSON.stringify(body)
    },
    parseTeamUser,
    "Failed to update team user role"
  );
}

export async function apiGetAssistantActions(
  getToken: () => Promise<string | null>
): Promise<AssistantActionDto[]> {
  return fetchJson(
    getToken,
    "/assistant/actions",
    {},
    (data) => (Array.isArray(data) ? data.map(parseAssistantAction) : []),
    "Failed to load assistant actions"
  );
}

export async function apiCreateAssistantAction(
  getToken: () => Promise<string | null>,
  body: {
    actionType: AssistantActionType;
    conversationId?: string | null;
    contactId?: string | null;
    input?: Record<string, unknown>;
  }
): Promise<AssistantActionDto> {
  return fetchJson(
    getToken,
    "/assistant/actions",
    {
      method: "POST",
      body: JSON.stringify(body)
    },
    parseAssistantAction,
    "Failed to create assistant action"
  );
}

export async function apiGetCrmSyncActions(
  getToken: () => Promise<string | null>,
  contactId?: string
): Promise<CrmSyncActionDto[]> {
  const path = contactId
    ? `/crm/sync-actions?contactId=${encodeURIComponent(contactId)}`
    : "/crm/sync-actions";

  return fetchJson(
    getToken,
    path,
    {},
    (data) => (Array.isArray(data) ? data.map(parseCrmSyncAction) : []),
    "Failed to load CRM sync actions"
  );
}

export async function apiLinkCrmContact(
  getToken: () => Promise<string | null>,
  body: {
    contactId: string;
    atomicCrmContactId?: string;
  }
): Promise<CrmSyncActionDto> {
  return fetchJson(
    getToken,
    "/crm/link-contact",
    {
      method: "POST",
      body: JSON.stringify(body)
    },
    parseCrmSyncAction,
    "Failed to link CRM contact"
  );
}

export async function apiCreateCrmLead(
  getToken: () => Promise<string | null>,
  body: {
    contactId: string;
    title: string;
  }
): Promise<CrmSyncActionDto> {
  return fetchJson(
    getToken,
    "/crm/create-lead",
    {
      method: "POST",
      body: JSON.stringify(body)
    },
    parseCrmSyncAction,
    "Failed to create CRM lead"
  );
}

export async function apiCreateCrmNote(
  getToken: () => Promise<string | null>,
  body: {
    contactId: string;
    body: string;
  }
): Promise<CrmSyncActionDto> {
  return fetchJson(
    getToken,
    "/crm/create-note",
    {
      method: "POST",
      body: JSON.stringify(body)
    },
    parseCrmSyncAction,
    "Failed to create CRM note"
  );
}

export async function apiGetSettings(
  getToken: () => Promise<string | null>
): Promise<SettingsDto> {
  return fetchJson(getToken, "/settings", {}, parseSettings, "Failed to load settings");
}

export async function apiUpdateSettings(
  getToken: () => Promise<string | null>,
  body: {
    provider: string;
    mode: IntegrationModeDto;
    settings?: Record<string, unknown>;
  }
): Promise<SettingsDto> {
  return fetchJson(
    getToken,
    "/settings",
    {
      method: "PATCH",
      body: JSON.stringify(body)
    },
    parseSettings,
    "Failed to update settings"
  );
}

export async function apiGetAuditLog(
  getToken: () => Promise<string | null>
): Promise<AuditLogDto[]> {
  return fetchJson(
    getToken,
    "/settings/audit-log",
    {},
    (data) => (Array.isArray(data) ? data.map(parseAuditLog) : []),
    "Failed to load audit log"
  );
}

export function buildRealtimeUrl(token: string | null) {
  const realtimeToken = token ?? (localAuthBypass ? "local-dev-bypass" : null);

  if (!realtimeToken) {
    throw new Error("Missing realtime auth token.");
  }

  const url = new URL(apiUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/$/, "")}/realtime`;
  url.searchParams.set("token", realtimeToken);
  return url.toString();
}
