import { describe, expect, it, vi } from "vitest";
import { createLeadConversionService, LeadConversionError } from "./lead-conversion.service.js";

const ids = {
  lead1: "00000000-0000-4000-8000-000000000001",
  lead2: "00000000-0000-4000-8000-000000000002",
  contact1: "00000000-0000-4000-8000-000000000011",
  contact2: "00000000-0000-4000-8000-000000000012",
  provenance1: "00000000-0000-4000-8000-000000000021",
  list1: "00000000-0000-4000-8000-000000000031",
  reply1: "00000000-0000-4000-8000-000000000041",
  campaign1: "00000000-0000-4000-8000-000000000051",
  conversation1: "00000000-0000-4000-8000-000000000061"
};

const now = new Date("2026-09-22T12:00:00.000Z");
const lead = {
  id: ids.lead1,
  workspaceId: "workspace-a",
  listId: ids.list1,
  source: "google_maps",
  companyName: "Clínica Legal",
  tradeName: "Clínica Sorriso",
  normalizedPhone: "5511999990000",
  phones: ["+55 (11) 99999-0000", "+55 (11) 3333-4444"],
  email: "oi@clinica.test",
  sourceUrl: "https://maps.example/clinica"
};

function record(overrides: Record<string, unknown> = {}) {
  return {
    id: ids.contact1,
    workspaceId: "workspace-a",
    name: "Clínica Sorriso",
    phone: "5511999990000",
    email: "oi@clinica.test",
    company: "Clínica Legal",
    customFields: {},
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

function provenanceRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: ids.provenance1,
    workspaceId: "workspace-a",
    leadId: ids.lead1,
    contactId: ids.contact1,
    listId: ids.list1,
    source: "google_maps",
    sourceUrl: "https://maps.example/clinica",
    whatsappStatus: "available",
    suggestedMessage: "Olá, tudo bem? Vi a Clínica Sorriso e queria entender como vocês organizam o atendimento pelo WhatsApp hoje.",
    quickReplySnapshot: {},
    importedAt: now,
    createdAt: now,
    ...overrides
  };
}

function createPrisma(overrides: Record<string, any> = {}) {
  const tx: Record<string, any> = {
    $queryRaw: vi.fn().mockResolvedValue([{ pg_advisory_xact_lock: null }]),
    lead: {
      findMany: vi.fn().mockResolvedValue([lead])
    },
    leadWhatsappVerification: {
      findMany: vi.fn().mockResolvedValue([])
    },
    quickReply: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({
        id: ids.reply1,
        workspaceId: "workspace-a",
        title: "Prospecção — Clínica padrão",
        category: "Prospecção",
        body: "Olá, tudo bem? Vi a {{company}} e queria entender como vocês organizam o atendimento pelo WhatsApp hoje."
      })
    },
    contact: {
      findFirst: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue(record()),
      findMany: vi.fn().mockResolvedValue([record()])
    },
    tag: {
      upsert: vi.fn().mockResolvedValue({ id: "tag-1" })
    },
    contactTag: {
      upsert: vi.fn().mockResolvedValue({})
    },
    leadContactProvenance: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue(provenanceRecord())
    },
    conversation: {
      findFirst: vi.fn().mockResolvedValue({ id: ids.conversation1, contactId: ids.contact1 })
    },
    campaign: {
      create: vi.fn().mockResolvedValue({ id: ids.campaign1, status: "draft" })
    },
    ...overrides
  };
  const prisma = {
    ...tx,
    $transaction: vi.fn(async (callback: (client: unknown) => unknown) => callback(tx))
  };
  return { prisma, tx };
}

describe("lead conversion", () => {
  it("preserves a country-coded availability result for a local Google Maps phone", async () => {
    const { prisma, tx } = createPrisma();
    tx.lead.findMany.mockResolvedValue([{
      ...lead, normalizedPhone: "47991396920", phones: ["(47) 99139-6920"]
    }]);
    tx.leadWhatsappVerification.findMany.mockResolvedValue([{
      id: "verification-local", leadId: ids.lead1, normalizedPhone: "554791396920",
      status: "available", checkedAt: now, createdAt: now
    }]);
    const service = createLeadConversionService(prisma as never, { now: () => now });

    await service.importSelectedLeads({
      workspaceId: "workspace-a", selectedLeadIds: [ids.lead1], actor: { id: "user-1" }
    });

    expect(tx.contact.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId_phone: { workspaceId: "workspace-a", phone: "47991396920" } }
    }));
    expect(tx.leadContactProvenance.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ whatsappStatus: "available" })
    }));
  });

  it("imports a new contact transactionally with deterministic available phone, tag, snapshot and locked default reply", async () => {
    const { prisma, tx } = createPrisma();
    tx.leadWhatsappVerification.findMany.mockResolvedValue([
      { id: "verification-2", leadId: ids.lead1, normalizedPhone: "551133334444", status: "available", checkedAt: new Date("2026-09-22T11:00:00Z"), createdAt: now },
      { id: "verification-1", leadId: ids.lead1, normalizedPhone: "5511999990000", status: "available", checkedAt: new Date("2026-09-22T10:00:00Z"), createdAt: now }
    ]);
    tx.contact.upsert.mockResolvedValue(record({ phone: "551133334444" }));
    const service = createLeadConversionService(prisma as never, { now: () => now });

    const result = await service.importSelectedLeads({
      workspaceId: "workspace-a",
      selectedLeadIds: [ids.lead1],
      actor: { id: "user-1", role: "agent" }
    });

    expect(result).toMatchObject({ requestedCount: 1, importedCount: 1, createdCount: 1, skippedCount: 0 });
    expect(result.contacts[0]).toMatchObject({
      leadId: ids.lead1,
      contactId: ids.contact1,
      provenanceId: ids.provenance1,
      phone: "551133334444",
      status: "created",
      sourceTag: { name: "Origem: Lead Google", color: "#1c6653" },
      provenance: {
        id: ids.provenance1,
        source: "google_maps",
        listId: ids.list1,
        importedAt: now.toISOString(),
        whatsappStatus: "available",
        suggestedMessage: expect.stringContaining("Clínica Sorriso")
      }
    });
    expect(tx.$queryRaw).toHaveBeenCalledBefore(tx.quickReply.findFirst);
    expect(tx.contact.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId_phone: { workspaceId: "workspace-a", phone: "551133334444" } },
      update: {},
      create: expect.objectContaining({
        workspaceId: "workspace-a",
        name: "Clínica Sorriso",
        company: "Clínica Legal"
      })
    }));
    expect(tx.tag.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId_name: { workspaceId: "workspace-a", name: "Origem: Lead Google" } },
      create: expect.objectContaining({ color: "#1c6653" })
    }));
    expect(tx.leadContactProvenance.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: {},
      create: expect.objectContaining({
        contactId: ids.contact1,
        whatsappStatus: "available",
        suggestedMessage: expect.stringContaining("Clínica Sorriso")
      })
    }));
  });

  it("preserves an existing contact and user-edited default quick reply", async () => {
    const existing = record({ name: "Nome manual", email: "manual@test", company: "Empresa manual", customFields: { manual: true } });
    const { prisma, tx } = createPrisma();
    tx.quickReply.findFirst.mockResolvedValue({
      id: ids.reply1,
      title: "Prospecção — Clínica padrão",
      body: "Texto editado para {{company}}",
      category: "Minha categoria"
    });
    tx.contact.findFirst.mockResolvedValue(existing);
    const service = createLeadConversionService(prisma as never, { now: () => now });

    await service.importSelectedLeads({ workspaceId: "workspace-a", selectedLeadIds: [ids.lead1], actor: { id: "user-1" } });

    expect(tx.contact.upsert).not.toHaveBeenCalled();
    expect(tx.quickReply.create).not.toHaveBeenCalled();
    expect(tx.leadContactProvenance.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ suggestedMessage: "Texto editado para Clínica Sorriso" })
    }));
  });

  it("reports a lead without a valid phone and never invents contact data", async () => {
    const { prisma, tx } = createPrisma();
    tx.lead.findMany.mockResolvedValue([{ ...lead, normalizedPhone: null, phones: ["invalid"] }]);
    const service = createLeadConversionService(prisma as never, { now: () => now });

    const result = await service.importSelectedLeads({ workspaceId: "workspace-a", selectedLeadIds: [ids.lead1], actor: { id: "user-1" } });

    expect(result.contacts[0]).toMatchObject({
      status: "skipped",
      reason: "missing_valid_phone",
      contactId: null,
      sourceTag: null,
      provenance: null
    });
    expect(tx.contact.upsert).not.toHaveBeenCalled();
    expect(tx.leadContactProvenance.upsert).not.toHaveBeenCalled();
  });

  it("prefers a valid primary phone over secondary and never promotes unverified to available", async () => {
    const { prisma, tx } = createPrisma();
    tx.leadWhatsappVerification.findMany.mockResolvedValue([
      {
        id: "verification-1",
        leadId: ids.lead1,
        normalizedPhone: "5511999990000",
        status: "unverified",
        checkedAt: new Date("2026-09-22T11:30:00Z"),
        createdAt: now
      }
    ]);
    const service = createLeadConversionService(prisma as never, { now: () => now });

    await service.importSelectedLeads({ workspaceId: "workspace-a", selectedLeadIds: [ids.lead1], actor: { id: "user-1" } });

    expect(tx.contact.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId_phone: { workspaceId: "workspace-a", phone: "551199990000" } }
    }));
    expect(tx.leadContactProvenance.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ whatsappStatus: "unverified" })
    }));
  });

  it("ignores an old available status superseded by a newer unavailable status for the same phone", async () => {
    const { prisma, tx } = createPrisma();
    tx.leadWhatsappVerification.findMany.mockResolvedValue([
      { id: "verification-2", leadId: ids.lead1, normalizedPhone: "551133334444", status: "unavailable", checkedAt: new Date("2026-09-22T11:00:00Z"), createdAt: now },
      { id: "verification-1", leadId: ids.lead1, normalizedPhone: "551133334444", status: "available", checkedAt: new Date("2026-09-22T10:00:00Z"), createdAt: now }
    ]);
    const service = createLeadConversionService(prisma as never, { now: () => now });

    await service.importSelectedLeads({ workspaceId: "workspace-a", selectedLeadIds: [ids.lead1], actor: { id: "user-1" } });

    expect(tx.contact.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId_phone: { workspaceId: "workspace-a", phone: "551199990000" } }
    }));
    expect(tx.leadContactProvenance.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ whatsappStatus: "unavailable" })
    }));
  });

  it("ignores an available verification for a historical phone no longer present on the lead", async () => {
    const { prisma, tx } = createPrisma();
    tx.leadWhatsappVerification.findMany.mockResolvedValue([
      { id: "verification-1", leadId: ids.lead1, normalizedPhone: "5511888880000", status: "available", checkedAt: new Date("2026-09-22T11:00:00Z"), createdAt: now }
    ]);
    const service = createLeadConversionService(prisma as never, { now: () => now });

    await service.importSelectedLeads({ workspaceId: "workspace-a", selectedLeadIds: [ids.lead1], actor: { id: "user-1" } });

    expect(tx.contact.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId_phone: { workspaceId: "workspace-a", phone: "551199990000" } }
    }));
    expect(tx.leadContactProvenance.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ whatsappStatus: "unverified" })
    }));
  });

  it("uses verification id descending as the deterministic tie-breaker", async () => {
    const { prisma, tx } = createPrisma();
    const tiedAt = new Date("2026-09-22T11:00:00Z");
    tx.leadWhatsappVerification.findMany.mockResolvedValue([
      { id: "verification-1", leadId: ids.lead1, normalizedPhone: "551133334444", status: "available", checkedAt: tiedAt, createdAt: tiedAt },
      { id: "verification-2", leadId: ids.lead1, normalizedPhone: "551133334444", status: "unavailable", checkedAt: tiedAt, createdAt: tiedAt }
    ]);
    const service = createLeadConversionService(prisma as never, { now: () => now });

    await service.importSelectedLeads({ workspaceId: "workspace-a", selectedLeadIds: [ids.lead1], actor: { id: "user-1" } });

    expect(tx.leadWhatsappVerification.findMany).toHaveBeenCalledWith(expect.objectContaining({
      orderBy: [{ checkedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }]
    }));
    expect(tx.contact.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId_phone: { workspaceId: "workspace-a", phone: "551199990000" } }
    }));
    expect(tx.leadContactProvenance.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ whatsappStatus: "unavailable" })
    }));
  });

  it("keeps the same normalized phone separate across workspaces", async () => {
    const { prisma, tx } = createPrisma();
    tx.lead.findMany.mockImplementation(async (args: { where: { workspaceId: string } }) => [
      { ...lead, workspaceId: args.where.workspaceId }
    ]);
    tx.contact.upsert.mockImplementation(async (args: { create: { workspaceId: string; phone: string } }) =>
      record({ id: `contact-${args.create.workspaceId}`, workspaceId: args.create.workspaceId, phone: args.create.phone })
    );
    const service = createLeadConversionService(prisma as never, { now: () => now });

    await service.importSelectedLeads({ workspaceId: "workspace-a", selectedLeadIds: [ids.lead1], actor: { id: "user-1" } });
    await service.importSelectedLeads({ workspaceId: "workspace-b", selectedLeadIds: [ids.lead1], actor: { id: "user-2" } });

    expect(tx.contact.upsert).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: { workspaceId_phone: { workspaceId: "workspace-a", phone: "551199990000" } }
    }));
    expect(tx.contact.upsert).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: { workspaceId_phone: { workspaceId: "workspace-b", phone: "551199990000" } }
    }));
  });

  it("deduplicates the same phone inside one workspace without overwriting the first contact", async () => {
    const { prisma, tx } = createPrisma();
    const leadTwo = { ...lead, id: ids.lead2, tradeName: "Outro nome" };
    tx.lead.findMany.mockResolvedValue([lead, leadTwo]);
    tx.contact.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(record());
    const service = createLeadConversionService(prisma as never, { now: () => now });

    const result = await service.importSelectedLeads({
      workspaceId: "workspace-a",
      selectedLeadIds: [ids.lead1, ids.lead2],
      actor: { id: "user-1" }
    });

    expect(tx.contact.upsert).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ requestedCount: 2, createdCount: 1, reconciledCount: 1 });
  });

  it("upserts only the source tag link and never removes pre-existing contact tags", async () => {
    const { prisma, tx } = createPrisma();
    tx.contact.findFirst.mockResolvedValue(record());
    tx.contactTag.deleteMany = vi.fn();
    const service = createLeadConversionService(prisma as never, { now: () => now });

    await service.importSelectedLeads({ workspaceId: "workspace-a", selectedLeadIds: [ids.lead1], actor: { id: "user-1" } });

    expect(tx.contactTag.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId_contactId_tagId: { workspaceId: "workspace-a", contactId: ids.contact1, tagId: "tag-1" } },
      update: {}
    }));
    expect(tx.contactTag.deleteMany).not.toHaveBeenCalled();
  });

  it("returns an immutable existing provenance mapping and restores the Receita source tag on re-import", async () => {
    const { prisma, tx } = createPrisma();
    tx.lead.findMany.mockResolvedValue([{ ...lead, source: "receita_federal", sourceUrl: null }]);
    tx.leadContactProvenance.findMany.mockResolvedValue([{
      ...provenanceRecord({ source: "receita_federal", sourceUrl: null, whatsappStatus: "unverified" }),
      contact: { phone: "551199990000" }
    }]);
    const service = createLeadConversionService(prisma as never, { now: () => now });

    const result = await service.importSelectedLeads({ workspaceId: "workspace-a", selectedLeadIds: [ids.lead1], actor: { id: "user-1" } });

    expect(result.contacts[0]).toMatchObject({
      status: "reconciled",
      contactId: ids.contact1,
      provenanceId: ids.provenance1,
      sourceTag: { name: "Origem: Lead Receita", color: "#6b4bb5" },
      provenance: {
        id: ids.provenance1,
        source: "receita_federal",
        listId: ids.list1,
        importedAt: now.toISOString(),
        whatsappStatus: "unverified"
      }
    });
    expect(tx.contact.upsert).not.toHaveBeenCalled();
    expect(tx.leadContactProvenance.upsert).not.toHaveBeenCalled();
    expect(tx.tag.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId_name: { workspaceId: "workspace-a", name: "Origem: Lead Receita" } },
      update: { color: "#6b4bb5", isActive: true }
    }));
    expect(tx.contactTag.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId_contactId_tagId: { workspaceId: "workspace-a", contactId: ids.contact1, tagId: "tag-1" } }
    }));
  });

  it("rejects empty or cross-workspace selections before writing", async () => {
    const { prisma, tx } = createPrisma();
    const service = createLeadConversionService(prisma as never);
    await expect(service.importSelectedLeads({ workspaceId: "workspace-a", selectedLeadIds: [], actor: { id: "user-1" } }))
      .rejects.toMatchObject({ code: "LEAD_SELECTION_REQUIRED" });

    tx.lead.findMany.mockResolvedValue([]);
    await expect(service.importSelectedLeads({ workspaceId: "workspace-a", selectedLeadIds: [ids.lead1], actor: { id: "user-1" } }))
      .rejects.toMatchObject({ code: "LEAD_SELECTION_INVALID" });
    expect(tx.contact.upsert).not.toHaveBeenCalled();
  });

  it("looks up the latest provenance draft through a workspace-scoped conversation without creating a message", async () => {
    const { prisma, tx } = createPrisma();
    tx.leadContactProvenance.findFirst.mockResolvedValue({ id: ids.provenance1, suggestedMessage: "Rascunho salvo" });
    const service = createLeadConversionService(prisma as never);

    await expect(service.lookupComposerDraft({ workspaceId: "workspace-a", conversationId: ids.conversation1 }))
      .resolves.toEqual({ body: "Rascunho salvo", provenanceId: ids.provenance1 });
    expect(tx.conversation.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId: "workspace-a", id: ids.conversation1 }
    }));
    expect((tx as { message?: unknown }).message).toBeUndefined();
  });

  it("returns no composer draft when the conversation belongs to another workspace", async () => {
    const { prisma, tx } = createPrisma();
    tx.conversation.findFirst.mockResolvedValue(null);
    const service = createLeadConversionService(prisma as never);

    await expect(service.lookupComposerDraft({ workspaceId: "workspace-b", conversationId: ids.conversation1 }))
      .resolves.toBeNull();
    expect(tx.leadContactProvenance.findFirst).not.toHaveBeenCalled();
  });

  it("creates only a deduplicated imported-audience draft and never sends or schedules", async () => {
    const duplicateContact = record();
    const { prisma, tx } = createPrisma();
    tx.leadContactProvenance.findMany.mockResolvedValue([
      { id: ids.provenance1, leadId: ids.lead1, contactId: ids.contact1, suggestedMessage: "Corpo comum", contact: duplicateContact },
      { id: "prov-2", leadId: ids.lead2, contactId: ids.contact1, suggestedMessage: "Corpo comum", contact: duplicateContact }
    ]);
    tx.send = vi.fn();
    tx.schedule = vi.fn();
    tx.queue = vi.fn();
    tx.evolution = { sendText: vi.fn() };
    const service = createLeadConversionService(prisma as never);

    const result = await service.createCampaignDraftFromLeads({
      workspaceId: "workspace-a",
      selectedLeadIds: [ids.lead1, ids.lead2],
      name: "Prospecção setembro"
    });

    expect(result).toEqual({ campaignId: ids.campaign1, status: "draft", contactCount: 1 });
    expect(tx.campaign.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "draft",
        messageBody: "Corpo comum",
        audience: expect.objectContaining({ type: "imported", rows: [expect.objectContaining({ phone: "551199990000" })] })
      })
    }));
    expect((tx as Record<string, unknown>).campaignRecipient).toBeUndefined();
    expect((tx as Record<string, unknown>).message).toBeUndefined();
    expect(tx.send).not.toHaveBeenCalled();
    expect(tx.schedule).not.toHaveBeenCalled();
    expect(tx.queue).not.toHaveBeenCalled();
    expect(tx.evolution.sendText).not.toHaveBeenCalled();
  });

  it("rejects campaign lead IDs without imported provenance in the workspace", async () => {
    const { prisma, tx } = createPrisma();
    tx.leadContactProvenance.findMany.mockResolvedValue([]);
    const service = createLeadConversionService(prisma as never);

    await expect(service.createCampaignDraftFromLeads({ workspaceId: "workspace-b", selectedLeadIds: [ids.lead1] }))
      .rejects.toMatchObject({ code: "LEAD_SELECTION_INVALID" });
    expect(tx.campaign.create).not.toHaveBeenCalled();
  });

  it("requires an explicit common body when selected snapshots differ", async () => {
    const { prisma, tx } = createPrisma();
    tx.leadContactProvenance.findMany.mockResolvedValue([
      { id: ids.provenance1, leadId: ids.lead1, contactId: ids.contact1, suggestedMessage: "Corpo A", contact: record() },
      { id: "prov-2", leadId: ids.lead2, contactId: "contact-2", suggestedMessage: "Corpo B", contact: record({ id: "contact-2", phone: "5511888880000" }) }
    ]);
    const service = createLeadConversionService(prisma as never);

    await expect(service.createCampaignDraftFromLeads({ workspaceId: "workspace-a", selectedLeadIds: [ids.lead1, ids.lead2] }))
      .rejects.toMatchObject({ code: "LEAD_CAMPAIGN_COMMON_BODY_REQUIRED" } satisfies Partial<LeadConversionError>);
    expect(tx.campaign.create).not.toHaveBeenCalled();

    await expect(service.createCampaignDraftFromLeads({
      workspaceId: "workspace-a",
      selectedLeadIds: [ids.lead1, ids.lead2],
      messageBody: "Corpo comum escolhido"
    })).resolves.toMatchObject({ status: "draft", contactCount: 2 });
    expect(tx.campaign.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ messageBody: "Corpo comum escolhido" })
    }));
  });

  it("serializes two first imports so the exact default quick reply is created once", async () => {
    const { prisma, tx } = createPrisma();
    const leadTwo = { ...lead, id: ids.lead2, normalizedPhone: "5511888880000", phones: ["5511888880000"] };
    tx.lead.findMany.mockImplementation(async (args: { where: { id: { in: string[] } } }) =>
      args.where.id.in[0] === ids.lead1 ? [lead] : [leadTwo]
    );
    let storedReply: Record<string, unknown> | null = null;
    tx.quickReply.findFirst.mockImplementation(async () => storedReply);
    tx.quickReply.create.mockImplementation(async (args: { data: Record<string, unknown> }) => {
      storedReply = { id: ids.reply1, ...args.data };
      return storedReply;
    });
    let advisoryLock = Promise.resolve();
    const lockCalls = vi.fn();
    prisma.$transaction.mockImplementation(async (callback: (client: unknown) => unknown) => {
      let release: (() => void) | undefined;
      const client = {
        ...tx,
        $queryRaw: async (...args: unknown[]) => {
          lockCalls(...args);
          const previous = advisoryLock;
          advisoryLock = new Promise<void>((resolve) => { release = resolve; });
          await previous;
          return 1;
        }
      };
      try {
        return await callback(client);
      } finally {
        release?.();
      }
    });
    const service = createLeadConversionService(prisma as never, { now: () => now });

    await Promise.all([
      service.importSelectedLeads({ workspaceId: "workspace-a", selectedLeadIds: [ids.lead1], actor: { id: "user-1" } }),
      service.importSelectedLeads({ workspaceId: "workspace-a", selectedLeadIds: [ids.lead2], actor: { id: "user-2" } })
    ]);

    expect(lockCalls).toHaveBeenCalledTimes(2);
    expect(tx.quickReply.create).toHaveBeenCalledTimes(1);
    expect(tx.quickReply.findFirst).toHaveBeenCalledTimes(2);
  });

  it("keeps the provenance winner immutable when the same lead is imported concurrently", async () => {
    const { prisma, tx } = createPrisma();
    const winningProvenance = provenanceRecord();
    tx.contact.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(record());
    tx.contact.upsert
      .mockResolvedValueOnce(record())
      .mockResolvedValueOnce(record({ id: ids.contact2 }));
    tx.leadContactProvenance.upsert
      .mockResolvedValueOnce(winningProvenance)
      .mockRejectedValueOnce({ code: "P2002" });
    tx.leadContactProvenance.findFirst.mockResolvedValue(winningProvenance);

    let storedReply: Record<string, unknown> | null = null;
    tx.quickReply.findFirst.mockImplementation(async () => storedReply);
    tx.quickReply.create.mockImplementation(async (args: { data: Record<string, unknown> }) => {
      storedReply = { id: ids.reply1, ...args.data };
      return storedReply;
    });
    let advisoryLock = Promise.resolve();
    prisma.$transaction.mockImplementation(async (callback: (client: unknown) => unknown) => {
      let release: (() => void) | undefined;
      const client = {
        ...tx,
        $queryRaw: async () => {
          const previous = advisoryLock;
          advisoryLock = new Promise<void>((resolve) => { release = resolve; });
          await previous;
          return [{ pg_advisory_xact_lock: null }];
        }
      };
      try {
        return await callback(client);
      } finally {
        release?.();
      }
    });
    const service = createLeadConversionService(prisma as never, { now: () => now });

    const results = await Promise.all([
      service.importSelectedLeads({ workspaceId: "workspace-a", selectedLeadIds: [ids.lead1], actor: { id: "user-1" } }),
      service.importSelectedLeads({ workspaceId: "workspace-a", selectedLeadIds: [ids.lead1], actor: { id: "user-2" } })
    ]);

    expect(results.map((result) => result.contacts[0]?.contactId)).toEqual([ids.contact1, ids.contact1]);
    expect(results.map((result) => result.contacts[0]?.provenanceId)).toEqual([ids.provenance1, ids.provenance1]);
    expect(tx.leadContactProvenance.upsert).toHaveBeenCalledTimes(2);
    expect(tx.leadContactProvenance.upsert).toHaveBeenNthCalledWith(2, expect.objectContaining({ update: {} }));
    expect(tx.leadContactProvenance.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId: "workspace-a", leadId: ids.lead1 }
    }));
    expect(tx.contactTag.upsert).toHaveBeenCalledTimes(2);
    for (const [args] of tx.contactTag.upsert.mock.calls) {
      expect(args.where.workspaceId_contactId_tagId.contactId).toBe(ids.contact1);
    }
  });
});
