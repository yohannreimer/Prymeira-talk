import type { Prisma, PrismaClient } from "@prisma/client";
import type { EvolutionRuntime } from "../evolution/evolution-runtime.js";
import type { MetaTemplateComponent } from "../meta/meta.client.js";

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
  templates?: Prisma.JsonValue;
  fallbackName?: string;
  cadence?: Prisma.JsonValue;
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
  contactId: string | null;
  audienceKey?: string | null;
  providerMessageId?: string | null;
  status: string;
  result: unknown;
  contactSnapshot?: Prisma.JsonValue;
  scheduledAt?: DateLike | null;
  sentAt?: DateLike | null;
  attempts?: number;
  errorMessage?: string | null;
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
type ChannelFindFirstArgs = Parameters<PrismaClient["channel"]["findFirst"]>[0];
type MetaMessageTemplateFindFirstArgs = Parameters<
  PrismaClient["metaMessageTemplate"]["findFirst"]
>[0];

interface ChannelRecord {
  id: string;
  workspaceId: string;
  provider: "evolution" | "meta_cloud";
  providerKey: string;
  status: string;
}

interface MetaMessageTemplateRecord {
  id: string;
  workspaceId: string;
  wabaId: string;
  templateId: string | null;
  name: string;
  language: string;
  category: string;
  status: string;
  components: Prisma.JsonValue;
  syncedAt: DateLike;
  createdAt: DateLike;
  updatedAt: DateLike;
}

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
  channel: {
    findFirst(args: ChannelFindFirstArgs): Promise<ChannelRecord | null>;
  };
  metaMessageTemplate: {
    findFirst(args: MetaMessageTemplateFindFirstArgs): Promise<MetaMessageTemplateRecord | null>;
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
  templates: string[];
  fallbackName: string;
  cadence: CampaignCadenceDto;
  scheduledAt: string | null;
  mode: IntegrationMode;
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

type MetaSendTemplateComponentType = "header" | "body";

interface MetaSendTemplateTextParameter {
  type: "text";
  text: string;
}

export interface MetaSendTemplateComponent {
  type: MetaSendTemplateComponentType;
  parameters?: MetaSendTemplateTextParameter[];
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

export class CampaignsServiceError extends Error {
  constructor(
    public code:
      | "CAMPAIGN_NOT_FOUND"
      | "CAMPAIGN_AUDIENCE_INVALID"
      | "CAMPAIGN_BOARD_NOT_FOUND"
      | "CAMPAIGN_CHANNEL_NOT_FOUND"
      | "CAMPAIGN_EVOLUTION_NOT_CONFIGURED"
      | "CAMPAIGN_META_NOT_CONFIGURED"
      | "CAMPAIGN_TEMPLATE_NOT_FOUND"
      | "CAMPAIGN_TEMPLATE_COMPONENT_INVALID",
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cadenceToJson(cadence: CampaignCadenceDto): Prisma.InputJsonObject {
  return withoutUndefined({
    minDelaySeconds: cadence.minDelaySeconds,
    maxDelaySeconds: cadence.maxDelaySeconds,
    batchSize: cadence.batchSize,
    pauseMinSeconds: cadence.pauseMinSeconds,
    pauseMaxSeconds: cadence.pauseMaxSeconds,
    windowStart: cadence.windowStart,
    windowEnd: cadence.windowEnd
  }) as Prisma.InputJsonObject;
}

function contactSnapshotToJson(contact: ResolvedCampaignContact): Prisma.InputJsonObject {
  return {
    name: contact.name,
    phone: contact.phone,
    fields: contact.fields
  };
}

function toCampaignDto(record: CampaignRecord): CampaignDto {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    name: record.name,
    status: record.status,
    audience: record.audience,
    messageBody: record.messageBody,
    templates: normalizeTemplates(record.templates, record.messageBody),
    fallbackName: normalizeFallbackName(record.fallbackName),
    cadence: normalizeCadence(record.cadence),
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
    audienceKey: record.audienceKey ?? null,
    providerMessageId: record.providerMessageId ?? null,
    status: record.status,
    result: record.result,
    contactSnapshot: record.contactSnapshot ?? {},
    scheduledAt: record.scheduledAt ? toIsoString(record.scheduledAt) : null,
    sentAt: record.sentAt ? toIsoString(record.sentAt) : null,
    attempts: record.attempts ?? 0,
    errorMessage: record.errorMessage ?? null,
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

function getImportedAudience(audience: unknown) {
  if (typeof audience !== "object" || audience === null) {
    return null;
  }

  const payload = audience as { type?: unknown; rows?: unknown };
  if (payload.type !== "imported" || !Array.isArray(payload.rows)) {
    return null;
  }

  return payload.rows
    .map((row, index): ResolvedCampaignContact | null => {
      if (typeof row !== "object" || row === null) return null;
      const record = row as { name?: unknown; phone?: unknown; fields?: unknown };
      const phone = typeof record.phone === "string" ? record.phone.trim() : "";

      if (!phone) return null;

      const fields =
        typeof record.fields === "object" && record.fields !== null
          ? Object.fromEntries(
              Object.entries(record.fields as Record<string, unknown>)
                .map(([key, value]) => [key, value == null ? "" : String(value)])
            )
          : {};

      return {
        contactId: null,
        audienceKey: phone || `imported-${index + 1}`,
        name: typeof record.name === "string" && record.name.trim() ? record.name.trim() : null,
        phone,
        fields,
        contact: null
      };
    })
    .filter((row): row is ResolvedCampaignContact => row !== null);
}

function normalizeTemplates(value: unknown, messageBody: string) {
  const templates = Array.isArray(value)
    ? value
        .map((template) => (typeof template === "string" ? template.trim() : ""))
        .filter(Boolean)
    : [];

  if (templates.length > 0) {
    return templates.slice(0, 6);
  }

  return messageBody.trim() ? [messageBody.trim()] : [];
}

function normalizeFallbackName(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "cliente";
}

function normalizeCadence(value: unknown): CampaignCadenceDto {
  const payload = typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : {};
  const numberValue = (key: string, fallback: number) => {
    const raw = payload[key];
    const parsed = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  };
  const stringValue = (key: string) => {
    const raw = payload[key];
    return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
  };

  const minDelaySeconds = numberValue("minDelaySeconds", 30);
  const maxDelaySeconds = Math.max(numberValue("maxDelaySeconds", 90), minDelaySeconds);

  return withoutUndefined({
    minDelaySeconds,
    maxDelaySeconds,
    batchSize: Math.max(0, Math.floor(numberValue("batchSize", 25))),
    pauseMinSeconds: numberValue("pauseMinSeconds", 300),
    pauseMaxSeconds: numberValue("pauseMaxSeconds", 900),
    windowStart: stringValue("windowStart"),
    windowEnd: stringValue("windowEnd")
  });
}

interface ResolvedCampaignContact {
  contactId: string | null;
  audienceKey: string;
  name: string | null;
  phone: string;
  fields: Record<string, string>;
  contact?: RecipientContactRecord | null;
}

function renderTemplate(input: {
  template: string;
  contact: ResolvedCampaignContact;
  fallbackName: string;
}) {
  const name = input.contact.name?.trim() || input.fallbackName;
  const variables: Record<string, string> = {
    ...input.contact.fields,
    name,
    nome: name,
    phone: input.contact.phone,
    telefone: input.contact.phone
  };

  return input.template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_, key: string) =>
    variables[key] ?? ""
  );
}

function planScheduledAt(input: {
  index: number;
  now: Date;
  cadence: CampaignCadenceDto;
}) {
  const delaySeconds = Math.round((input.cadence.minDelaySeconds + input.cadence.maxDelaySeconds) / 2);
  let offsetSeconds = 0;

  for (let current = 1; current <= input.index; current += 1) {
    offsetSeconds += delaySeconds;

    if (input.cadence.batchSize > 0 && current % input.cadence.batchSize === 0) {
      offsetSeconds += input.cadence.pauseMinSeconds;
    }
  }

  return new Date(input.now.getTime() + offsetSeconds * 1000);
}

function buildRecipientResult(input: {
  mode: IntegrationMode;
  result?: string;
  messagePreview: string;
  templateIndex: number;
  scheduledAt: Date;
  cadence: CampaignCadenceDto;
  providerMessageId?: string | null;
  templateName?: string;
  templateLanguage?: string;
}): Prisma.InputJsonObject {
  return withoutUndefined({
    mode: input.mode,
    result: input.result,
    messagePreview: input.messagePreview,
    templateIndex: input.templateIndex,
    scheduledAt: input.scheduledAt.toISOString(),
    cadence: cadenceToJson(input.cadence),
    providerMessageId: input.providerMessageId ?? undefined,
    templateName: input.templateName,
    templateLanguage: input.templateLanguage
  }) as Prisma.InputJsonObject;
}

function normalizeMetaSendComponentType(value: unknown): MetaSendTemplateComponentType | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === "header" || normalized === "body" ? normalized : null;
}

function getStoredTemplateComponents(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((component) => {
    if (!isRecord(component)) {
      return [];
    }

    const type = normalizeMetaSendComponentType(component.type);
    if (!type) {
      return [];
    }

    return [
      {
        type,
        text: typeof component.text === "string" ? component.text : undefined
      }
    ];
  });
}

function countNumericPlaceholders(text: string) {
  const matches = text.matchAll(/\{\{\s*(\d+)\s*\}\}/g);
  return new Set(Array.from(matches, (match) => match[1])).size;
}

function validateMetaSendComponents(input: {
  supplied?: MetaSendTemplateComponent[];
  storedComponents: unknown;
}): MetaTemplateComponent[] | undefined {
  if (!input.supplied || input.supplied.length === 0) {
    return undefined;
  }

  const storedComponents = getStoredTemplateComponents(input.storedComponents);

  return input.supplied.map((component) => {
    const type = normalizeMetaSendComponentType(component.type);
    const storedComponent = type
      ? storedComponents.find((current) => current.type === type)
      : undefined;

    if (!type || !storedComponent) {
      throw new CampaignsServiceError(
        "CAMPAIGN_TEMPLATE_COMPONENT_INVALID",
        "Template component is not present in the approved Meta template."
      );
    }

    const parameters = component.parameters?.map((parameter) => {
      if (parameter.type !== "text" || typeof parameter.text !== "string") {
        throw new CampaignsServiceError(
          "CAMPAIGN_TEMPLATE_COMPONENT_INVALID",
          "Only text template component parameters are supported."
        );
      }

      return {
        type: "text" as const,
        text: parameter.text
      };
    });

    if (storedComponent.text === undefined) {
      throw new CampaignsServiceError(
        "CAMPAIGN_TEMPLATE_COMPONENT_INVALID",
        "Template component text is required before send-time parameters can be validated."
      );
    }

    const expectedParameters = countNumericPlaceholders(storedComponent.text);
    const suppliedParameters = parameters?.length ?? 0;

    if (expectedParameters === 0 || suppliedParameters !== expectedParameters) {
      throw new CampaignsServiceError(
        "CAMPAIGN_TEMPLATE_COMPONENT_INVALID",
        "Template component parameter count must match the approved Meta template."
      );
    }

    return withoutUndefined({
      type,
      parameters: parameters && parameters.length > 0 ? parameters : undefined
    }) as MetaTemplateComponent;
  });
}

export interface CampaignsServiceOptions {
  evolution?: {
    mode: EvolutionRuntime["mode"];
    client?: Pick<NonNullable<EvolutionRuntime["client"]>, "sendText"> | null;
  };
  meta?: {
    phoneNumberId: string | null;
    wabaId: string | null;
    client?: {
      sendTemplate(input: {
        phoneNumberId: string;
        to: string;
        name: string;
        language: string;
        components?: MetaTemplateComponent[];
      }): Promise<{ providerMessageId: string | null; raw: unknown }>;
    } | null;
  };
  metaEvolution?: {
    instanceName: string | null;
    client?: {
      sendTemplate(input: {
        instanceName: string;
        number: string;
        name: string;
        language: string;
        components?: MetaTemplateComponent[];
      }): Promise<{ providerMessageId: string | null; raw: unknown }>;
    } | null;
  };
  now?: () => Date;
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

// Select only columns that exist in the current DB (templates/fallbackName/cadence are schema-only)
const campaignSelect = {
  id: true,
  workspaceId: true,
  name: true,
  status: true,
  audience: true,
  messageBody: true,
  scheduledAt: true,
  mode: true,
  createdAt: true,
  updatedAt: true,
} as const;

export function createCampaignsService(prisma: PrismaLike, options: CampaignsServiceOptions = {}) {
  const now = () => options.now?.() ?? new Date();

  const findCampaignForWorkspace = async (input: {
    workspaceId: string;
    campaignId: string;
  }) => {
    const campaign = await prisma.campaign.findFirst({
      select: campaignSelect,
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

    return memberships.map((membership): ResolvedCampaignContact => ({
      contactId: membership.contactId,
      audienceKey: membership.contactId,
      name: membership.contact.name,
      phone: membership.contact.phone,
      fields: {
        email: membership.contact.email ?? "",
        company: membership.contact.company ?? "",
        empresa: membership.contact.company ?? ""
      },
      contact: membership.contact
    }));
  };

  const resolveCampaignAudience = async (campaign: CampaignRecord): Promise<ResolvedCampaignContact[]> => {
    const importedRows = getImportedAudience(campaign.audience);

    if (importedRows) {
      return importedRows;
    }

    return resolveBoardAudience(campaign);
  };

  const buildRecipientPlans = async (campaign: CampaignRecord) => {
    const contacts = await resolveCampaignAudience(campaign);
    const templates = normalizeTemplates(campaign.templates, campaign.messageBody);
    const fallbackName = normalizeFallbackName(campaign.fallbackName);
    const cadence = normalizeCadence(campaign.cadence);
    const startedAt = now();

    return contacts.map((contact, index) => {
      const templateIndex = templates.length > 0 ? index % templates.length : 0;
      const template = templates[templateIndex] ?? campaign.messageBody;
      const messagePreview = renderTemplate({ template, contact, fallbackName });

      return {
        contact,
        templateIndex,
        messagePreview,
        scheduledAt: planScheduledAt({ index, now: startedAt, cadence }),
        cadence
      };
    });
  };

  return {
    async getCampaign(input: {
      workspaceId: string;
      campaignId: string;
    }): Promise<CampaignDto> {
      return toCampaignDto(await findCampaignForWorkspace(input));
    },

    async listCampaigns(input: { workspaceId: string }): Promise<CampaignDto[]> {
      const campaigns = await prisma.campaign.findMany({
        select: campaignSelect,
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
      templates?: string[];
      fallbackName?: string;
      cadence?: CampaignCadenceDto;
      scheduledAt?: string | null;
    }): Promise<CampaignDto> {
      const campaign = await prisma.campaign.create({
        select: campaignSelect,
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
        templates: string[];
        fallbackName: string;
        cadence: CampaignCadenceDto;
        scheduledAt: string | null;
      }>;
    }): Promise<CampaignDto> {
      const currentCampaign = await findCampaignForWorkspace(input);

      const campaign = await prisma.campaign.update({
        select: campaignSelect,
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
      const contacts = await resolveCampaignAudience(campaign);

      return contacts.map((contact) => ({
        contactId: contact.contactId,
        audienceKey: contact.audienceKey,
        name: contact.name,
        phone: contact.phone,
        fields: contact.fields
      }));
    },

    async sendSimulated(input: {
      workspaceId: string;
      campaignId: string;
    }): Promise<CampaignSendResultDto> {
      const campaign = await findCampaignForWorkspace(input);
      const plans = await buildRecipientPlans(campaign);

      for (const plan of plans) {
        const result = buildRecipientResult({
          mode: "simulated",
          result: "queued_simulated",
          messagePreview: plan.messagePreview,
          templateIndex: plan.templateIndex,
          scheduledAt: plan.scheduledAt,
          cadence: plan.cadence
        });

        await prisma.campaignRecipient.upsert({
          where: {
            workspaceId_campaignId_audienceKey: {
              workspaceId: input.workspaceId,
              campaignId: input.campaignId,
              audienceKey: plan.contact.audienceKey
            }
          },
          create: {
            workspaceId: input.workspaceId,
            campaignId: input.campaignId,
            contactId: plan.contact.contactId,
            audienceKey: plan.contact.audienceKey,
            status: "queued_simulated",
            result,
            contactSnapshot: contactSnapshotToJson(plan.contact),
            scheduledAt: plan.scheduledAt,
            attempts: 0
          },
          update: {
            status: "queued_simulated",
            result,
            contactSnapshot: contactSnapshotToJson(plan.contact),
            scheduledAt: plan.scheduledAt,
            attempts: 0,
            errorMessage: null
          }
        });
      }

      await prisma.campaign.update({
        select: { id: true },
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
        result: "queued_simulated",
        recipientsCreated: plans.length
      };
    },

    async sendReal(input: {
      workspaceId: string;
      campaignId: string;
    }): Promise<CampaignSendResultDto> {
      if (options.evolution?.mode !== "real" || !options.evolution.client) {
        throw new CampaignsServiceError(
          "CAMPAIGN_EVOLUTION_NOT_CONFIGURED",
          "Evolution real mode is required to send a campaign."
        );
      }

      const campaign = await findCampaignForWorkspace(input);
      const plans = await buildRecipientPlans(campaign);
      const channel = await prisma.channel.findFirst({
        where: {
          workspaceId: input.workspaceId,
          provider: "evolution",
          status: "connected"
        },
        orderBy: [{ createdAt: "asc" }]
      });

      if (!channel?.providerKey) {
        throw new CampaignsServiceError("CAMPAIGN_CHANNEL_NOT_FOUND", "Connected Evolution channel not found.");
      }

      let sent = 0;
      let failed = 0;

      for (const plan of plans) {
        const sentAt = now();
        const baseData = {
          workspaceId: input.workspaceId,
          campaignId: input.campaignId,
          contactId: plan.contact.contactId,
          audienceKey: plan.contact.audienceKey,
          contactSnapshot: contactSnapshotToJson(plan.contact),
          scheduledAt: plan.scheduledAt,
          attempts: 1,
          result: buildRecipientResult({
            mode: "real",
            messagePreview: plan.messagePreview,
            templateIndex: plan.templateIndex,
            scheduledAt: plan.scheduledAt,
            cadence: plan.cadence
          })
        };

        try {
          const providerSend = await options.evolution.client.sendText({
            instanceName: channel.providerKey,
            number: plan.contact.phone,
            text: plan.messagePreview
          });

          sent += 1;
          await prisma.campaignRecipient.upsert({
            where: {
              workspaceId_campaignId_audienceKey: {
                workspaceId: input.workspaceId,
                campaignId: input.campaignId,
                audienceKey: plan.contact.audienceKey
              }
            },
            create: {
              ...baseData,
              status: "sent",
              providerMessageId: providerSend.providerMessageId,
              sentAt,
              errorMessage: null,
              result: buildRecipientResult({
                mode: "real",
                result: "sent",
                messagePreview: plan.messagePreview,
                templateIndex: plan.templateIndex,
                scheduledAt: plan.scheduledAt,
                cadence: plan.cadence,
                providerMessageId: providerSend.providerMessageId
              })
            },
            update: {
              ...baseData,
              status: "sent",
              providerMessageId: providerSend.providerMessageId,
              sentAt,
              errorMessage: null,
              result: buildRecipientResult({
                mode: "real",
                result: "sent",
                messagePreview: plan.messagePreview,
                templateIndex: plan.templateIndex,
                scheduledAt: plan.scheduledAt,
                cadence: plan.cadence,
                providerMessageId: providerSend.providerMessageId
              })
            }
          });
        } catch (error) {
          failed += 1;
          await prisma.campaignRecipient.upsert({
            where: {
              workspaceId_campaignId_audienceKey: {
                workspaceId: input.workspaceId,
                campaignId: input.campaignId,
                audienceKey: plan.contact.audienceKey
              }
            },
            create: {
              ...baseData,
              status: "failed",
              errorMessage: error instanceof Error ? error.message : "Send failed."
            },
            update: {
              ...baseData,
              status: "failed",
              errorMessage: error instanceof Error ? error.message : "Send failed."
            }
          });
        }
      }

      await prisma.campaign.update({
        select: { id: true },
        where: {
          workspaceId_id: {
            workspaceId: input.workspaceId,
            id: input.campaignId
          }
        },
        data: {
          status: failed > 0 ? "failed" : "completed",
          mode: "real"
        }
      });

      return {
        mode: "real",
        result: "sent",
        recipientsCreated: plans.length,
        recipientsSent: sent,
        recipientsFailed: failed
      };
    },

    async sendMetaTemplate(input: {
      workspaceId: string;
      campaignId: string;
      template: {
        name: string;
        language: string;
        components?: MetaSendTemplateComponent[];
      };
    }): Promise<CampaignSendResultDto> {
      const phoneNumberId = options.meta?.phoneNumberId?.trim();
      const wabaId = options.meta?.wabaId?.trim();
      const evolutionInstanceName = options.metaEvolution?.instanceName?.trim();
      const directMetaConfigured = Boolean(phoneNumberId && wabaId && options.meta?.client);
      const evolutionOfficialConfigured = Boolean(evolutionInstanceName && options.metaEvolution?.client);

      if (!directMetaConfigured && !evolutionOfficialConfigured) {
        throw new CampaignsServiceError(
          "CAMPAIGN_META_NOT_CONFIGURED",
          "Meta Cloud real mode is required to send a template campaign."
        );
      }

      const templateName = input.template.name.trim();
      const templateLanguage = input.template.language.trim();
      const template = directMetaConfigured
        ? await prisma.metaMessageTemplate.findFirst({
            where: {
              workspaceId: input.workspaceId,
              wabaId,
              name: templateName,
              language: templateLanguage,
              status: "APPROVED"
            }
          })
        : null;

      if (directMetaConfigured && !template) {
        throw new CampaignsServiceError(
          "CAMPAIGN_TEMPLATE_NOT_FOUND",
          "Approved Meta template not found for this workspace."
        );
      }

      const channel = await prisma.channel.findFirst({
        where: {
          workspaceId: input.workspaceId,
          provider: "meta_cloud",
          providerKey: directMetaConfigured ? phoneNumberId : evolutionInstanceName,
          status: "connected"
        },
        orderBy: [{ createdAt: "asc" }]
      });

      if (!channel?.providerKey) {
        throw new CampaignsServiceError(
          "CAMPAIGN_CHANNEL_NOT_FOUND",
          "Connected Meta Cloud channel not found."
        );
      }

      const campaign = await findCampaignForWorkspace(input);
      const plans = await buildRecipientPlans(campaign);
      const components: MetaTemplateComponent[] | undefined = template
        ? validateMetaSendComponents({
            supplied: input.template.components,
            storedComponents: template.components
          })
        : input.template.components?.map((component) => ({
            type: component.type,
            parameters: component.parameters
          })) as MetaTemplateComponent[] | undefined;
      const messagePreview = `Template ${templateName} (${templateLanguage})`;
      let sent = 0;
      let failed = 0;

      for (const plan of plans) {
        const sentAt = now();
        const baseData = {
          workspaceId: input.workspaceId,
          campaignId: input.campaignId,
          contactId: plan.contact.contactId,
          audienceKey: plan.contact.audienceKey,
          contactSnapshot: contactSnapshotToJson(plan.contact),
          scheduledAt: plan.scheduledAt,
          attempts: 1,
          result: buildRecipientResult({
            mode: "real",
            messagePreview,
            templateIndex: 0,
            scheduledAt: plan.scheduledAt,
            cadence: plan.cadence,
            templateName,
            templateLanguage
          })
        };

        try {
          const providerSend = directMetaConfigured
            ? await options.meta!.client!.sendTemplate({
                phoneNumberId: phoneNumberId!,
                to: plan.contact.phone,
                name: templateName,
                language: templateLanguage,
                ...(components ? { components } : {})
              })
            : await options.metaEvolution!.client!.sendTemplate({
                instanceName: evolutionInstanceName!,
                number: plan.contact.phone,
                name: templateName,
                language: templateLanguage,
                ...(components ? { components } : {})
              });

          sent += 1;
          await prisma.campaignRecipient.upsert({
            where: {
              workspaceId_campaignId_audienceKey: {
                workspaceId: input.workspaceId,
                campaignId: input.campaignId,
                audienceKey: plan.contact.audienceKey
              }
            },
            create: {
              ...baseData,
              status: "sent",
              providerMessageId: providerSend.providerMessageId,
              sentAt,
              errorMessage: null,
              result: buildRecipientResult({
                mode: "real",
                result: "sent",
                messagePreview,
                templateIndex: 0,
                scheduledAt: plan.scheduledAt,
                cadence: plan.cadence,
                providerMessageId: providerSend.providerMessageId,
                templateName,
                templateLanguage
              })
            },
            update: {
              ...baseData,
              status: "sent",
              providerMessageId: providerSend.providerMessageId,
              sentAt,
              errorMessage: null,
              result: buildRecipientResult({
                mode: "real",
                result: "sent",
                messagePreview,
                templateIndex: 0,
                scheduledAt: plan.scheduledAt,
                cadence: plan.cadence,
                providerMessageId: providerSend.providerMessageId,
                templateName,
                templateLanguage
              })
            }
          });
        } catch (error) {
          failed += 1;
          await prisma.campaignRecipient.upsert({
            where: {
              workspaceId_campaignId_audienceKey: {
                workspaceId: input.workspaceId,
                campaignId: input.campaignId,
                audienceKey: plan.contact.audienceKey
              }
            },
            create: {
              ...baseData,
              status: "failed",
              errorMessage: error instanceof Error ? error.message : "Send failed."
            },
            update: {
              ...baseData,
              status: "failed",
              errorMessage: error instanceof Error ? error.message : "Send failed."
            }
          });
        }
      }

      await prisma.campaign.update({
        select: { id: true },
        where: {
          workspaceId_id: {
            workspaceId: input.workspaceId,
            id: input.campaignId
          }
        },
        data: {
          status: failed > 0 ? "failed" : "completed",
          mode: "real"
        }
      });

      return {
        mode: "real",
        result: "sent",
        recipientsCreated: plans.length,
        recipientsSent: sent,
        recipientsFailed: failed
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
