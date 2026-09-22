import type { Prisma, PrismaClient } from "@prisma/client";
import type {
  LeadCampaignDraftResult,
  LeadComposerDraft,
  LeadContactProvenanceSummary,
  LeadContactImportResult,
  LeadContactSourceTagSummary,
  LeadSource,
  LeadWhatsappStatus
} from "@prymeira-talk/shared";
import {
  buildPhoneLookupCandidates,
  normalizePhoneForStorage
} from "../contacts/phone-normalization.js";
import { whatsappPhoneCandidates } from "./lead-whatsapp-numbers.js";

const DEFAULT_QUICK_REPLY_TITLE = "Prospecção — Clínica padrão";
const DEFAULT_QUICK_REPLY_CATEGORY = "Prospecção";
const DEFAULT_QUICK_REPLY_BODY =
  "Olá, tudo bem? Vi a {{company}} e queria entender como vocês organizam o atendimento pelo WhatsApp hoje.";
const MAX_SELECTED_LEADS = 5000;

type ConversionErrorCode =
  | "LEAD_SELECTION_REQUIRED"
  | "LEAD_SELECTION_INVALID"
  | "LEAD_CAMPAIGN_COMMON_BODY_REQUIRED"
  | "LEAD_CAMPAIGN_TEMPLATE_NOT_FOUND"
  | "LEAD_CAMPAIGN_EMPTY";

export class LeadConversionError extends Error {
  constructor(public readonly code: ConversionErrorCode, message: string) {
    super(message);
    this.name = "LeadConversionError";
  }
}

export interface LeadConversionActor {
  id: string;
  role?: string;
}

export interface LeadConversionServiceOptions {
  now?: () => Date;
}

type TransactionClient = Prisma.TransactionClient;

interface PrismaLike {
  $transaction<T>(callback: (tx: TransactionClient) => Promise<T>): Promise<T>;
  conversation: PrismaClient["conversation"];
  leadContactProvenance: PrismaClient["leadContactProvenance"];
}

function uniqueSelection(selectedLeadIds: string[]) {
  const ids = [...new Set(selectedLeadIds)];
  if (ids.length === 0) {
    throw new LeadConversionError("LEAD_SELECTION_REQUIRED", "Select at least one lead.");
  }
  if (ids.length !== selectedLeadIds.length || ids.length > MAX_SELECTED_LEADS) {
    throw new LeadConversionError("LEAD_SELECTION_INVALID", "Lead selection is invalid.");
  }
  return ids;
}

function jsonStrings(value: Prisma.JsonValue) {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function validPhone(value: string | null | undefined) {
  if (!value) return null;
  const phone = normalizePhoneForStorage(value);
  return phone.length >= 10 && phone.length <= 15 ? phone : null;
}

interface VerificationRow {
  id: string;
  leadId: string;
  normalizedPhone: string;
  status: LeadWhatsappStatus;
  checkedAt: Date | null;
  createdAt: Date;
}

function timestamp(value: Date | null | undefined) {
  return value?.getTime() ?? 0;
}

function sortedVerifications<T extends VerificationRow>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const checked = timestamp(b.checkedAt) - timestamp(a.checkedAt);
    const created = timestamp(b.createdAt) - timestamp(a.createdAt);
    if (checked || created) return checked || created;
    return a.id === b.id ? 0 : a.id < b.id ? 1 : -1;
  });
}

function currentPhoneState(input: {
  normalizedPhone: string | null;
  phones: Prisma.JsonValue;
  verifications: VerificationRow[];
}) {
  const candidates = [input.normalizedPhone, ...jsonStrings(input.phones)]
    .map(validPhone)
    .filter((phone): phone is string => phone !== null)
    .filter((phone, index, phones) => phones.indexOf(phone) === index);
  const candidateByKey = new Map<string, string>();
  for (const candidate of candidates) {
    const key = whatsappPhoneCandidates(candidate)?.key ?? candidate;
    if (!candidateByKey.has(key)) candidateByKey.set(key, candidate);
  }
  const latestByPhone = new Map<string, VerificationRow & { currentPhone: string }>();
  for (const verification of sortedVerifications(input.verifications)) {
    const phone = whatsappPhoneCandidates(verification.normalizedPhone)?.key ?? validPhone(verification.normalizedPhone);
    const currentPhone = phone ? candidateByKey.get(phone) : null;
    if (!phone || !currentPhone || latestByPhone.has(phone)) continue;
    latestByPhone.set(phone, { ...verification, currentPhone });
  }
  const currentVerifications = sortedVerifications([...latestByPhone.values()]);
  const available = currentVerifications.find((verification) => verification.status === "available");
  const whatsappStatus: LeadWhatsappStatus = currentVerifications[0]?.status ?? "unverified";
  return {
    phone: available?.currentPhone ?? candidates[0] ?? null,
    whatsappStatus
  };
}

function sourceTag(source: LeadSource) {
  return source === "google_maps"
    ? { name: "Origem: Lead Google", color: "#1c6653" }
    : { name: "Origem: Lead Receita", color: "#6b4bb5" };
}

function toIso(value: Date | string) {
  return value instanceof Date ? value.toISOString() : value;
}

function provenanceSummary(record: {
  id: string;
  source: LeadSource;
  listId: string;
  importedAt: Date | string;
  whatsappStatus: LeadWhatsappStatus;
  suggestedMessage: string | null;
}): LeadContactProvenanceSummary {
  return {
    id: record.id,
    source: record.source,
    listId: record.listId,
    importedAt: toIso(record.importedAt),
    whatsappStatus: record.whatsappStatus,
    suggestedMessage: record.suggestedMessage
  };
}

async function ensureSourceTag(input: {
  tx: TransactionClient;
  workspaceId: string;
  contactId: string;
  source: LeadSource;
}): Promise<LeadContactSourceTagSummary> {
  const definition = sourceTag(input.source);
  const tag = await input.tx.tag.upsert({
    where: {
      workspaceId_name: { workspaceId: input.workspaceId, name: definition.name }
    },
    update: { color: definition.color, isActive: true },
    create: {
      workspaceId: input.workspaceId,
      name: definition.name,
      color: definition.color,
      useGuide: "",
      isActive: true
    }
  });
  await input.tx.contactTag.upsert({
    where: {
      workspaceId_contactId_tagId: {
        workspaceId: input.workspaceId,
        contactId: input.contactId,
        tagId: tag.id
      }
    },
    update: {},
    create: {
      workspaceId: input.workspaceId,
      contactId: input.contactId,
      tagId: tag.id
    }
  });
  return definition;
}

function isUniqueConflict(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}

function leadDisplayName(lead: { tradeName: string | null; companyName: string | null }) {
  return lead.tradeName?.trim() || lead.companyName?.trim() || null;
}

function leadCompany(lead: { tradeName: string | null; companyName: string | null }) {
  return lead.companyName?.trim() || lead.tradeName?.trim() || null;
}

function renderCompany(body: string, company: string | null) {
  return body.replace(/\{\{\s*company\s*\}\}/gi, company || "sua empresa");
}

async function ensureDefaultQuickReply(tx: TransactionClient, workspaceId: string) {
  const lockKey = `lead-conversion:${workspaceId}:${DEFAULT_QUICK_REPLY_TITLE}`;
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
  const existing = await tx.quickReply.findFirst({
    where: { workspaceId, title: DEFAULT_QUICK_REPLY_TITLE },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }]
  });
  if (existing) return existing;
  return tx.quickReply.create({
    data: {
      workspaceId,
      title: DEFAULT_QUICK_REPLY_TITLE,
      category: DEFAULT_QUICK_REPLY_CATEGORY,
      body: DEFAULT_QUICK_REPLY_BODY
    }
  });
}

function campaignRow(provenance: {
  id: string;
  leadId: string;
  contact: {
    id: string;
    name: string | null;
    phone: string;
    email: string | null;
    company: string | null;
  };
}) {
  return {
    name: provenance.contact.name ?? undefined,
    phone: provenance.contact.phone,
    fields: {
      contactId: provenance.contact.id,
      leadId: provenance.leadId,
      provenanceId: provenance.id,
      company: provenance.contact.company ?? "",
      email: provenance.contact.email ?? ""
    }
  };
}

export function createLeadConversionService(
  prisma: PrismaLike,
  options: LeadConversionServiceOptions = {}
) {
  const now = options.now ?? (() => new Date());

  return {
    async importSelectedLeads(input: {
      workspaceId: string;
      selectedLeadIds: string[];
      actor: LeadConversionActor;
    }): Promise<LeadContactImportResult> {
      const selectedLeadIds = uniqueSelection(input.selectedLeadIds);

      return prisma.$transaction(async (tx) => {
        const leads = await tx.lead.findMany({
          where: { workspaceId: input.workspaceId, id: { in: selectedLeadIds } },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }]
        });
        if (leads.length !== selectedLeadIds.length) {
          throw new LeadConversionError(
            "LEAD_SELECTION_INVALID",
            "One or more selected leads do not belong to this workspace."
          );
        }

        const existingProvenances = await tx.leadContactProvenance.findMany({
          where: { workspaceId: input.workspaceId, leadId: { in: selectedLeadIds } },
          include: { contact: { select: { phone: true } } }
        });
        const existingByLead = new Map(existingProvenances.map((row) => [row.leadId, row]));
        const pendingLeads = leads.filter((row) => !existingByLead.has(row.id));
        const verifications = pendingLeads.length > 0
          ? await tx.leadWhatsappVerification.findMany({
              where: { workspaceId: input.workspaceId, leadId: { in: pendingLeads.map((row) => row.id) } },
              orderBy: [{ checkedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }]
            })
          : [];
        const verificationByLead = new Map<string, VerificationRow[]>();
        for (const verification of verifications) {
          const rows = verificationByLead.get(verification.leadId) ?? [];
          rows.push(verification as VerificationRow);
          verificationByLead.set(verification.leadId, rows);
        }

        const quickReply = pendingLeads.length > 0
          ? await ensureDefaultQuickReply(tx, input.workspaceId)
          : null;
        const contacts: LeadContactImportResult["contacts"] = [];

        for (const lead of leads) {
          const existingProvenance = existingByLead.get(lead.id);
          if (existingProvenance) {
            const tag = await ensureSourceTag({
              tx,
              workspaceId: input.workspaceId,
              contactId: existingProvenance.contactId,
              source: existingProvenance.source
            });
            contacts.push({
              leadId: lead.id,
              contactId: existingProvenance.contactId,
              provenanceId: existingProvenance.id,
              phone: existingProvenance.contact?.phone ?? null,
              status: "reconciled",
              reason: null,
              sourceTag: tag,
              provenance: provenanceSummary(existingProvenance)
            });
            continue;
          }

          const leadVerifications = verificationByLead.get(lead.id) ?? [];
          const phoneState = currentPhoneState({
            normalizedPhone: lead.normalizedPhone,
            phones: lead.phones,
            verifications: leadVerifications
          });
          const phone = phoneState.phone;
          if (!phone) {
            contacts.push({
              leadId: lead.id,
              contactId: null,
              provenanceId: null,
              phone: null,
              status: "skipped",
              reason: "missing_valid_phone",
              sourceTag: null,
              provenance: null
            });
            continue;
          }

          const existingContact = await tx.contact.findFirst({
            where: {
              workspaceId: input.workspaceId,
              phone: { in: buildPhoneLookupCandidates(phone) }
            },
            orderBy: [{ updatedAt: "desc" }, { id: "asc" }]
          });
          const contact = existingContact ?? await tx.contact.upsert({
            where: { workspaceId_phone: { workspaceId: input.workspaceId, phone } },
            update: {},
            create: {
              workspaceId: input.workspaceId,
              phone,
              name: leadDisplayName(lead),
              email: lead.email?.trim() || null,
              company: leadCompany(lead),
              customFields: {}
            }
          });

          const company = leadDisplayName(lead) ?? leadCompany(lead);
          const suggestedMessage = renderCompany(quickReply!.body, company);
          const provenanceCreate = {
            workspaceId: input.workspaceId,
            contactId: contact.id,
            leadId: lead.id,
            listId: lead.listId,
            source: lead.source,
            sourceUrl: lead.sourceUrl,
            whatsappStatus: phoneState.whatsappStatus,
            suggestedMessage,
            quickReplySnapshot: {
              id: quickReply!.id,
              title: quickReply!.title,
              category: quickReply!.category,
              body: quickReply!.body,
              renderedBody: suggestedMessage,
              importedBy: input.actor.id
            },
            importedAt: now()
          } satisfies Prisma.LeadContactProvenanceUncheckedCreateInput;
          let provenance;
          try {
            provenance = await tx.leadContactProvenance.upsert({
              where: {
                workspaceId_leadId: { workspaceId: input.workspaceId, leadId: lead.id }
              },
              update: {},
              create: provenanceCreate
            });
          } catch (error) {
            if (!isUniqueConflict(error)) throw error;
            provenance = await tx.leadContactProvenance.findFirst({
              where: { workspaceId: input.workspaceId, leadId: lead.id }
            });
            if (!provenance) throw error;
          }

          const tag = await ensureSourceTag({
            tx,
            workspaceId: input.workspaceId,
            contactId: provenance.contactId,
            source: provenance.source
          });

          const mappedContact = provenance.contactId === contact.id
            ? contact
            : await tx.contact.findFirst({
                where: { workspaceId: input.workspaceId, id: provenance.contactId }
              });

          contacts.push({
            leadId: lead.id,
            contactId: provenance.contactId,
            provenanceId: provenance.id,
            phone: mappedContact?.phone ?? phone,
            status: existingContact || provenance.contactId !== contact.id ? "reconciled" : "created",
            reason: null,
            sourceTag: tag,
            provenance: provenanceSummary(provenance)
          });
        }

        const createdCount = contacts.filter((row) => row.status === "created").length;
        const reconciledCount = contacts.filter((row) => row.status === "reconciled").length;
        const skippedCount = contacts.filter((row) => row.status === "skipped").length;
        return {
          requestedCount: selectedLeadIds.length,
          importedCount: createdCount + reconciledCount,
          createdCount,
          reconciledCount,
          skippedCount,
          contacts
        };
      });
    },

    async lookupComposerDraft(input: {
      workspaceId: string;
      conversationId: string;
    }): Promise<LeadComposerDraft | null> {
      const conversation = await prisma.conversation.findFirst({
        where: { workspaceId: input.workspaceId, id: input.conversationId },
        select: { contactId: true }
      });
      if (!conversation) return null;
      const provenance = await prisma.leadContactProvenance.findFirst({
        where: {
          workspaceId: input.workspaceId,
          contactId: conversation.contactId,
          suggestedMessage: { not: null }
        },
        orderBy: [{ importedAt: "desc" }, { id: "desc" }],
        select: { id: true, suggestedMessage: true }
      });
      return provenance?.suggestedMessage
        ? { body: provenance.suggestedMessage, provenanceId: provenance.id }
        : null;
    },

    async createCampaignDraftFromLeads(input: {
      workspaceId: string;
      selectedLeadIds: string[];
      name?: string;
      messageBody?: string;
      quickReplyId?: string;
    }): Promise<LeadCampaignDraftResult> {
      const selectedLeadIds = uniqueSelection(input.selectedLeadIds);
      if (input.messageBody && input.quickReplyId) {
        throw new LeadConversionError(
          "LEAD_SELECTION_INVALID",
          "Choose either an explicit body or a quick reply."
        );
      }

      return prisma.$transaction(async (tx) => {
        const provenances = await tx.leadContactProvenance.findMany({
          where: { workspaceId: input.workspaceId, leadId: { in: selectedLeadIds } },
          include: {
            contact: {
              select: { id: true, name: true, phone: true, email: true, company: true }
            }
          },
          orderBy: [{ importedAt: "desc" }, { id: "desc" }]
        });
        if (provenances.length !== selectedLeadIds.length) {
          throw new LeadConversionError(
            "LEAD_SELECTION_INVALID",
            "All selected leads must already be imported in this workspace."
          );
        }

        let messageBody = input.messageBody?.trim();
        if (input.quickReplyId) {
          const reply = await tx.quickReply.findFirst({
            where: { workspaceId: input.workspaceId, id: input.quickReplyId }
          });
          if (!reply) {
            throw new LeadConversionError(
              "LEAD_CAMPAIGN_TEMPLATE_NOT_FOUND",
              "Quick reply not found in this workspace."
            );
          }
          messageBody = reply.body.trim();
        }
        if (!messageBody) {
          const snapshots = [...new Set(provenances.map((row) => row.suggestedMessage?.trim()).filter(Boolean))];
          if (snapshots.length !== 1) {
            throw new LeadConversionError(
              "LEAD_CAMPAIGN_COMMON_BODY_REQUIRED",
              "Selected leads have different message snapshots; choose one common body."
            );
          }
          messageBody = snapshots[0]!;
        }
        if (messageBody.length > 2000) {
          throw new LeadConversionError("LEAD_SELECTION_INVALID", "Campaign body is too long.");
        }

        const rowsByPhone = new Map<string, ReturnType<typeof campaignRow>>();
        for (const provenance of provenances) {
          const phone = validPhone(provenance.contact.phone);
          if (!phone || rowsByPhone.has(phone)) continue;
          rowsByPhone.set(phone, campaignRow({
            ...provenance,
            contact: { ...provenance.contact, phone }
          }));
        }
        const rows = [...rowsByPhone.values()];
        if (rows.length === 0) {
          throw new LeadConversionError("LEAD_CAMPAIGN_EMPTY", "No valid imported contacts were selected.");
        }

        const campaign = await tx.campaign.create({
          data: {
            workspaceId: input.workspaceId,
            name: input.name?.trim() || `Prospecção — Leads ${now().toLocaleDateString("pt-BR")}`,
            status: "draft",
            audience: { type: "imported", rows },
            messageBody,
            templates: [messageBody],
            fallbackName: "cliente",
            scheduledAt: null,
            mode: "simulated"
          }
        });
        return { campaignId: campaign.id, status: "draft", contactCount: rows.length };
      });
    }
  };
}

export const leadConversionDefaults = {
  quickReplyTitle: DEFAULT_QUICK_REPLY_TITLE,
  quickReplyCategory: DEFAULT_QUICK_REPLY_CATEGORY,
  quickReplyBody: DEFAULT_QUICK_REPLY_BODY
} as const;
