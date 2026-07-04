type CountGroup = {
  _count: {
    _all: number;
  };
};

type ConversationStatus = "open" | "pending" | "closed";
type MessageDirection = "inbound" | "outbound";
type ReportPeriodPreset = "today" | "7d" | "30d" | "month" | "custom";

interface ConversationGroup extends CountGroup {
  status: ConversationStatus;
}

interface MessageGroup extends CountGroup {
  direction: MessageDirection;
}

interface StatusGroup extends CountGroup {
  status: string;
}

interface ConversationBreakdownRecord {
  id: string;
  status: ConversationStatus;
  createdAt: Date | string;
  departmentId: string | null;
  channelId: string;
  department: { id: string; name: string } | null;
  channel: { id: string; displayName: string | null; providerKey: string } | null;
  tags: Array<{
    tag: {
      name: string;
      color?: string | null;
    };
  }>;
}

interface MessageTimeRecord {
  createdAt: Date | string;
  direction: MessageDirection;
}

export interface PrismaLike {
  conversation: {
    count(args: unknown): Promise<number>;
    groupBy(args: unknown): Promise<ConversationGroup[]>;
    findMany(args: unknown): Promise<ConversationBreakdownRecord[]>;
  };
  message: {
    count(args: unknown): Promise<number>;
    groupBy(args: unknown): Promise<MessageGroup[]>;
    findMany(args: unknown): Promise<MessageTimeRecord[]>;
  };
  campaignRecipient: {
    count(args: unknown): Promise<number>;
    groupBy(args: unknown): Promise<StatusGroup[]>;
  };
  automationRun: {
    count(args: unknown): Promise<number>;
    groupBy(args: unknown): Promise<StatusGroup[]>;
  };
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

export interface ReportFiltersDto {
  preset: ReportPeriodPreset;
  startDate: string | null;
  endDate: string | null;
  status?: ConversationStatus;
  channelId?: string;
  departmentId?: string;
}

const conversationStatusLabels: Record<ConversationStatus, string> = {
  open: "Abertas",
  pending: "Pendentes",
  closed: "Fechadas"
};

const messageDirectionLabels: Record<MessageDirection, string> = {
  inbound: "Inbound",
  outbound: "Outbound"
};

function toCount(group: CountGroup) {
  return group._count._all;
}

function toDateKey(value: Date | string) {
  return (value instanceof Date ? value.toISOString() : value).slice(0, 10);
}

function metric(key: string, label: string, value: number, helper?: string): ReportMetricDto {
  return {
    key,
    label,
    value,
    ...(helper ? { helper } : {})
  };
}

function sortedStatusMetrics(groups: StatusGroup[]) {
  return [...groups]
    .sort((left, right) => toCount(right) - toCount(left) || left.status.localeCompare(right.status))
    .map((group) => metric(group.status, group.status, toCount(group)));
}

function buildBreakdown(entries: Map<string, { label: string; value: number }>) {
  return [...entries.entries()]
    .map(([key, entry]) => metric(key, entry.label, entry.value))
    .sort((left, right) => right.value - left.value);
}

function incrementBreakdown(
  entries: Map<string, { label: string; value: number }>,
  key: string,
  label: string
) {
  const current = entries.get(key) ?? { label, value: 0 };
  entries.set(key, { ...current, value: current.value + 1 });
}

function buildTimeSeries(
  conversations: ConversationBreakdownRecord[],
  messages: MessageTimeRecord[]
) {
  const points = new Map<string, ReportTimeSeriesPointDto>();

  const ensurePoint = (date: string) => {
    const existing = points.get(date);
    if (existing) return existing;

    const point = {
      date,
      conversations: 0,
      inboundMessages: 0,
      outboundMessages: 0
    };
    points.set(date, point);
    return point;
  };

  for (const conversation of conversations) {
    ensurePoint(toDateKey(conversation.createdAt)).conversations += 1;
  }

  for (const message of messages) {
    const point = ensurePoint(toDateKey(message.createdAt));
    if (message.direction === "inbound") {
      point.inboundMessages += 1;
    } else {
      point.outboundMessages += 1;
    }
  }

  return [...points.values()].sort((left, right) => left.date.localeCompare(right.date));
}

function parseDateStart(value?: string) {
  if (!value) return undefined;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function parseDateEnd(value?: string) {
  if (!value) return undefined;
  const date = new Date(`${value}T23:59:59.999Z`);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function dateKey(value: Date) {
  return value.toISOString().slice(0, 10);
}

function subtractDays(value: Date, days: number) {
  const next = new Date(value);
  next.setUTCDate(next.getUTCDate() - days);
  return next;
}

function startOfUtcMonth(value: Date) {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1, 0, 0, 0, 0));
}

function endOfUtcDay(value: Date) {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate(), 23, 59, 59, 999));
}

function normalizeFilters(filters?: Partial<ReportFiltersDto>, now = new Date()): ReportFiltersDto {
  const preset = filters?.preset ?? (filters?.startDate || filters?.endDate ? "custom" : "30d");
  const todayEnd = endOfUtcDay(now);
  let startDate: string | null = filters?.startDate ?? null;
  let endDate: string | null = filters?.endDate ?? null;

  if (preset === "today") {
    startDate = dateKey(todayEnd);
    endDate = dateKey(todayEnd);
  } else if (preset === "7d") {
    startDate = dateKey(subtractDays(todayEnd, 6));
    endDate = dateKey(todayEnd);
  } else if (preset === "30d") {
    startDate = dateKey(subtractDays(todayEnd, 29));
    endDate = dateKey(todayEnd);
  } else if (preset === "month") {
    startDate = dateKey(startOfUtcMonth(todayEnd));
    endDate = dateKey(todayEnd);
  }

  return {
    preset,
    startDate,
    endDate,
    ...(filters?.status ? { status: filters.status } : {}),
    ...(filters?.channelId ? { channelId: filters.channelId } : {}),
    ...(filters?.departmentId ? { departmentId: filters.departmentId } : {})
  };
}

function buildDateWhere(filters: ReportFiltersDto) {
  const gte = parseDateStart(filters.startDate ?? undefined);
  const lte = parseDateEnd(filters.endDate ?? undefined);

  if (!gte && !lte) return undefined;
  return {
    ...(gte ? { gte } : {}),
    ...(lte ? { lte } : {})
  };
}

function withoutUndefined<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined)
  ) as T;
}

export function createReportsService(prisma: PrismaLike) {
  return {
    async getOverview(input: { workspaceId: string; filters?: Partial<ReportFiltersDto> }): Promise<ReportsOverviewDto> {
      const filters = normalizeFilters(input.filters);
      const dateWhere = buildDateWhere(filters);
      const conversationWhere = withoutUndefined({
        workspaceId: input.workspaceId,
        createdAt: dateWhere,
        status: filters.status,
        channelId: filters.channelId,
        departmentId: filters.departmentId
      });
      const messageWhere = withoutUndefined({
        workspaceId: input.workspaceId,
        createdAt: dateWhere,
        conversation: withoutUndefined({
          workspaceId: input.workspaceId,
          status: filters.status,
          channelId: filters.channelId,
          departmentId: filters.departmentId
        })
      });
      const dateOnlyWhere = withoutUndefined({
        workspaceId: input.workspaceId,
        createdAt: dateWhere
      });

      const [
        totalConversations,
        conversationGroups,
        conversationRows,
        totalMessages,
        messageGroups,
        messageRows,
        totalCampaignRecipients,
        campaignGroups,
        totalAutomationRuns,
        automationGroups
      ] = await Promise.all([
        prisma.conversation.count({ where: conversationWhere }),
        prisma.conversation.groupBy({
          by: ["status"],
          where: conversationWhere,
          _count: { _all: true }
        }),
        prisma.conversation.findMany({
          where: conversationWhere,
          select: {
            id: true,
            status: true,
            createdAt: true,
            departmentId: true,
            channelId: true,
            department: {
              select: {
                id: true,
                name: true
              }
            },
            channel: {
              select: {
                id: true,
                displayName: true,
                providerKey: true
              }
            },
            tags: {
              select: {
                tag: {
                  select: {
                    name: true,
                    color: true
                  }
                }
              }
            }
          },
          orderBy: {
            createdAt: "asc"
          }
        }),
        prisma.message.count({ where: messageWhere }),
        prisma.message.groupBy({
          by: ["direction"],
          where: messageWhere,
          _count: { _all: true }
        }),
        prisma.message.findMany({
          where: messageWhere,
          select: {
            createdAt: true,
            direction: true
          },
          orderBy: {
            createdAt: "asc"
          }
        }),
        prisma.campaignRecipient.count({ where: dateOnlyWhere }),
        prisma.campaignRecipient.groupBy({
          by: ["status"],
          where: dateOnlyWhere,
          _count: { _all: true }
        }),
        prisma.automationRun.count({ where: dateOnlyWhere }),
        prisma.automationRun.groupBy({
          by: ["status"],
          where: dateOnlyWhere,
          _count: { _all: true }
        })
      ]);

      const conversationMetrics = (["open", "pending", "closed"] as const).map((status) =>
        metric(
          status,
          conversationStatusLabels[status],
          conversationGroups.find((group) => group.status === status)?._count._all ?? 0
        )
      );
      const messageMetrics = (["inbound", "outbound"] as const).map((direction) =>
        metric(
          direction,
          messageDirectionLabels[direction],
          messageGroups.find((group) => group.direction === direction)?._count._all ?? 0
        )
      );
      const campaignMetrics = sortedStatusMetrics(campaignGroups);
      const automationMetrics = sortedStatusMetrics(automationGroups);
      const departments = new Map<string, { label: string; value: number }>();
      const channels = new Map<string, { label: string; value: number }>();
      const tags = new Map<string, { label: string; value: number }>();

      for (const conversation of conversationRows) {
        const departmentLabel = conversation.department?.name ?? "Sem departamento";
        incrementBreakdown(
          departments,
          conversation.department?.id ?? "unassigned",
          departmentLabel
        );

        const channelLabel =
          conversation.channel?.displayName ?? conversation.channel?.providerKey ?? "Sem canal";
        incrementBreakdown(channels, conversation.channel?.id ?? "unassigned", channelLabel);

        for (const tag of conversation.tags) {
          incrementBreakdown(tags, tag.tag.name, tag.tag.name);
        }
      }

      return {
        filters,
        cards: [
          metric(
            "conversations",
            "Conversas",
            totalConversations,
            `${conversationMetrics.find((item) => item.key === "open")?.value ?? 0} abertas`
          ),
          metric(
            "messages",
            "Mensagens",
            totalMessages,
            `${messageMetrics.find((item) => item.key === "inbound")?.value ?? 0} inbound`
          ),
          metric(
            "campaignRecipients",
            "Disparos",
            totalCampaignRecipients,
            campaignMetrics[0] ? `${campaignMetrics[0].value} ${campaignMetrics[0].label}` : "0 resultados"
          ),
          metric(
            "automationRuns",
            "Automações",
            totalAutomationRuns,
            automationMetrics[0] ? `${automationMetrics[0].value} ${automationMetrics[0].label}` : "0 runs"
          )
        ],
        conversationsByStatus: conversationMetrics,
        messagesByDirection: messageMetrics,
        campaignResults: campaignMetrics,
        automationRuns: automationMetrics,
        timeSeries: buildTimeSeries(conversationRows, messageRows),
        breakdowns: {
          departments: buildBreakdown(departments),
          tags: buildBreakdown(tags),
          channels: buildBreakdown(channels)
        }
      };
    }
  };
}
