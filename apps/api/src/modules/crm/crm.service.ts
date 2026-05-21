import type { Prisma, PrismaClient } from "@prisma/client";

type DateLike = Date | string;

interface CrmSyncActionRecord {
  id: string;
  workspaceId: string;
  contactId: string | null;
  actionType: string;
  mode: "simulated" | "real";
  status: string;
  payload: Prisma.JsonValue;
  result: Prisma.JsonValue;
  createdAt: DateLike;
  updatedAt: DateLike;
}

type CrmSyncActionCreateArgs = Parameters<PrismaClient["crmSyncAction"]["create"]>[0];
type CrmSyncActionFindManyArgs = Parameters<PrismaClient["crmSyncAction"]["findMany"]>[0];
type ContactFindUniqueArgs = Parameters<PrismaClient["contact"]["findUnique"]>[0];

export interface PrismaLike {
  contact: {
    findUnique(args: ContactFindUniqueArgs): Promise<{ id: string; workspaceId: string } | null>;
  };
  crmSyncAction: {
    create(args: CrmSyncActionCreateArgs): Promise<CrmSyncActionRecord>;
    findMany(args: CrmSyncActionFindManyArgs): Promise<CrmSyncActionRecord[]>;
  };
}

export class CrmServiceError extends Error {
  constructor(public code: "CRM_CONTACT_NOT_FOUND", message: string) {
    super(message);
  }
}

export interface CrmSyncActionDto {
  id: string;
  workspaceId: string;
  contactId: string | null;
  actionType: string;
  mode: "simulated" | "real";
  status: string;
  payload: Prisma.JsonValue;
  result: Prisma.JsonValue;
  createdAt: string;
  updatedAt: string;
}

function toIsoString(value: DateLike) {
  return value instanceof Date ? value.toISOString() : value;
}

function toActionDto(record: CrmSyncActionRecord): CrmSyncActionDto {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    contactId: record.contactId,
    actionType: record.actionType,
    mode: record.mode,
    status: record.status,
    payload: record.payload,
    result: record.result,
    createdAt: toIsoString(record.createdAt),
    updatedAt: toIsoString(record.updatedAt)
  };
}

export function createCrmService(prisma: PrismaLike) {
  const ensureContactInWorkspace = async (input: { workspaceId: string; contactId: string }) => {
    const contact = await prisma.contact.findUnique({
      where: {
        workspaceId_id: {
          workspaceId: input.workspaceId,
          id: input.contactId
        }
      },
      select: {
        id: true,
        workspaceId: true
      }
    });

    if (!contact) {
      throw new CrmServiceError("CRM_CONTACT_NOT_FOUND", "CRM contact not found.");
    }
  };

  const createSimulatedAction = async (input: {
    workspaceId: string;
    contactId?: string | null;
    actionType: "link_contact" | "create_lead" | "create_note";
    payload: Prisma.InputJsonValue;
    result: Prisma.InputJsonValue;
  }) => {
    const action = await prisma.crmSyncAction.create({
      data: {
        workspaceId: input.workspaceId,
        contactId: input.contactId ?? null,
        actionType: input.actionType,
        mode: "simulated",
        status: "completed",
        payload: input.payload,
        result: input.result
      }
    });

    return toActionDto(action);
  };

  return {
    async listSyncActions(input: {
      workspaceId: string;
      contactId?: string;
    }): Promise<CrmSyncActionDto[]> {
      const actions = await prisma.crmSyncAction.findMany({
        where: {
          workspaceId: input.workspaceId,
          ...(input.contactId ? { contactId: input.contactId } : {})
        },
        orderBy: [{ createdAt: "desc" }],
        take: 100
      });

      return actions.map(toActionDto);
    },

    async linkContact(input: {
      workspaceId: string;
      contactId: string;
      atomicCrmContactId?: string;
    }): Promise<CrmSyncActionDto> {
      await ensureContactInWorkspace(input);

      return createSimulatedAction({
        workspaceId: input.workspaceId,
        contactId: input.contactId,
        actionType: "link_contact",
        payload: {
          contactId: input.contactId,
          atomicCrmContactId: input.atomicCrmContactId ?? null
        },
        result: {
          mode: "simulated",
          linked: true,
          atomicCrmContactId: input.atomicCrmContactId ?? `simulated-contact-${input.contactId}`
        }
      });
    },

    async createLead(input: {
      workspaceId: string;
      contactId: string;
      title: string;
    }): Promise<CrmSyncActionDto> {
      await ensureContactInWorkspace(input);

      return createSimulatedAction({
        workspaceId: input.workspaceId,
        contactId: input.contactId,
        actionType: "create_lead",
        payload: {
          contactId: input.contactId,
          title: input.title.trim()
        },
        result: {
          mode: "simulated",
          leadCreated: true,
          atomicCrmLeadId: `simulated-lead-${input.contactId}`
        }
      });
    },

    async createNote(input: {
      workspaceId: string;
      contactId: string;
      body: string;
    }): Promise<CrmSyncActionDto> {
      await ensureContactInWorkspace(input);

      return createSimulatedAction({
        workspaceId: input.workspaceId,
        contactId: input.contactId,
        actionType: "create_note",
        payload: {
          contactId: input.contactId,
          body: input.body.trim()
        },
        result: {
          mode: "simulated",
          noteCreated: true
        }
      });
    }
  };
}
