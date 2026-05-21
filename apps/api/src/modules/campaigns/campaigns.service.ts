import type { Prisma, PrismaClient } from "@prisma/client";

type DateLike = Date | string;
type CampaignStatus = "draft" | "scheduled" | "sending" | "completed" | "failed";
type IntegrationMode = "simulated" | "real";

interface CampaignRecord {
  id: string;
  workspaceId: string;
  name: string;
  status: CampaignStatus;
  audience: Prisma.JsonValue;
  messageBody: string;
  scheduledAt: DateLike | null;
  mode: IntegrationMode;
  createdAt: DateLike;
  updatedAt: DateLike;
}

interface RecipientContactRecord {
  id: string;
  workspaceId: string;
  name: string | null;
  phone: string;
  email?: string | null;
  company?: string | null;
}

interface CampaignRecipientRecord {
  id: string;
  workspaceId: string;
  campaignId: string;
  contactId: string;
  status: string;
  result: unknown;
  createdAt: DateLike;
  updatedAt: DateLike;
  contact?: RecipientContactRecord;
}

interface BoardMembershipRecord {
  contactId: string;
  contact: RecipientContactRecord;
}

type CampaignFindManyArgs = Parameters<PrismaClient["campaign"]["findMany"]>[0];
type CampaignFindFirstArgs = Parameters<PrismaClient["campaign"]["findFirst"]>[0];
type CampaignCreateArgs = Parameters<PrismaClient["campaign"]["create"]>[0];
type CampaignUpdateArgs = Parameters<PrismaClient["campaign"]["update"]>[0];
type RecipientFindManyArgs = Parameters<PrismaClient["campaignRecipient"]["findMany"]>[0];
type RecipientUpsertArgs = Parameters<PrismaClient["campaignRecipient"]["upsert"]>[0];
type BoardFindFirstArgs = Parameters<PrismaClient["contactBoard"]["findFirst"]>[0];
type MembershipFindManyArgs = Parameters<PrismaClient["contactBoardMembership"]["findMany"]>[0];

export interface PrismaLike {
  campaign: {
    findMany(args: CampaignFindManyArgs): Promise<CampaignRecord[]>;
    findFirst(args: CampaignFindFirstArgs): Promise<CampaignRecord | null>;
    create(args: CampaignCreateArgs): Promise<CampaignRecord>;
    update(args: CampaignUpdateArgs): Promise<CampaignRecord>;
  };
  campaignRecipient: {
    findMany(args: RecipientFindManyArgs): Promise<CampaignRecipientRecord[]>;
    upsert(args: RecipientUpsertArgs): Promise<CampaignRecipientRecord>;
  };
  contactBoard: {
    findFirst(args: BoardFindFirstArgs): Promise<{ id: string; workspaceId: string } | null>;
  };
  contactBoardMembership: {
    findMany(args: MembershipFindManyArgs): Promise<BoardMembershipRecord[]>;
  };
}

export interface CampaignDto {
  id: string;
  workspaceId: string;
  name: string;
  status: CampaignStatus;
  audience: Prisma.JsonValue;
  messageBody: string;
  scheduledAt: string | null;
  mode: IntegrationMode;
  createdAt: string;
  updatedAt: string;
}

export interface CampaignAudienceContactDto {
  contactId: string;
  name: string | null;
  phone: string;
}

export interface CampaignRecipientDto {
  id: string;
  workspaceId: string;
  campaignId: string;
  contactId: string;
  status: string;
  result: unknown;
  createdAt: string;
  updatedAt: string;
  contactName: string | null;
  contactPhone: string | null;
}

export interface CampaignSendResultDto {
  mode: "simulated";
  result: "sent_simulated";
  recipientsCreated: number;
}

export class CampaignsServiceError extends Error {
  constructor(
    public code:
      | "CAMPAIGN_NOT_FOUND"
      | "CAMPAIGN_AUDIENCE_INVALID"
      | "CAMPAIGN_BOARD_NOT_FOUND",
    message: string
  ) {
    super(message);
  }
}

function toIsoString(value: DateLike) {
  return value instanceof Date ? value.toISOString() : value;
}

function toNullableIsoString(value: DateLike | null) {
  return value ? toIsoString(value) : null;
}

function normalizeOptional(value: string | undefined) {
  if (value === undefined) return undefined;

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function withoutUndefined<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined)
  ) as T;
}

function toCampaignDto(record: CampaignRecord): CampaignDto {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    name: record.name,
    status: record.status,
    audience: record.audience,
    messageBody: record.messageBody,
    scheduledAt: toNullableIsoString(record.scheduledAt),
    mode: record.mode,
    createdAt: toIsoString(record.createdAt),
    updatedAt: toIsoString(record.updatedAt)
  };
}

function toRecipientDto(record: CampaignRecipientRecord): CampaignRecipientDto {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    campaignId: record.campaignId,
    contactId: record.contactId,
    status: record.status,
    result: record.result,
    createdAt: toIsoString(record.createdAt),
    updatedAt: toIsoString(record.updatedAt),
    contactName: record.contact?.name ?? null,
    contactPhone: record.contact?.phone ?? null
  };
}

function getBoardAudience(audience: unknown) {
  if (typeof audience !== "object" || audience === null) {
    return null;
  }

  const payload = audience as { type?: unknown; boardId?: unknown; stageId?: unknown };
  if (payload.type !== "board" || typeof payload.boardId !== "string") {
    return null;
  }

  return {
    boardId: payload.boardId,
    stageId: typeof payload.stageId === "string" ? payload.stageId : undefined
  };
}

function buildMessagePreview(messageBody: string, contact: RecipientContactRecord) {
  return messageBody
    .replaceAll("{{name}}", contact.name ?? "contato")
    .replaceAll("{{phone}}", contact.phone);
}

function deriveStatusFromSchedule(input: {
  explicitStatus?: CampaignStatus;
  scheduledAt?: string | null;
  currentStatus: CampaignStatus;
}) {
  if (input.explicitStatus || input.scheduledAt === undefined) {
    return input.explicitStatus;
  }

  if (input.scheduledAt) {
    return input.currentStatus === "draft" ? "scheduled" : input.currentStatus;
  }

  return input.currentStatus === "scheduled" ? "draft" : input.currentStatus;
}

export function createCampaignsService(prisma: PrismaLike) {
  const findCampaignForWorkspace = async (input: {
    workspaceId: string;
    campaignId: string;
  }) => {
    const campaign = await prisma.campaign.findFirst({
      where: {
        workspaceId: input.workspaceId,
        id: input.campaignId
      }
    });

    if (!campaign) {
      throw new CampaignsServiceError("CAMPAIGN_NOT_FOUND", "Campaign not found.");
    }

    return campaign;
  };

  const resolveBoardAudience = async (campaign: CampaignRecord) => {
    const audience = getBoardAudience(campaign.audience);

    if (!audience) {
      throw new CampaignsServiceError(
        "CAMPAIGN_AUDIENCE_INVALID",
        "Campaign audience must target a contact board."
      );
    }

    const board = await prisma.contactBoard.findFirst({
      where: {
        workspaceId: campaign.workspaceId,
        id: audience.boardId
      }
    });

    if (!board) {
      throw new CampaignsServiceError("CAMPAIGN_BOARD_NOT_FOUND", "Board not found.");
    }

    const memberships = await prisma.contactBoardMembership.findMany({
      where: withoutUndefined({
        workspaceId: campaign.workspaceId,
        boardId: audience.boardId,
        stageId: audience.stageId
      }),
      include: {
        contact: true
      },
      orderBy: [{ updatedAt: "desc" }]
    });

    return memberships.map((membership) => ({
      contactId: membership.contactId,
      name: membership.contact.name,
      phone: membership.contact.phone,
      contact: membership.contact
    }));
  };

  return {
    async listCampaigns(input: { workspaceId: string }): Promise<CampaignDto[]> {
      const campaigns = await prisma.campaign.findMany({
        where: { workspaceId: input.workspaceId },
        orderBy: [{ createdAt: "desc" }],
        take: 100
      });

      return campaigns.map(toCampaignDto);
    },

    async createCampaign(input: {
      workspaceId: string;
      name: string;
      audience: Prisma.InputJsonValue;
      messageBody: string;
      scheduledAt?: string | null;
    }): Promise<CampaignDto> {
      const campaign = await prisma.campaign.create({
        data: {
          workspaceId: input.workspaceId,
          name: input.name.trim(),
          status: input.scheduledAt ? "scheduled" : "draft",
          audience: input.audience,
          messageBody: input.messageBody.trim(),
          scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null,
          mode: "simulated"
        }
      });

      return toCampaignDto(campaign);
    },

    async updateCampaign(input: {
      workspaceId: string;
      campaignId: string;
      data: Partial<{
        name: string;
        status: CampaignStatus;
        audience: Prisma.InputJsonValue;
        messageBody: string;
        scheduledAt: string | null;
      }>;
    }): Promise<CampaignDto> {
      const currentCampaign = await findCampaignForWorkspace(input);

      const campaign = await prisma.campaign.update({
        where: {
          workspaceId_id: {
            workspaceId: input.workspaceId,
            id: input.campaignId
          }
        },
        data: withoutUndefined({
          name: normalizeOptional(input.data.name),
          status: deriveStatusFromSchedule({
            explicitStatus: input.data.status,
            scheduledAt: input.data.scheduledAt,
            currentStatus: currentCampaign.status
          }),
          audience: input.data.audience,
          messageBody: normalizeOptional(input.data.messageBody),
          scheduledAt:
            input.data.scheduledAt === undefined
              ? undefined
              : input.data.scheduledAt
                ? new Date(input.data.scheduledAt)
                : null
        })
      });

      return toCampaignDto(campaign);
    },

    async resolveAudience(input: {
      workspaceId: string;
      campaignId: string;
    }): Promise<CampaignAudienceContactDto[]> {
      const campaign = await findCampaignForWorkspace(input);
      const contacts = await resolveBoardAudience(campaign);

      return contacts.map((contact) => ({
        contactId: contact.contactId,
        name: contact.name,
        phone: contact.phone
      }));
    },

    async sendSimulated(input: {
      workspaceId: string;
      campaignId: string;
    }): Promise<CampaignSendResultDto> {
      const campaign = await findCampaignForWorkspace(input);
      const contacts = await resolveBoardAudience(campaign);

      for (const contact of contacts) {
        const result = {
          mode: "simulated",
          result: "sent_simulated",
          messagePreview: buildMessagePreview(campaign.messageBody, contact.contact),
          sentAt: new Date().toISOString()
        };

        await prisma.campaignRecipient.upsert({
          where: {
            workspaceId_campaignId_contactId: {
              workspaceId: input.workspaceId,
              campaignId: input.campaignId,
              contactId: contact.contactId
            }
          },
          create: {
            workspaceId: input.workspaceId,
            campaignId: input.campaignId,
            contactId: contact.contactId,
            status: "sent_simulated",
            result
          },
          update: {
            status: "sent_simulated",
            result
          }
        });
      }

      await prisma.campaign.update({
        where: {
          workspaceId_id: {
            workspaceId: input.workspaceId,
            id: input.campaignId
          }
        },
        data: {
          status: "completed"
        }
      });

      return {
        mode: "simulated",
        result: "sent_simulated",
        recipientsCreated: contacts.length
      };
    },

    async listRecipients(input: {
      workspaceId: string;
      campaignId: string;
    }): Promise<CampaignRecipientDto[]> {
      await findCampaignForWorkspace(input);

      const recipients = await prisma.campaignRecipient.findMany({
        where: {
          workspaceId: input.workspaceId,
          campaignId: input.campaignId
        },
        include: {
          contact: true
        },
        orderBy: [{ updatedAt: "desc" }]
      });

      return recipients.map(toRecipientDto);
    }
  };
}
