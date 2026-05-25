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
type ContactUpdateArgs = Parameters<PrismaClient["contact"]["update"]>[0];

interface ContactRecord {
  id: string;
  workspaceId: string;
  name: string | null;
  phone: string;
  email: string | null;
  company: string | null;
  atomicCrmContactId: string | null;
  atomicCrmLeadId: string | null;
  updatedAt?: DateLike;
}

export interface PrismaLike {
  contact: {
    findUnique(args: ContactFindUniqueArgs): Promise<ContactRecord | null>;
    update(args: ContactUpdateArgs): Promise<ContactRecord>;
  };
  crmSyncAction: {
    create(args: CrmSyncActionCreateArgs): Promise<CrmSyncActionRecord>;
    findMany(args: CrmSyncActionFindManyArgs): Promise<CrmSyncActionRecord[]>;
  };
}

export class CrmServiceError extends Error {
  constructor(
    public code: "CRM_CONTACT_NOT_FOUND" | "VINCULA_SYNC_FAILED",
    message: string,
    public statusCode = 404
  ) {
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

type FetchLike = typeof fetch;

interface VinculaRecord<T> {
  data: T;
}

interface VinculaList<T> {
  data: T[];
  total?: number;
}

interface VinculaContactRecord {
  id: string | number;
  first_name?: string | null;
  last_name?: string | null;
  phone_jsonb?: Array<{ number?: string | null }> | null;
}

interface VinculaLeadRecord {
  id: string | number;
}

interface VinculaServiceOptions {
  vinculaApiUrl?: string;
  fetch?: FetchLike;
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

function normalizeBaseUrl(url: string) {
  return url.replace(/\/$/, "");
}

function normalizePhone(value: string | null | undefined) {
  return String(value ?? "").replace(/\D/g, "");
}

function splitContactName(contact: ContactRecord) {
  const fallback = contact.phone ? `Contato ${contact.phone.slice(-4)}` : "Contato Talk";
  const parts = String(contact.name ?? "").trim().split(/\s+/).filter(Boolean);

  if (!parts.length) {
    return { firstName: fallback, lastName: "" };
  }

  return {
    firstName: parts[0] ?? fallback,
    lastName: parts.slice(1).join(" ")
  };
}

function buildVinculaContactPayload(contact: ContactRecord) {
  const { firstName, lastName } = splitContactName(contact);

  return {
    first_name: firstName,
    last_name: lastName,
    title: "Contato via Prymeira Talk",
    status: "active",
    background: [
      "Origem: Prymeira Talk",
      contact.company ? `Empresa: ${contact.company}` : null,
      `Telefone: ${contact.phone}`
    ]
      .filter(Boolean)
      .join("\n"),
    email_jsonb: contact.email ? [{ email: contact.email, type: "Work" }] : [],
    phone_jsonb: contact.phone ? [{ number: contact.phone, type: "Work" }] : [],
    first_seen: new Date().toISOString(),
    last_seen: new Date().toISOString()
  };
}

function buildVinculaLeadPayload(contact: ContactRecord, title: string) {
  const { firstName, lastName } = splitContactName(contact);

  return {
    first_name: firstName,
    last_name: lastName,
    email: contact.email,
    phone_number: contact.phone,
    company_name: contact.company,
    source: "Prymeira Talk / WhatsApp",
    interest: title.trim(),
    temperature: "warm",
    status: "new"
  };
}

function buildLeadNote(contact: ContactRecord, title: string, leadId: string) {
  return [
    "Lead criado a partir do Prymeira Talk.",
    `Interesse: ${title.trim()}`,
    `Lead Vincula: ${leadId}`,
    contact.name ? `Contato: ${contact.name}` : null,
    contact.phone ? `Telefone: ${contact.phone}` : null,
    contact.company ? `Empresa: ${contact.company}` : null
  ]
    .filter(Boolean)
    .join("\n");
}

async function readVinculaError(response: Response) {
  const payload = await response.json().catch(() => null);
  const message =
    typeof payload?.error?.message === "string"
      ? payload.error.message
      : typeof payload?.message === "string"
        ? payload.message
        : `Vincula API returned ${response.status}.`;

  return message;
}

export function createCrmService(prisma: PrismaLike, options: VinculaServiceOptions = {}) {
  const vinculaApiUrl = options.vinculaApiUrl ? normalizeBaseUrl(options.vinculaApiUrl) : null;
  const fetchCrm = options.fetch ?? fetch;

  async function vinculaRequest<T>(
    token: string,
    path: string,
    init: RequestInit = {}
  ): Promise<T> {
    if (!vinculaApiUrl) {
      throw new Error("Vincula API URL is not configured.");
    }

    const response = await fetchCrm(`${vinculaApiUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(init.headers ?? {})
      }
    });

    if (!response.ok) {
      const statusCode = response.status === 401 || response.status === 403 ? response.status : 502;
      throw new CrmServiceError("VINCULA_SYNC_FAILED", await readVinculaError(response), statusCode);
    }

    return response.json() as Promise<T>;
  }

  async function findVinculaContactByPhone(token: string, contact: ContactRecord) {
    const phone = normalizePhone(contact.phone);
    if (!phone) return null;

    const params = new URLSearchParams({
      filter: JSON.stringify({ q: phone }),
      pagination: JSON.stringify({ page: 1, perPage: 10 }),
      sort: JSON.stringify({ field: "id", order: "ASC" })
    });
    const response = await vinculaRequest<VinculaList<VinculaContactRecord>>(
      token,
      `/records/contacts?${params.toString()}`
    );

    return (
      response.data.find((candidate) =>
        (candidate.phone_jsonb ?? []).some((phoneEntry) =>
          normalizePhone(phoneEntry.number).endsWith(phone)
        )
      ) ??
      response.data[0] ??
      null
    );
  }

  async function upsertVinculaContact(token: string, contact: ContactRecord) {
    const payload = buildVinculaContactPayload(contact);
    const existingCrmId =
      contact.atomicCrmContactId && /^\d+$/.test(contact.atomicCrmContactId)
        ? contact.atomicCrmContactId
        : null;
    const existing = existingCrmId
      ? ({ id: existingCrmId } as VinculaContactRecord)
      : await findVinculaContactByPhone(token, contact);

    if (existing?.id) {
      const updated = await vinculaRequest<VinculaRecord<VinculaContactRecord>>(
        token,
        `/records/contacts/${encodeURIComponent(String(existing.id))}`,
        {
          method: "PATCH",
          body: JSON.stringify(payload)
        }
      );

      return updated.data;
    }

    const created = await vinculaRequest<VinculaRecord<VinculaContactRecord>>(
      token,
      "/records/contacts",
      {
        method: "POST",
        body: JSON.stringify(payload)
      }
    );

    return created.data;
  }

  async function createVinculaLead(token: string, contact: ContactRecord, title: string) {
    const created = await vinculaRequest<VinculaRecord<VinculaLeadRecord>>(token, "/records/leads", {
      method: "POST",
      body: JSON.stringify(buildVinculaLeadPayload(contact, title))
    });

    return created.data;
  }

  async function createVinculaContactNote(
    token: string,
    input: { vinculaContactId: string; contact: ContactRecord; title: string; leadId: string }
  ) {
    await vinculaRequest<VinculaRecord<unknown>>(token, "/records/contact_notes", {
      method: "POST",
      body: JSON.stringify({
        contact_id: Number(input.vinculaContactId),
        text: buildLeadNote(input.contact, input.title, input.leadId),
        status: "completed"
      })
    });
  }

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
        workspaceId: true,
        name: true,
        phone: true,
        email: true,
        company: true,
        atomicCrmContactId: true,
        atomicCrmLeadId: true
      }
    });

    if (!contact) {
      throw new CrmServiceError("CRM_CONTACT_NOT_FOUND", "CRM contact not found.");
    }

    return contact;
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

      if (input.atomicCrmContactId) {
        await prisma.contact.update({
          where: {
            workspaceId_id: {
              workspaceId: input.workspaceId,
              id: input.contactId
            }
          },
          data: {
            atomicCrmContactId: input.atomicCrmContactId
          }
        });
      }

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
      vinculaToken?: string | null;
    }): Promise<CrmSyncActionDto> {
      const contact = await ensureContactInWorkspace(input);
      const title = input.title.trim();

      if (vinculaApiUrl && input.vinculaToken) {
        const vinculaContact = await upsertVinculaContact(input.vinculaToken, contact);
        const vinculaContactId = String(vinculaContact.id);
        const vinculaLead = await createVinculaLead(input.vinculaToken, contact, title);
        const vinculaLeadId = String(vinculaLead.id);

        await createVinculaContactNote(input.vinculaToken, {
          vinculaContactId,
          contact,
          title,
          leadId: vinculaLeadId
        });

        await prisma.contact.update({
          where: {
            workspaceId_id: {
              workspaceId: input.workspaceId,
              id: input.contactId
            }
          },
          data: {
            atomicCrmContactId: vinculaContactId,
            atomicCrmLeadId: vinculaLeadId
          }
        });

        const action = await prisma.crmSyncAction.create({
          data: {
            workspaceId: input.workspaceId,
            contactId: input.contactId,
            actionType: "create_lead",
            mode: "real",
            status: "completed",
            payload: {
              contactId: input.contactId,
              title,
              vinculaContactId,
              provider: "vincula"
            },
            result: {
              mode: "real",
              leadCreated: true,
              vinculaContactId,
              vinculaLeadId
            }
          }
        });

        return toActionDto(action);
      }

      return createSimulatedAction({
        workspaceId: input.workspaceId,
        contactId: input.contactId,
        actionType: "create_lead",
        payload: {
          contactId: input.contactId,
          title
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
      vinculaToken?: string | null;
    }): Promise<CrmSyncActionDto> {
      const contact = await ensureContactInWorkspace(input);

      if (vinculaApiUrl && input.vinculaToken) {
        const vinculaContact = await upsertVinculaContact(input.vinculaToken, contact);
        const vinculaContactId = String(vinculaContact.id);

        await vinculaRequest<VinculaRecord<unknown>>(input.vinculaToken, "/records/contact_notes", {
          method: "POST",
          body: JSON.stringify({
            contact_id: Number(vinculaContactId),
            text: input.body.trim(),
            status: "completed"
          })
        });

        await prisma.contact.update({
          where: {
            workspaceId_id: {
              workspaceId: input.workspaceId,
              id: input.contactId
            }
          },
          data: {
            atomicCrmContactId: vinculaContactId
          }
        });

        const action = await prisma.crmSyncAction.create({
          data: {
            workspaceId: input.workspaceId,
            contactId: input.contactId,
            actionType: "create_note",
            mode: "real",
            status: "completed",
            payload: {
              contactId: input.contactId,
              body: input.body.trim(),
              vinculaContactId,
              provider: "vincula"
            },
            result: {
              mode: "real",
              noteCreated: true,
              vinculaContactId
            }
          }
        });

        return toActionDto(action);
      }

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
