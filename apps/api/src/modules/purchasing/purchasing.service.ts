import type { Prisma, PrismaClient } from "@prisma/client";
import {
  buildPurchaseComparison,
  formatCents,
  priceHistoryRowSchema,
  purchaseItemKey,
  purchaseQuoteInputSchema,
  purchaseRequestInputSchema,
  quoteTotalCents,
  supplierInputSchema,
  supplierUpdateSchema,
  type PriceHistoryDto,
  type PurchaseInviteDto,
  type PurchaseInviteStatus,
  type PurchaseQuoteKind,
  type PurchaseQuoteSource,
  type PurchaseRequestDetailDto,
  type PurchaseRequestStatus,
  type PurchaseRequestSummaryDto,
  type SupplierDto,
  type SupplierImportResult
} from "@prymeira-talk/shared";
import type { z } from "zod";

export class PurchasingError extends Error {
  constructor(readonly code: string, readonly statusCode: number, message: string) {
    super(message);
    this.name = "PurchasingError";
  }
}

const ANSWERED: PurchaseInviteStatus[] = ["replied", "declined", "quote_received", "negotiating", "winner", "lost"];
const OPEN_REQUEST: PurchaseRequestStatus[] = ["draft", "quoting", "awaiting_approval"];
const KIND_LABEL: Record<PurchaseQuoteKind, string> = {
  initial: "Proposta registrada",
  choradinha: "Resposta à choradinha registrada",
  counter: "Nova rodada registrada",
  correction: "Proposta corrigida"
};

const requestInclude = {
  items: { orderBy: { position: "asc" } },
  invites: {
    orderBy: { createdAt: "asc" },
    include: { supplier: true, quotes: { orderBy: { version: "asc" }, include: { lines: true } } }
  },
  events: { orderBy: { createdAt: "desc" }, take: 200 }
} satisfies Prisma.PurchaseRequestInclude;
type RequestRecord = Prisma.PurchaseRequestGetPayload<{ include: typeof requestInclude }>;

function isoDate(value: Date | null | undefined) {
  return value ? value.toISOString().slice(0, 10) : null;
}

function dateFromIso(value: string) {
  return new Date(`${value}T12:00:00.000Z`);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

/** Every supplier has answered (or declined), or the response deadline passed with at least one quote. */
function needsDecision(record: { status: string; responseDeadline: Date; invites: Array<{ status: string; quotes: unknown[] }> }) {
  if (record.status === "awaiting_approval") return true;
  if (record.status !== "quoting" || record.invites.length === 0) return false;
  const withQuote = record.invites.some((invite) => invite.quotes.length > 0);
  if (!withQuote) return false;
  const allAnswered = record.invites.every((invite) => invite.status === "declined" || invite.quotes.length > 0);
  return allAnswered || isoDate(record.responseDeadline)! < today();
}

function toQuoteDto(items: Array<{ id: string; quantity: number }>, quote: RequestRecord["invites"][number]["quotes"][number]) {
  const lines = quote.lines.map((line) => ({ itemId: line.itemId, unitPriceCents: line.unitPriceCents }));
  return {
    id: quote.id,
    version: quote.version,
    kind: quote.kind as PurchaseQuoteKind,
    source: quote.source as PurchaseQuoteSource,
    lines,
    freightCents: quote.freightCents,
    deliveryText: quote.deliveryText,
    deliveryDate: isoDate(quote.deliveryDate),
    paymentTerms: quote.paymentTerms,
    validUntil: isoDate(quote.validUntil),
    observation: quote.observation,
    origin: quote.origin,
    totalCents: quoteTotalCents(items, { lines, freightCents: quote.freightCents }),
    createdAt: quote.createdAt.toISOString()
  };
}

function toInviteDto(items: Array<{ id: string; quantity: number }>, invite: RequestRecord["invites"][number]): PurchaseInviteDto {
  return {
    id: invite.id,
    status: invite.status as PurchaseInviteStatus,
    supplier: { id: invite.supplier.id, name: invite.supplier.name, phone: invite.supplier.phone,
      contactName: invite.supplier.contactName, city: invite.supplier.city },
    conversationId: invite.conversationId,
    followupCount: invite.followupCount,
    declinedReason: invite.declinedReason,
    sentAt: invite.sentAt?.toISOString() ?? null,
    lastReplyAt: invite.lastReplyAt?.toISOString() ?? null,
    quotes: invite.quotes.map((quote) => toQuoteDto(items, quote))
  };
}

function comparisonFor(record: RequestRecord, invites: PurchaseInviteDto[]) {
  return buildPurchaseComparison({
    items: record.items.map((item) => ({ id: item.id, description: item.description, quantity: item.quantity })),
    deliveryDeadline: isoDate(record.deliveryDeadline)!,
    today: today(),
    invites: invites.map((invite) => ({ id: invite.id, status: invite.status, supplierName: invite.supplier.name, quotes: invite.quotes }))
  });
}

function toSummary(record: RequestRecord): PurchaseRequestSummaryDto {
  const invites = record.invites.map((invite) => toInviteDto(record.items, invite));
  const comparison = comparisonFor(record, invites);
  const approved = invites.find((invite) => invite.id === record.approvedInviteId);
  return {
    id: record.id,
    title: record.title,
    status: record.status as PurchaseRequestStatus,
    needsDecision: needsDecision(record),
    responseDeadline: isoDate(record.responseDeadline)!,
    deliveryDeadline: isoDate(record.deliveryDeadline)!,
    itemCount: record.items.length,
    invited: invites.length,
    answered: invites.filter((invite) => invite.quotes.length > 0 || ANSWERED.includes(invite.status)).length,
    bestTotalCents: comparison.bestTotalCents,
    savingsCents: comparison.totalSavingsCents,
    approvedSupplierName: approved?.supplier.name ?? null,
    updatedAt: record.updatedAt.toISOString()
  };
}

function toSupplierDto(record: Prisma.SupplierGetPayload<object>, stats?: SupplierDto["stats"]): SupplierDto {
  return {
    id: record.id, name: record.name, phone: record.phone, contactName: record.contactName, email: record.email, cnpj: record.cnpj,
    city: record.city, categories: record.categories, notes: record.notes, preferred: record.preferred, blocked: record.blocked,
    stats: stats ?? { invited: 0, answered: 0, won: 0 }, createdAt: record.createdAt.toISOString()
  };
}

/** Only the fields the caller actually sent, so a partial update never resets flags to their defaults. */
function sentFields<T extends Record<string, unknown>>(parsed: T, raw: unknown): Partial<T> {
  const keys = raw && typeof raw === "object" ? new Set(Object.keys(raw)) : new Set<string>();
  return Object.fromEntries(Object.entries(parsed).filter(([key]) => keys.has(key))) as Partial<T>;
}

function firstIssue(error: z.ZodError) {
  const issue = error.issues[0];
  return issue ? `${issue.path.join(".") || "linha"}: ${issue.message}` : "Linha inválida.";
}

type Actor = { workspaceId: string; userId?: string | null };

export function createPurchasingService(prisma: PrismaClient) {
  async function loadRequest(workspaceId: string, requestId: string, db: Prisma.TransactionClient | PrismaClient = prisma) {
    const record = await db.purchaseRequest.findFirst({ where: { workspaceId, id: requestId }, include: requestInclude });
    if (!record) throw new PurchasingError("PURCHASE_NOT_FOUND", 404, "Pedido não encontrado.");
    return record;
  }

  async function lastPaidFor(workspaceId: string, descriptions: string[]) {
    const keys = [...new Set(descriptions.map(purchaseItemKey))];
    if (!keys.length) return new Map<string, PriceHistoryDto>();
    const rows = await prisma.priceHistory.findMany({ where: { workspaceId, itemKey: { in: keys } }, orderBy: { paidAt: "desc" } });
    const latest = new Map<string, PriceHistoryDto>();
    for (const row of rows) if (!latest.has(row.itemKey)) latest.set(row.itemKey, toPriceDto(row));
    return latest;
  }

  async function event(db: Prisma.TransactionClient, actor: Actor, requestId: string, type: string, summary: string,
    extra: { inviteId?: string | null; reason?: string | null; metadata?: Prisma.InputJsonObject } = {}) {
    await db.purchaseEvent.create({ data: { workspaceId: actor.workspaceId, requestId, type, summary, inviteId: extra.inviteId ?? null,
      reason: extra.reason ?? null, metadata: extra.metadata ?? {}, actorUserId: actor.userId ?? null } });
  }

  async function assertSuppliers(db: Prisma.TransactionClient, workspaceId: string, supplierIds: string[]) {
    const unique = [...new Set(supplierIds)];
    const found = await db.supplier.findMany({ where: { workspaceId, id: { in: unique }, archivedAt: null } });
    if (found.length !== unique.length) throw new PurchasingError("PURCHASE_SUPPLIER_NOT_FOUND", 404, "Fornecedor não encontrado.");
    const blocked = found.find((supplier) => supplier.blocked);
    if (blocked) throw new PurchasingError("PURCHASE_SUPPLIER_BLOCKED", 409, `${blocked.name} está bloqueado.`);
    return found;
  }

  return {
    // ── Fornecedores ──────────────────────────────────────────────────────────────────────────────
    async listSuppliers(workspaceId: string, search?: string): Promise<SupplierDto[]> {
      const term = search?.trim();
      const suppliers = await prisma.supplier.findMany({
        where: { workspaceId, archivedAt: null, ...(term ? { OR: [
          { name: { contains: term, mode: "insensitive" } }, { phone: { contains: term.replace(/\D/g, "") || term } },
          { city: { contains: term, mode: "insensitive" } }, { categories: { has: term.toLowerCase() } }
        ] } : {}) },
        orderBy: [{ preferred: "desc" }, { name: "asc" }],
        take: 500
      });
      const invites = await prisma.purchaseQuoteInvite.findMany({
        where: { workspaceId, supplierId: { in: suppliers.map((supplier) => supplier.id) } },
        select: { supplierId: true, status: true, _count: { select: { quotes: true } } }
      });
      const stats = new Map<string, SupplierDto["stats"]>();
      for (const invite of invites) {
        const entry = stats.get(invite.supplierId) ?? { invited: 0, answered: 0, won: 0 };
        entry.invited += 1;
        if (invite._count.quotes > 0 || ANSWERED.includes(invite.status as PurchaseInviteStatus)) entry.answered += 1;
        if (invite.status === "winner") entry.won += 1;
        stats.set(invite.supplierId, entry);
      }
      return suppliers.map((supplier) => toSupplierDto(supplier, stats.get(supplier.id)));
    },

    async createSupplier(workspaceId: string, body: unknown): Promise<SupplierDto> {
      const input = supplierInputSchema.parse(body);
      const existing = await prisma.supplier.findUnique({ where: { workspaceId_phone: { workspaceId, phone: input.phone } } });
      if (existing && !existing.archivedAt) throw new PurchasingError("PURCHASE_SUPPLIER_DUPLICATE", 409, `Já existe um fornecedor com esse WhatsApp (${existing.name}).`);
      const contact = await prisma.contact.findUnique({ where: { workspaceId_phone: { workspaceId, phone: input.phone } }, select: { id: true } });
      const data = { ...input, categories: input.categories.map((category) => category.toLowerCase()), contactId: contact?.id ?? null, archivedAt: null };
      const record = existing
        ? await prisma.supplier.update({ where: { id: existing.id }, data })
        : await prisma.supplier.create({ data: { workspaceId, ...data } });
      return toSupplierDto(record);
    },

    async updateSupplier(workspaceId: string, supplierId: string, body: unknown): Promise<SupplierDto> {
      const input = sentFields(supplierUpdateSchema.parse(body), body);
      const current = await prisma.supplier.findFirst({ where: { workspaceId, id: supplierId, archivedAt: null } });
      if (!current) throw new PurchasingError("PURCHASE_SUPPLIER_NOT_FOUND", 404, "Fornecedor não encontrado.");
      if (input.phone && input.phone !== current.phone) {
        const clash = await prisma.supplier.findUnique({ where: { workspaceId_phone: { workspaceId, phone: input.phone } } });
        if (clash) throw new PurchasingError("PURCHASE_SUPPLIER_DUPLICATE", 409, `Já existe um fornecedor com esse WhatsApp (${clash.name}).`);
      }
      const record = await prisma.supplier.update({ where: { id: current.id }, data: {
        ...input, ...(input.categories ? { categories: input.categories.map((category) => category.toLowerCase()) } : {})
      } });
      return toSupplierDto(record);
    },

    async archiveSupplier(workspaceId: string, supplierId: string) {
      const result = await prisma.supplier.updateMany({ where: { workspaceId, id: supplierId, archivedAt: null }, data: { archivedAt: new Date() } });
      if (result.count !== 1) throw new PurchasingError("PURCHASE_SUPPLIER_NOT_FOUND", 404, "Fornecedor não encontrado.");
      return { ok: true };
    },

    /** Upsert by WhatsApp number. Rows are validated one by one so a bad line never sinks the file. */
    async importSuppliers(workspaceId: string, rows: unknown[]): Promise<SupplierImportResult> {
      const result: SupplierImportResult = { created: 0, updated: 0, rejected: [] };
      for (const [index, row] of rows.entries()) {
        const parsed = supplierInputSchema.safeParse(row);
        if (!parsed.success) { result.rejected.push({ row: index + 1, reason: firstIssue(parsed.error) }); continue; }
        const input = { ...parsed.data, categories: parsed.data.categories.map((category) => category.toLowerCase()) };
        const existing = await prisma.supplier.findUnique({ where: { workspaceId_phone: { workspaceId, phone: input.phone } } });
        if (existing) {
          await prisma.supplier.update({ where: { id: existing.id }, data: { ...sentFields(input, row), archivedAt: null,
            categories: [...new Set([...existing.categories, ...input.categories])] } });
          result.updated += 1;
        } else {
          const contact = await prisma.contact.findUnique({ where: { workspaceId_phone: { workspaceId, phone: input.phone } }, select: { id: true } });
          await prisma.supplier.create({ data: { workspaceId, ...input, contactId: contact?.id ?? null } });
          result.created += 1;
        }
      }
      return result;
    },

    // ── Pedidos ───────────────────────────────────────────────────────────────────────────────────
    async listRequests(workspaceId: string): Promise<PurchaseRequestSummaryDto[]> {
      const records = await prisma.purchaseRequest.findMany({
        where: { workspaceId }, orderBy: { updatedAt: "desc" }, take: 200,
        include: { ...requestInclude, events: false }
      });
      return records.map((record) => toSummary({ ...record, events: [] }));
    },

    async getRequest(workspaceId: string, requestId: string): Promise<PurchaseRequestDetailDto> {
      const record = await loadRequest(workspaceId, requestId);
      const lastPaid = await lastPaidFor(workspaceId, record.items.map((item) => item.description));
      const invites = record.invites.map((invite) => toInviteDto(record.items, invite));
      const summary = toSummary(record);
      return {
        id: record.id, title: record.title, status: summary.status, needsDecision: summary.needsDecision,
        responseDeadline: summary.responseDeadline, deliveryDeadline: summary.deliveryDeadline,
        approvedSupplierName: summary.approvedSupplierName, updatedAt: summary.updatedAt,
        deliveryCep: record.deliveryCep, deliveryCity: record.deliveryCity, budgetCeilingCents: record.budgetCeilingCents,
        paymentPreference: record.paymentPreference, requiresInvoice: record.requiresInvoice, notes: record.notes,
        approvedInviteId: record.approvedInviteId, approvedAt: record.approvedAt?.toISOString() ?? null, createdAt: record.createdAt.toISOString(),
        items: record.items.map((item) => {
          const paid = lastPaid.get(purchaseItemKey(item.description));
          return { id: item.id, position: item.position, description: item.description, specification: item.specification,
            quantity: item.quantity, unit: item.unit,
            lastPaid: paid ? { unitPriceCents: paid.unitPriceCents, supplierName: paid.supplierName, paidAt: paid.paidAt } : null };
        }),
        invites,
        comparison: comparisonFor(record, invites),
        events: record.events.map((row) => ({ id: row.id, inviteId: row.inviteId, type: row.type, summary: row.summary,
          reason: row.reason, createdAt: row.createdAt.toISOString() })),
        agentConnected: false
      };
    },

    async createRequest(actor: Actor, body: unknown) {
      const input = purchaseRequestInputSchema.parse(body);
      const id = await prisma.$transaction(async (tx) => {
        const suppliers = await assertSuppliers(tx, actor.workspaceId, input.supplierIds);
        const record = await tx.purchaseRequest.create({ data: {
          workspaceId: actor.workspaceId, title: input.title, status: "draft",
          responseDeadline: dateFromIso(input.responseDeadline), deliveryDeadline: dateFromIso(input.deliveryDeadline),
          deliveryCep: input.deliveryCep, deliveryCity: input.deliveryCity, budgetCeilingCents: input.budgetCeilingCents,
          paymentPreference: input.paymentPreference, requiresInvoice: input.requiresInvoice, notes: input.notes,
          createdByUserId: actor.userId ?? null
        } });
        await tx.purchaseRequestItem.createMany({ data: input.items.map((item, position) => ({ workspaceId: actor.workspaceId, requestId: record.id, position, ...item })) });
        if (suppliers.length) {
          await tx.purchaseQuoteInvite.createMany({ data: suppliers.map((supplier) => ({ workspaceId: actor.workspaceId, requestId: record.id, supplierId: supplier.id })) });
        }
        await event(tx, actor, record.id, "created", `Pedido criado com ${input.items.length} ${input.items.length === 1 ? "item" : "itens"} e ${suppliers.length} ${suppliers.length === 1 ? "fornecedor" : "fornecedores"}.`);
        return record.id;
      });
      return this.getRequest(actor.workspaceId, id);
    },

    async addSuppliers(actor: Actor, requestId: string, supplierIds: string[]) {
      await prisma.$transaction(async (tx) => {
        const record = await loadRequest(actor.workspaceId, requestId, tx);
        if (!OPEN_REQUEST.includes(record.status as PurchaseRequestStatus)) throw new PurchasingError("PURCHASE_CLOSED", 409, "Este pedido já foi encerrado.");
        const already = new Set(record.invites.map((invite) => invite.supplierId));
        const suppliers = (await assertSuppliers(tx, actor.workspaceId, supplierIds)).filter((supplier) => !already.has(supplier.id));
        if (!suppliers.length) return;
        await tx.purchaseQuoteInvite.createMany({ data: suppliers.map((supplier) => ({ workspaceId: actor.workspaceId, requestId, supplierId: supplier.id })) });
        await event(tx, actor, requestId, "suppliers_added", `${suppliers.map((supplier) => supplier.name).join(", ")} ${suppliers.length === 1 ? "entrou" : "entraram"} no pedido.`);
      });
      return this.getRequest(actor.workspaceId, requestId);
    },

    async removeInvite(actor: Actor, requestId: string, inviteId: string) {
      await prisma.$transaction(async (tx) => {
        const record = await loadRequest(actor.workspaceId, requestId, tx);
        const invite = record.invites.find((candidate) => candidate.id === inviteId);
        if (!invite) throw new PurchasingError("PURCHASE_INVITE_NOT_FOUND", 404, "Fornecedor não está neste pedido.");
        if (invite.quotes.length || invite.sentAt) throw new PurchasingError("PURCHASE_INVITE_STARTED", 409, "Esse fornecedor já foi chamado; marque como declinou em vez de remover.");
        await tx.purchaseQuoteInvite.delete({ where: { id: invite.id } });
        await event(tx, actor, requestId, "supplier_removed", `${invite.supplier.name} saiu do pedido.`);
      });
      return this.getRequest(actor.workspaceId, requestId);
    },

    async startQuoting(actor: Actor, requestId: string) {
      await prisma.$transaction(async (tx) => {
        const record = await loadRequest(actor.workspaceId, requestId, tx);
        if (record.status !== "draft") throw new PurchasingError("PURCHASE_INVALID_TRANSITION", 409, "A cotação já começou.");
        if (!record.invites.length) throw new PurchasingError("PURCHASE_NO_SUPPLIERS", 409, "Escolha pelo menos um fornecedor.");
        await tx.purchaseRequest.update({ where: { id: record.id }, data: { status: "quoting", startedAt: new Date() } });
        await event(tx, actor, requestId, "quoting_started", `Cotação iniciada com ${record.invites.length} ${record.invites.length === 1 ? "fornecedor" : "fornecedores"}.`,
          { reason: "O agente comprador ainda não manda as mensagens nesta versão: as propostas são registradas à mão." });
      });
      return this.getRequest(actor.workspaceId, requestId);
    },

    async recordQuote(actor: Actor, requestId: string, inviteId: string, body: unknown, source: PurchaseQuoteSource = "manual") {
      const input = purchaseQuoteInputSchema.parse(body);
      await prisma.$transaction(async (tx) => {
        const record = await loadRequest(actor.workspaceId, requestId, tx);
        if (!["quoting", "awaiting_approval"].includes(record.status)) throw new PurchasingError("PURCHASE_INVALID_TRANSITION", 409, "Inicie a cotação antes de registrar propostas.");
        const invite = record.invites.find((candidate) => candidate.id === inviteId);
        if (!invite) throw new PurchasingError("PURCHASE_INVITE_NOT_FOUND", 404, "Fornecedor não está neste pedido.");
        const itemIds = new Set(record.items.map((item) => item.id));
        if (input.lines.some((line) => !itemIds.has(line.itemId))) throw new PurchasingError("PURCHASE_ITEM_NOT_FOUND", 400, "Item não pertence a este pedido.");
        if (new Set(input.lines.map((line) => line.itemId)).size !== input.lines.length) throw new PurchasingError("PURCHASE_DUPLICATE_LINE", 400, "Item repetido na proposta.");
        const previous = invite.quotes.at(-1);
        const version = (previous?.version ?? 0) + 1;
        const quote = await tx.purchaseQuote.create({ data: {
          workspaceId: actor.workspaceId, inviteId, version, kind: input.kind, source,
          freightCents: input.freightCents, deliveryText: input.deliveryText,
          deliveryDate: input.deliveryDate ? dateFromIso(input.deliveryDate) : null, paymentTerms: input.paymentTerms,
          validUntil: input.validUntil ? dateFromIso(input.validUntil) : null, observation: input.observation, origin: input.origin,
          createdByUserId: actor.userId ?? null
        } });
        await tx.purchaseQuoteLine.createMany({ data: input.lines.map((line) => ({ workspaceId: actor.workspaceId, quoteId: quote.id, itemId: line.itemId, unitPriceCents: line.unitPriceCents })) });
        await tx.purchaseQuoteInvite.update({ where: { id: inviteId }, data: { status: "quote_received", lastReplyAt: new Date(), declinedReason: null } });
        const total = quoteTotalCents(record.items, input);
        const before = previous ? quoteTotalCents(record.items, { lines: previous.lines, freightCents: previous.freightCents }) : null;
        const change = total !== null && before !== null && total !== before
          ? ` (${formatCents(before)} → ${formatCents(total)})` : total !== null ? ` (${formatCents(total)})` : "";
        await event(tx, actor, requestId, `quote_${input.kind}`, `${KIND_LABEL[input.kind]}: ${invite.supplier.name}${change}.`,
          { inviteId, metadata: { version, totalCents: total, previousTotalCents: before } });
      });
      return this.getRequest(actor.workspaceId, requestId);
    },

    async declineInvite(actor: Actor, requestId: string, inviteId: string, reason: string | null) {
      await prisma.$transaction(async (tx) => {
        const record = await loadRequest(actor.workspaceId, requestId, tx);
        const invite = record.invites.find((candidate) => candidate.id === inviteId);
        if (!invite) throw new PurchasingError("PURCHASE_INVITE_NOT_FOUND", 404, "Fornecedor não está neste pedido.");
        if (!OPEN_REQUEST.includes(record.status as PurchaseRequestStatus)) throw new PurchasingError("PURCHASE_CLOSED", 409, "Este pedido já foi encerrado.");
        await tx.purchaseQuoteInvite.update({ where: { id: inviteId }, data: { status: "declined", declinedReason: reason } });
        await event(tx, actor, requestId, "supplier_declined", `${invite.supplier.name} não vai cotar.`, { inviteId, reason });
      });
      return this.getRequest(actor.workspaceId, requestId);
    },

    /** A person approves one supplier's current quote. The agent never closes a purchase by itself. */
    async approve(actor: Actor, requestId: string, inviteId: string) {
      await prisma.$transaction(async (tx) => {
        const record = await loadRequest(actor.workspaceId, requestId, tx);
        const invite = record.invites.find((candidate) => candidate.id === inviteId);
        if (!invite) throw new PurchasingError("PURCHASE_INVITE_NOT_FOUND", 404, "Fornecedor não está neste pedido.");
        const quote = invite.quotes.at(-1);
        const total = quote ? quoteTotalCents(record.items, { lines: quote.lines, freightCents: quote.freightCents }) : null;
        if (!quote || total === null) throw new PurchasingError("PURCHASE_QUOTE_INCOMPLETE", 409, "Essa proposta ainda não tem preço para todos os itens.");
        const claimed = await tx.purchaseRequest.updateMany({
          where: { workspaceId: actor.workspaceId, id: requestId, status: { in: ["quoting", "awaiting_approval"] } },
          data: { status: "approved", approvedInviteId: inviteId, approvedAt: new Date(), approvedByUserId: actor.userId ?? null }
        });
        if (claimed.count !== 1) throw new PurchasingError("PURCHASE_INVALID_TRANSITION", 409, "Este pedido não está aguardando aprovação.");
        await tx.purchaseQuoteInvite.update({ where: { id: inviteId }, data: { status: "winner" } });
        await tx.purchaseQuoteInvite.updateMany({ where: { workspaceId: actor.workspaceId, requestId, id: { not: inviteId }, status: { notIn: ["declined"] } }, data: { status: "lost" } });
        await tx.priceHistory.createMany({ data: record.items.flatMap((item) => {
          const line = quote.lines.find((candidate) => candidate.itemId === item.id);
          return line ? [{ workspaceId: actor.workspaceId, itemName: item.description, itemKey: purchaseItemKey(item.description),
            supplierId: invite.supplierId, supplierName: invite.supplier.name, unit: item.unit, quantity: item.quantity,
            unitPriceCents: line.unitPriceCents, paidAt: new Date(), source: "request", requestId }] : [];
        }) });
        await event(tx, actor, requestId, "approved", `Aprovado: ${invite.supplier.name} por ${formatCents(total)}.`, { inviteId, metadata: { totalCents: total } });
      });
      return this.getRequest(actor.workspaceId, requestId);
    },

    async cancel(actor: Actor, requestId: string) {
      await prisma.$transaction(async (tx) => {
        const claimed = await tx.purchaseRequest.updateMany({ where: { workspaceId: actor.workspaceId, id: requestId, status: { in: OPEN_REQUEST } },
          data: { status: "canceled", canceledAt: new Date() } });
        if (claimed.count !== 1) throw new PurchasingError("PURCHASE_INVALID_TRANSITION", 409, "Este pedido não pode mais ser cancelado.");
        await event(tx, actor, requestId, "canceled", "Pedido cancelado.");
      });
      return this.getRequest(actor.workspaceId, requestId);
    },

    async complete(actor: Actor, requestId: string) {
      await prisma.$transaction(async (tx) => {
        const claimed = await tx.purchaseRequest.updateMany({ where: { workspaceId: actor.workspaceId, id: requestId, status: "approved" }, data: { status: "completed" } });
        if (claimed.count !== 1) throw new PurchasingError("PURCHASE_INVALID_TRANSITION", 409, "Aprove uma proposta antes de concluir.");
        await event(tx, actor, requestId, "completed", "Compra recebida e pedido concluído.");
      });
      return this.getRequest(actor.workspaceId, requestId);
    },

    // ── Preços pagos ──────────────────────────────────────────────────────────────────────────────
    async listPriceHistory(workspaceId: string, search?: string): Promise<PriceHistoryDto[]> {
      const key = search ? purchaseItemKey(search) : "";
      const rows = await prisma.priceHistory.findMany({
        where: { workspaceId, ...(key ? { itemKey: { contains: key } } : {}) }, orderBy: { paidAt: "desc" }, take: 500
      });
      return rows.map(toPriceDto);
    },

    async importPriceHistory(workspaceId: string, rows: unknown[]) {
      const rejected: Array<{ row: number; reason: string }> = [];
      const data: Prisma.PriceHistoryCreateManyInput[] = [];
      const suppliers = await prisma.supplier.findMany({ where: { workspaceId }, select: { id: true, name: true } });
      const byName = new Map(suppliers.map((supplier) => [purchaseItemKey(supplier.name), supplier.id]));
      for (const [index, row] of rows.entries()) {
        const parsed = priceHistoryRowSchema.safeParse(row);
        if (!parsed.success) { rejected.push({ row: index + 1, reason: firstIssue(parsed.error) }); continue; }
        const value = parsed.data;
        data.push({ workspaceId, itemName: value.itemName, itemKey: purchaseItemKey(value.itemName), supplierName: value.supplierName,
          supplierId: value.supplierName ? byName.get(purchaseItemKey(value.supplierName)) ?? null : null,
          unit: value.unit, quantity: value.quantity, unitPriceCents: value.unitPriceCents, paidAt: dateFromIso(value.paidAt), source: "import" });
      }
      if (data.length) await prisma.priceHistory.createMany({ data });
      return { created: data.length, rejected };
    }
  };
}

function toPriceDto(row: Prisma.PriceHistoryGetPayload<object>): PriceHistoryDto {
  return { id: row.id, itemName: row.itemName, supplierName: row.supplierName, unit: row.unit, quantity: row.quantity,
    unitPriceCents: row.unitPriceCents, paidAt: isoDate(row.paidAt)!, source: row.source === "request" ? "request" : "import" };
}

export type PurchasingService = ReturnType<typeof createPurchasingService>;
