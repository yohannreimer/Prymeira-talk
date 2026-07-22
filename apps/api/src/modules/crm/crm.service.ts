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

interface VinculaCompanyRecord {
  id: string | number;
  name?: string | null;
}

interface VinculaDealRecord {
  id: string | number;
}

interface VinculaPipelineRecord {
  id: string | number;
}

interface VinculaSaleRecord {
  id: string | number;
  disabled?: boolean | null;
}

interface VinculaNoteRecord {
  id: string | number;
  text?: string | null;
}

interface VinculaServiceOptions {
  vinculaApiUrl?: string;
  vinculaWebUrl?: string;
  strictReal?: boolean;
  environment?: "local-demo" | "external";
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

function normalizeText(value: string | null | undefined) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim()
    .toLowerCase();
}

function uniqueValues(values: Array<string | null | undefined>) {
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))];
}

function phoneSearchVariants(value: string | null | undefined) {
  const digits = normalizePhone(value);
  const variants = [digits];

  const addBrazilianVariants = (number: string, hasCountryCode: boolean) => {
    const body = hasCountryCode ? number.slice(2) : number;
    if (body.length < 10) return;

    const areaCode = body.slice(0, 2);
    const subscriber = body.slice(2);
    if (subscriber.length === 9 && subscriber.startsWith("9")) {
      variants.push(`${hasCountryCode ? "55" : ""}${areaCode}${subscriber.slice(1)}`);
    }
    if (subscriber.length === 8) {
      variants.push(`${hasCountryCode ? "55" : ""}${areaCode}9${subscriber}`);
    }
  };

  if (digits.startsWith("55")) {
    variants.push(digits.slice(2));
    addBrazilianVariants(digits, true);
    addBrazilianVariants(digits.slice(2), false);
  } else {
    variants.push(`55${digits}`);
    addBrazilianVariants(digits, false);
    addBrazilianVariants(`55${digits}`, true);
  }

  return uniqueValues(variants);
}

function phoneMatches(a: string | null | undefined, b: string | null | undefined) {
  const aVariants = new Set(phoneSearchVariants(a));
  return phoneSearchVariants(b).some((variant) => aVariants.has(variant));
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

function buildVinculaContactPayload(contact: ContactRecord, companyId?: string | number | null) {
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
    ...(companyId ? { company_id: Number(companyId) } : {}),
    first_seen: new Date().toISOString(),
    last_seen: new Date().toISOString()
  };
}

function buildVinculaCompanyPayload(contact: ContactRecord) {
  return {
    name: String(contact.company ?? "").trim(),
    phone_number: contact.phone,
    description: [
      "Empresa criada a partir do Prymeira Talk.",
      contact.name ? `Contato inicial: ${contact.name}` : null,
      contact.phone ? `Telefone do contato: ${contact.phone}` : null
    ]
      .filter(Boolean)
      .join("\n")
  };
}

function buildVinculaDealPayload(
  contact: ContactRecord,
  title: string,
  refs: {
    companyId: string | null;
    contactId: string;
    pipelineId: string;
    ownerId: string;
  }
) {
  return {
    name: title.trim(),
    ...(refs.companyId ? { company_id: Number(refs.companyId) } : {}),
    contact_ids: [Number(refs.contactId)],
    category: "Orçamento",
    deal_type: "consultative",
    probability: 75,
    source: "Prymeira Talk",
    stage: "opportunity",
    description: [
      "Oportunidade qualificada pela IA do Prymeira Talk.",
      contact.name ? `Contato: ${contact.name}` : null,
      contact.phone ? `Telefone: ${contact.phone}` : null,
      contact.company ? `Empresa: ${contact.company}` : null
    ]
      .filter(Boolean)
      .join("\n"),
    amount: 0,
    sales_id: Number(refs.ownerId),
    pipeline_id: Number(refs.pipelineId),
    index: 0
  };
}

function buildOpportunityNote(contact: ContactRecord, title: string, dealId: string) {
  return [
    `Integração Prymeira Talk: ${contact.id}`,
    "Oportunidade criada a partir do atendimento no Prymeira Talk.",
    `Interesse: ${title.trim()}`,
    `Oportunidade Vincula: ${dealId}`,
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
  const vinculaWebUrl = options.vinculaWebUrl ? normalizeBaseUrl(options.vinculaWebUrl) : null;
  const strictReal = options.strictReal ?? false;
  const environment = options.environment ?? "external";
  const fetchCrm = options.fetch ?? fetch;

  function requireStrictRealConfiguration(token: string | null | undefined) {
    if (!strictReal) return;
    if (vinculaApiUrl && vinculaWebUrl && token) return;

    throw new CrmServiceError(
      "VINCULA_SYNC_FAILED",
      "Vincula local integration is not fully configured.",
      503
    );
  }

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
      const statusCode =
        response.status === 401 || response.status === 403 || response.status === 404
          ? response.status
          : 502;
      throw new CrmServiceError("VINCULA_SYNC_FAILED", await readVinculaError(response), statusCode);
    }

    return response.json() as Promise<T>;
  }

  function buildListPath(resource: string, filter: Record<string, unknown>, perPage = 10) {
    const params = new URLSearchParams({
      filter: JSON.stringify(filter),
      pagination: JSON.stringify({ page: 1, perPage }),
      sort: JSON.stringify({ field: "id", order: "ASC" })
    });

    return `/records/${resource}?${params.toString()}`;
  }

  function buildVinculaRecordUrl(input: { dealId?: string | null; contactId: string }) {
    if (!vinculaWebUrl) return null;
    return input.dealId
      ? `${vinculaWebUrl}/deals/${encodeURIComponent(input.dealId)}/show`
      : `${vinculaWebUrl}/contacts/${encodeURIComponent(input.contactId)}/show`;
  }

  async function resolveOpportunityReferences(token: string) {
    if (environment === "local-demo") {
      return { pipelineId: "9201", ownerId: "9101" };
    }

    const [pipelines, sales] = await Promise.all([
      vinculaRequest<VinculaList<VinculaPipelineRecord>>(
        token,
        buildListPath("pipelines", {}, 1)
      ),
      vinculaRequest<VinculaList<VinculaSaleRecord>>(
        token,
        buildListPath("sales", { disabled: false }, 10)
      )
    ]);
    const pipeline = pipelines.data[0];
    const owner = sales.data.find((sale) => sale.disabled !== true);
    if (!pipeline?.id || !owner?.id) {
      throw new CrmServiceError(
        "VINCULA_SYNC_FAILED",
        "Vincula has no active commercial pipeline or owner.",
        502
      );
    }

    return { pipelineId: String(pipeline.id), ownerId: String(owner.id) };
  }

  async function findVinculaCompanyByName(token: string, contact: ContactRecord) {
    const companyName = String(contact.company ?? "").trim();
    if (!companyName) return null;

    const response = await vinculaRequest<VinculaList<VinculaCompanyRecord>>(
      token,
      buildListPath("companies", { q: companyName })
    );
    const normalizedCompanyName = normalizeText(companyName);

    return (
      response.data.find((candidate) => normalizeText(candidate.name) === normalizedCompanyName) ??
      null
    );
  }

  async function upsertVinculaCompany(token: string, contact: ContactRecord) {
    if (!String(contact.company ?? "").trim()) return null;

    const existing = await findVinculaCompanyByName(token, contact);
    if (existing?.id) return existing;

    const created = await vinculaRequest<VinculaRecord<VinculaCompanyRecord>>(token, "/records/companies", {
      method: "POST",
      body: JSON.stringify(buildVinculaCompanyPayload(contact))
    });

    return created.data;
  }

  async function findVinculaContactByPhone(token: string, contact: ContactRecord) {
    const phoneVariants = phoneSearchVariants(contact.phone);
    if (!phoneVariants.length) return null;

    for (const phone of phoneVariants) {
      const response = await vinculaRequest<VinculaList<VinculaContactRecord>>(
        token,
        buildListPath("contacts", { q: phone })
      );
      const exactMatch =
        response.data.find((candidate) =>
          (candidate.phone_jsonb ?? []).some((phoneEntry) =>
            phoneMatches(phoneEntry.number, contact.phone)
          )
        ) ?? null;

      if (exactMatch) return exactMatch;
    }

    return null;
  }

  async function upsertVinculaContact(
    token: string,
    contact: ContactRecord,
    companyId?: string | number | null
  ) {
    const payload = buildVinculaContactPayload(contact, companyId);
    const existingCrmId =
      contact.atomicCrmContactId && /^\d+$/.test(contact.atomicCrmContactId)
        ? contact.atomicCrmContactId
        : null;
    const updateContact = async (id: string | number) =>
      (
        await vinculaRequest<VinculaRecord<VinculaContactRecord>>(
          token,
          `/records/contacts/${encodeURIComponent(String(id))}`,
          {
            method: "PATCH",
            body: JSON.stringify(payload)
          }
        )
      ).data;

    if (existingCrmId) {
      try {
        return await updateContact(existingCrmId);
      } catch (error) {
        if (!(error instanceof CrmServiceError) || error.statusCode !== 404) throw error;
      }
    }

    const existing = await findVinculaContactByPhone(token, contact);
    if (existing?.id) {
      return updateContact(existing.id);
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

  async function findVinculaDeal(
    token: string,
    title: string,
    refs: { companyId: string | null; contactId: string }
  ) {
    const response = await vinculaRequest<VinculaList<VinculaDealRecord>>(
      token,
      buildListPath("deals", {
        name: title.trim(),
        source: "Prymeira Talk",
        "contact_ids@cs": [Number(refs.contactId)],
        ...(refs.companyId ? { company_id: Number(refs.companyId) } : {})
      })
    );
    return response.data[0] ?? null;
  }

  async function upsertVinculaDeal(
    token: string,
    contact: ContactRecord,
    title: string,
    refs: {
      companyId: string | null;
      contactId: string;
      pipelineId: string;
      ownerId: string;
    }
  ) {
    const payload = buildVinculaDealPayload(contact, title, refs);
    const existingDealId =
      contact.atomicCrmLeadId && /^\d+$/.test(contact.atomicCrmLeadId)
        ? contact.atomicCrmLeadId
        : null;
    const updateDeal = async (id: string | number) =>
      (
        await vinculaRequest<VinculaRecord<VinculaDealRecord>>(
          token,
          `/records/deals/${encodeURIComponent(String(id))}`,
          { method: "PATCH", body: JSON.stringify(payload) }
        )
      ).data;

    if (existingDealId) {
      try {
        return { deal: await updateDeal(existingDealId), created: false, matchedByLookup: false };
      } catch (error) {
        if (!(error instanceof CrmServiceError) || error.statusCode !== 404) throw error;
      }
    }

    const existing = await findVinculaDeal(token, title, refs);
    if (existing?.id) {
      return { deal: await updateDeal(existing.id), created: false, matchedByLookup: true };
    }

    const created = await vinculaRequest<VinculaRecord<VinculaDealRecord>>(token, "/records/deals", {
      method: "POST",
      body: JSON.stringify(payload)
    });

    return { deal: created.data, created: true, matchedByLookup: false };
  }

  async function createVinculaDealNote(
    token: string,
    input: { dealId: string; ownerId: string; text: string }
  ) {
    return (
      await vinculaRequest<VinculaRecord<VinculaNoteRecord>>(token, "/records/deal_notes", {
        method: "POST",
        body: JSON.stringify({
          deal_id: Number(input.dealId),
          text: input.text,
          sales_id: Number(input.ownerId),
          type: "note"
        })
      })
    ).data;
  }

  async function createVinculaContactNote(
    token: string,
    input: { contactId: string; text: string }
  ) {
    return (
      await vinculaRequest<VinculaRecord<VinculaNoteRecord>>(token, "/records/contact_notes", {
        method: "POST",
        body: JSON.stringify({
          contact_id: Number(input.contactId),
          text: input.text,
          status: "completed"
        })
      })
    ).data;
  }

  async function ensureInitialVinculaDealNote(
    token: string,
    input: {
      dealId: string;
      ownerId: string;
      contact: ContactRecord;
      title: string;
    }
  ) {
    const marker = `Integração Prymeira Talk: ${input.contact.id}`;
    const response = await vinculaRequest<VinculaList<VinculaNoteRecord>>(
      token,
      buildListPath("deal_notes", { deal_id: Number(input.dealId) }, 100)
    );
    const existing = response.data.find((note) => String(note.text ?? "").includes(marker));
    if (existing) return existing;

    return createVinculaDealNote(token, {
      dealId: input.dealId,
      ownerId: input.ownerId,
      text: buildOpportunityNote(input.contact, input.title, input.dealId)
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
      requireStrictRealConfiguration(input.vinculaToken);

      if (vinculaApiUrl && input.vinculaToken) {
        const vinculaCompany = await upsertVinculaCompany(input.vinculaToken, contact);
        const vinculaCompanyId = vinculaCompany?.id ? String(vinculaCompany.id) : null;
        const vinculaContact = await upsertVinculaContact(input.vinculaToken, contact, vinculaCompanyId);
        const vinculaContactId = String(vinculaContact.id);
        const references = await resolveOpportunityReferences(input.vinculaToken);
        const { deal: vinculaDeal, created: dealCreated, matchedByLookup } = await upsertVinculaDeal(
          input.vinculaToken,
          contact,
          title,
          {
            companyId: vinculaCompanyId,
            contactId: vinculaContactId,
            ...references
          }
        );
        const vinculaDealId = String(vinculaDeal.id);
        let vinculaNote: VinculaNoteRecord | null = null;

        if (dealCreated) {
          vinculaNote = await createVinculaDealNote(input.vinculaToken, {
            dealId: vinculaDealId,
            ownerId: references.ownerId,
            text: buildOpportunityNote(contact, title, vinculaDealId)
          });
        } else if (matchedByLookup && !contact.atomicCrmLeadId) {
          vinculaNote = await ensureInitialVinculaDealNote(input.vinculaToken, {
            dealId: vinculaDealId,
            ownerId: references.ownerId,
            contact,
            title
          });
        }

        await prisma.contact.update({
          where: {
            workspaceId_id: {
              workspaceId: input.workspaceId,
              id: input.contactId
            }
          },
          data: {
            atomicCrmContactId: vinculaContactId,
            atomicCrmLeadId: vinculaDealId
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
              vinculaCompanyId,
              vinculaDealId,
              provider: "vincula"
            },
            result: {
              mode: "real",
              environment,
              dealCreated,
              dealUpdated: !dealCreated,
              vinculaContactId,
              vinculaCompanyId,
              vinculaDealId,
              vinculaNoteId: vinculaNote?.id ? String(vinculaNote.id) : null,
              vinculaRecordUrl: buildVinculaRecordUrl({
                dealId: vinculaDealId,
                contactId: vinculaContactId
              })
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
      requireStrictRealConfiguration(input.vinculaToken);

      if (vinculaApiUrl && input.vinculaToken) {
        const vinculaCompany = await upsertVinculaCompany(input.vinculaToken, contact);
        const vinculaCompanyId = vinculaCompany?.id ? String(vinculaCompany.id) : null;
        const vinculaContact = await upsertVinculaContact(input.vinculaToken, contact, vinculaCompanyId);
        const vinculaContactId = String(vinculaContact.id);
        const vinculaDealId =
          contact.atomicCrmLeadId && /^\d+$/.test(contact.atomicCrmLeadId)
            ? contact.atomicCrmLeadId
            : null;
        const note = vinculaDealId
          ? await createVinculaDealNote(input.vinculaToken, {
              dealId: vinculaDealId,
              ownerId: (await resolveOpportunityReferences(input.vinculaToken)).ownerId,
              text: input.body.trim()
            })
          : await createVinculaContactNote(input.vinculaToken, {
              contactId: vinculaContactId,
              text: input.body.trim()
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
              vinculaCompanyId,
              vinculaDealId,
              provider: "vincula"
            },
            result: {
              mode: "real",
              environment,
              noteCreated: true,
              vinculaContactId,
              vinculaCompanyId,
              vinculaDealId,
              vinculaNoteId: note?.id ? String(note.id) : null,
              vinculaRecordUrl: buildVinculaRecordUrl({
                dealId: vinculaDealId,
                contactId: vinculaContactId
              })
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
