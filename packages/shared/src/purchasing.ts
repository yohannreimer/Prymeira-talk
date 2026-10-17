import { z } from "zod";

/*
 * Orçamentos (compras): the add-on where the buyer agent asks suppliers for quotes on WhatsApp, does one
 * price-improvement ask ("choradinha"), and hands the company a comparison to approve.
 * Money travels in cents so totals never drift.
 */

export const purchaseRequestStatusSchema = z.enum(["draft", "quoting", "awaiting_approval", "approved", "canceled", "completed"]);
export type PurchaseRequestStatus = z.infer<typeof purchaseRequestStatusSchema>;

export const purchaseInviteStatusSchema = z.enum([
  "queued", "sent", "replied", "no_response", "declined", "quote_received", "negotiating", "winner", "lost"
]);
export type PurchaseInviteStatus = z.infer<typeof purchaseInviteStatusSchema>;

/** initial: the first full quote; choradinha: the answer to the price-improvement ask; counter: later rounds; correction: a fixed number. */
export const purchaseQuoteKindSchema = z.enum(["initial", "choradinha", "counter", "correction"]);
export type PurchaseQuoteKind = z.infer<typeof purchaseQuoteKindSchema>;
export const purchaseQuoteSourceSchema = z.enum(["agent", "manual"]);
export type PurchaseQuoteSource = z.infer<typeof purchaseQuoteSourceSchema>;

const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a data no formato AAAA-MM-DD.");
const centsSchema = z.number().int().min(0).max(100_000_000_000);
const optionalText = (max: number) => z.string().trim().max(max).optional().nullable().transform((value) => value ? value : null);

export function normalizePhone(value: string) {
  const digits = value.replace(/\D/g, "");
  if (digits.length === 10 || digits.length === 11) return `55${digits}`;
  return digits;
}

export const supplierInputSchema = z.object({
  name: z.string().trim().min(1).max(160),
  phone: z.string().trim().transform(normalizePhone).refine((value) => value.length >= 10 && value.length <= 15, "Telefone inválido."),
  contactName: optionalText(120),
  email: optionalText(200),
  cnpj: optionalText(20),
  city: optionalText(120),
  categories: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  notes: optionalText(2000),
  preferred: z.boolean().default(false),
  blocked: z.boolean().default(false)
});
export type SupplierInput = z.input<typeof supplierInputSchema>;

export const supplierUpdateSchema = supplierInputSchema.partial();
export const supplierImportSchema = z.object({ rows: z.array(z.unknown()).min(1).max(2000) });
export type SupplierImportResult = { created: number; updated: number; rejected: Array<{ row: number; reason: string }> };

export const purchaseItemInputSchema = z.object({
  description: z.string().trim().min(1).max(200),
  specification: optionalText(1000),
  quantity: z.number().positive().max(10_000_000),
  unit: z.string().trim().min(1).max(20)
});

export const purchaseRequestInputSchema = z.object({
  title: z.string().trim().min(1).max(160),
  items: z.array(purchaseItemInputSchema).min(1).max(50),
  responseDeadline: isoDateSchema,
  deliveryDeadline: isoDateSchema,
  deliveryCep: z.string().trim().transform((value) => value.replace(/\D/g, "")).refine((value) => value.length === 8, "CEP com 8 dígitos."),
  deliveryCity: optionalText(120),
  budgetCeilingCents: centsSchema.positive().optional().nullable().transform((value) => value ?? null),
  paymentPreference: optionalText(200),
  requiresInvoice: z.boolean().default(true),
  notes: optionalText(2000),
  supplierIds: z.array(z.string().uuid()).max(30).default([])
}).refine((value) => value.responseDeadline <= value.deliveryDeadline, {
  message: "O prazo de resposta precisa vir antes da data de entrega.", path: ["responseDeadline"]
});
export type PurchaseRequestInput = z.input<typeof purchaseRequestInputSchema>;

export const purchaseQuoteInputSchema = z.object({
  kind: purchaseQuoteKindSchema.default("initial"),
  lines: z.array(z.object({ itemId: z.string().uuid(), unitPriceCents: centsSchema })).max(50),
  freightCents: centsSchema.nullable().default(null),
  deliveryText: optionalText(120),
  deliveryDate: isoDateSchema.optional().nullable().transform((value) => value ?? null),
  paymentTerms: optionalText(120),
  validUntil: isoDateSchema.optional().nullable().transform((value) => value ?? null),
  observation: optionalText(1000),
  origin: optionalText(4000)
});
export type PurchaseQuoteInput = z.input<typeof purchaseQuoteInputSchema>;

/** How the buyer agent works on a request: "review" leaves each message as a draft for a person to send; "auto" sends on its own. */
export const purchaseAgentModeSchema = z.enum(["review", "auto"]);
export type PurchaseAgentMode = z.infer<typeof purchaseAgentModeSchema>;

/** Starting the quote. With `agent`, the buyer agent asks the suppliers on WhatsApp from that number; without it, quotes are registered by hand. */
export const purchaseStartSchema = z.object({
  agent: z.object({ mode: purchaseAgentModeSchema, channelId: z.string().uuid() }).optional().nullable().transform((value) => value ?? null)
});
export type PurchaseStartInput = z.input<typeof purchaseStartSchema>;

export const purchaseDraftSendSchema = z.object({ text: z.string().trim().min(1).max(4000).optional() });

export const priceHistoryImportSchema = z.object({ rows: z.array(z.unknown()).min(1).max(5000) });
export const priceHistoryRowSchema = z.object({
  itemName: z.string().trim().min(1).max(200),
  supplierName: optionalText(160),
  unit: optionalText(20),
  quantity: z.number().positive().optional().nullable().transform((value) => value ?? null),
  unitPriceCents: centsSchema,
  paidAt: isoDateSchema
});
export type PriceHistoryRow = z.input<typeof priceHistoryRowSchema>;

// ── DTOs ─────────────────────────────────────────────────────────────────────────────────────────

export type SupplierDto = {
  id: string;
  name: string;
  phone: string;
  contactName: string | null;
  email: string | null;
  cnpj: string | null;
  city: string | null;
  categories: string[];
  notes: string | null;
  preferred: boolean;
  blocked: boolean;
  stats: { invited: number; answered: number; won: number };
  createdAt: string;
};

export type PurchaseItemDto = {
  id: string;
  position: number;
  description: string;
  specification: string | null;
  quantity: number;
  unit: string;
  /** Last price paid for this item (price history), as a reference. */
  lastPaid: { unitPriceCents: number; supplierName: string | null; paidAt: string } | null;
};

export type PurchaseQuoteVersionDto = {
  id: string;
  version: number;
  kind: PurchaseQuoteKind;
  source: PurchaseQuoteSource;
  lines: Array<{ itemId: string; unitPriceCents: number }>;
  freightCents: number | null;
  deliveryText: string | null;
  deliveryDate: string | null;
  paymentTerms: string | null;
  validUntil: string | null;
  observation: string | null;
  origin: string | null;
  totalCents: number | null;
  createdAt: string;
};

export type PurchaseInviteDto = {
  id: string;
  status: PurchaseInviteStatus;
  supplier: { id: string; name: string; phone: string; contactName: string | null; city: string | null };
  conversationId: string | null;
  followupCount: number;
  declinedReason: string | null;
  sentAt: string | null;
  lastReplyAt: string | null;
  quotes: PurchaseQuoteVersionDto[];
  /** What the buyer agent is doing in this conversation; null when the request runs by hand. */
  agent: PurchaseInviteAgentDto | null;
};

export type PurchaseInviteAgentDto = {
  /** The agent's stage in this conversation (nao_iniciado, abordado, conversando, choradinha, aguardando_empresa, declinou, encerrado, humano). */
  stage: string;
  /** A message the agent wrote and a person still has to send (review mode). */
  draft: { text: string; move: string; createdAt: string } | null;
  /** The agent stopped and a person has to answer in the conversation. */
  needsHuman: { reason: string; summary: string; at: string } | null;
  /** The agent is about to read or write (supplier just answered, opening queued). */
  working: boolean;
  error: string | null;
};

export type PurchaseEventDto = {
  id: string;
  inviteId: string | null;
  type: string;
  summary: string;
  reason: string | null;
  createdAt: string;
};

export type PurchaseRequestSummaryDto = {
  id: string;
  title: string;
  status: PurchaseRequestStatus;
  /** Quoting, but nothing left to wait for: every supplier answered or the response deadline passed. */
  needsDecision: boolean;
  responseDeadline: string;
  deliveryDeadline: string;
  itemCount: number;
  invited: number;
  answered: number;
  bestTotalCents: number | null;
  savingsCents: number;
  approvedSupplierName: string | null;
  updatedAt: string;
};

export type PurchaseRequestDetailDto = Omit<PurchaseRequestSummaryDto, "itemCount" | "invited" | "answered" | "bestTotalCents" | "savingsCents"> & {
  deliveryCep: string;
  deliveryCity: string | null;
  budgetCeilingCents: number | null;
  paymentPreference: string | null;
  requiresInvoice: boolean;
  notes: string | null;
  approvedInviteId: string | null;
  approvedAt: string | null;
  createdAt: string;
  items: PurchaseItemDto[];
  invites: PurchaseInviteDto[];
  comparison: PurchaseComparison;
  events: PurchaseEventDto[];
  /** True when the buyer agent talks to the suppliers on WhatsApp; false when quotes are registered by hand. */
  agentConnected: boolean;
  agent: { mode: PurchaseAgentMode; channel: { id: string; name: string } | null } | null;
  /** WhatsApp numbers the agent can ask from (shown when the quote starts). */
  agentChannels: Array<{ id: string; name: string }>;
};

export type PriceHistoryDto = {
  id: string;
  itemName: string;
  supplierName: string | null;
  unit: string | null;
  quantity: number | null;
  unitPriceCents: number;
  paidAt: string;
  source: "import" | "request";
};

// ── Comparison (mapa de cotação) ─────────────────────────────────────────────────────────────────

export type ComparisonColumn = {
  inviteId: string;
  supplierName: string;
  status: PurchaseInviteStatus;
  totalCents: number | null;
  /** Total of the first complete version, before any price-improvement ask. */
  firstTotalCents: number | null;
  savingsCents: number;
  savingsPercent: number;
  /** Whether the price-improvement ask has been answered in a version of this quote. */
  choradinhaDone: boolean;
  missing: string[];
  freightCents: number | null;
  deliveryText: string | null;
  deliveryDate: string | null;
  deliveryLate: boolean;
  paymentTerms: string | null;
  validUntil: string | null;
  expired: boolean;
  expiresSoon: boolean;
  lines: Record<string, { unitPriceCents: number; firstUnitPriceCents: number | null } | undefined>;
};

export type PurchaseComparison = {
  columns: ComparisonColumn[];
  /** itemId → inviteId with the lowest unit price for it. */
  bestPerItem: Record<string, string>;
  recommended: { inviteId: string; reason: string } | null;
  bestTotalCents: number | null;
  totalSavingsCents: number;
};

type ComparisonInput = {
  items: Array<{ id: string; description: string; quantity: number }>;
  deliveryDeadline: string;
  invites: Array<{
    id: string;
    status: PurchaseInviteStatus;
    supplierName: string;
    quotes: Array<Pick<PurchaseQuoteVersionDto, "version" | "kind" | "lines" | "freightCents" | "deliveryText" | "deliveryDate" | "paymentTerms" | "validUntil">>;
  }>;
  /** ISO date of "today", injectable for tests. */
  today: string;
};

export function quoteTotalCents(
  items: Array<{ id: string; quantity: number }>,
  quote: { lines: Array<{ itemId: string; unitPriceCents: number }>; freightCents: number | null }
): number | null {
  let total = 0;
  for (const item of items) {
    const line = quote.lines.find((candidate) => candidate.itemId === item.id);
    if (!line) return null;
    total += Math.round(line.unitPriceCents * item.quantity);
  }
  return total + (quote.freightCents ?? 0);
}

function addDays(iso: string, days: number) {
  const date = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function daysBetween(fromIso: string, toIso: string) {
  return Math.round((Date.parse(`${toIso.slice(0, 10)}T00:00:00Z`) - Date.parse(`${fromIso.slice(0, 10)}T00:00:00Z`)) / 86_400_000);
}

export function buildPurchaseComparison(input: ComparisonInput): PurchaseComparison {
  const columns: ComparisonColumn[] = [];
  for (const invite of input.invites) {
    const versions = [...invite.quotes].sort((left, right) => left.version - right.version);
    const current = versions.at(-1);
    if (!current) continue;
    const firstComplete = versions.find((version) => quoteTotalCents(input.items, version) !== null) ?? null;
    const totalCents = quoteTotalCents(input.items, current);
    const firstTotalCents = firstComplete ? quoteTotalCents(input.items, firstComplete) : null;
    const savingsCents = totalCents !== null && firstTotalCents !== null && firstTotalCents > totalCents ? firstTotalCents - totalCents : 0;
    const missing = input.items.filter((item) => !current.lines.some((line) => line.itemId === item.id)).map((item) => item.description);
    if (current.freightCents === null) missing.push("frete");
    if (!current.deliveryText && !current.deliveryDate) missing.push("prazo de entrega");
    if (!current.paymentTerms) missing.push("pagamento");
    const lines: ComparisonColumn["lines"] = {};
    for (const line of current.lines) {
      const first = firstComplete?.lines.find((candidate) => candidate.itemId === line.itemId)?.unitPriceCents ?? null;
      lines[line.itemId] = { unitPriceCents: line.unitPriceCents, firstUnitPriceCents: first !== null && first !== line.unitPriceCents ? first : null };
    }
    columns.push({
      inviteId: invite.id,
      supplierName: invite.supplierName,
      status: invite.status,
      totalCents,
      firstTotalCents,
      savingsCents,
      savingsPercent: firstTotalCents ? Math.round((savingsCents / firstTotalCents) * 1000) / 10 : 0,
      choradinhaDone: versions.some((version) => version.kind === "choradinha"),
      missing,
      freightCents: current.freightCents,
      deliveryText: current.deliveryText,
      deliveryDate: current.deliveryDate,
      deliveryLate: Boolean(current.deliveryDate && current.deliveryDate > input.deliveryDeadline.slice(0, 10)),
      paymentTerms: current.paymentTerms,
      validUntil: current.validUntil,
      expired: Boolean(current.validUntil && current.validUntil < input.today),
      expiresSoon: Boolean(current.validUntil && current.validUntil >= input.today && current.validUntil <= addDays(input.today, 2)),
      lines
    } satisfies ComparisonColumn);
  }

  const active = columns.filter((column) => column.status !== "declined");
  columns.sort((left, right) => (left.totalCents ?? Number.MAX_SAFE_INTEGER) - (right.totalCents ?? Number.MAX_SAFE_INTEGER));

  const bestPerItem: Record<string, string> = {};
  for (const item of input.items) {
    let best: { inviteId: string; price: number } | null = null;
    for (const column of active) {
      const price = column.lines[item.id]?.unitPriceCents;
      if (price !== undefined && (!best || price < best.price)) best = { inviteId: column.inviteId, price };
    }
    if (best) bestPerItem[item.id] = best.inviteId;
  }

  const eligible = active.filter((column) => column.totalCents !== null && column.missing.length === 0 && !column.deliveryLate && !column.expired)
    .sort((left, right) => left.totalCents! - right.totalCents!);
  const priced = active.filter((column) => column.totalCents !== null);
  const bestTotalCents = priced.length ? Math.min(...priced.map((column) => column.totalCents!)) : null;
  let recommended: PurchaseComparison["recommended"] = null;
  const winner = eligible[0];
  if (winner) {
    const reasons = [`menor total com frete (${formatCents(winner.totalCents!)})`];
    const others = eligible.slice(1);
    if (others.length) {
      const average = others.reduce((sum, column) => sum + column.totalCents!, 0) / others.length;
      const below = Math.round(((average - winner.totalCents!) / average) * 100);
      if (below > 0) reasons.push(`${below}% abaixo da média das outras`);
    }
    if (winner.deliveryDate) {
      const early = daysBetween(winner.deliveryDate, input.deliveryDeadline);
      reasons.push(early > 0 ? `entrega ${early} ${early === 1 ? "dia" : "dias"} antes do limite` : "entrega dentro do limite");
    }
    if (winner.savingsCents > 0) reasons.push(`já baixou ${formatCents(winner.savingsCents)} na choradinha`);
    recommended = { inviteId: winner.inviteId, reason: capitalize(reasons.join(", ")) + "." };
  }

  return {
    columns,
    bestPerItem,
    recommended,
    bestTotalCents,
    totalSavingsCents: active.reduce((sum, column) => sum + column.savingsCents, 0)
  };
}

export function formatCents(cents: number) {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

/** Lowercase, accent-free, single-spaced: how price history matches a request item. */
export function purchaseItemKey(name: string) {
  return name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
