type CountGroup = {
  _count: {
    _all: number;
  };
};

type ConversationStatus = "open" | "pending" | "closed";
type MessageDirection = "inbound" | "outbound";

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
  department: { name: string } | null;
  channel: { displayName: string | null; providerKey: string } | null;
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

export function createReportsService(prisma: PrismaLike) {
  return {
    async getOverview(input: { workspaceId: string }): Promise<ReportsOverviewDto> {
      const where = { workspaceId: input.workspaceId };

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
        prisma.conversation.count({ where }),
        prisma.conversation.groupBy({
          by: ["status"],
          where,
          _count: { _all: true }
        }),
        prisma.conversation.findMany({
          where,
          select: {
            id: true,
            status: true,
            createdAt: true,
            department: {
              select: {
                name: true
              }
            },
            channel: {
              select: {
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
        prisma.message.count({ where }),
        prisma.message.groupBy({
          by: ["direction"],
          where,
          _count: { _all: true }
        }),
        prisma.message.findMany({
          where,
          select: {
            createdAt: true,
            direction: true
          },
          orderBy: {
            createdAt: "asc"
          }
        }),
        prisma.campaignRecipient.count({ where }),
        prisma.campaignRecipient.groupBy({
          by: ["status"],
          where,
          _count: { _all: true }
        }),
        prisma.automationRun.count({ where }),
        prisma.automationRun.groupBy({
          by: ["status"],
          where,
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
          conversation.department?.name ?? "unassigned",
          departmentLabel
        );

        const channelLabel =
          conversation.channel?.displayName ?? conversation.channel?.providerKey ?? "Sem canal";
        incrementBreakdown(channels, channelLabel, channelLabel);

        for (const tag of conversation.tags) {
          incrementBreakdown(tags, tag.tag.name, tag.tag.name);
        }
      }

      return {
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
            "Automacoes",
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
