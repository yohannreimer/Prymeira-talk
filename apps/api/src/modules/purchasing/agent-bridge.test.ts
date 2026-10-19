import { buildPurchaseComparison, type PurchaseRequestDetailDto } from "@prymeira-talk/shared";
import { describe, expect, it } from "vitest";
import { toBuyerAgentOrder } from "./agent-bridge.js";

const quote = (cents: number) => ({ id: `q${cents}`, version: 1, kind: "initial" as const, source: "manual" as const, lines: [{ itemId: "i1", unitPriceCents: cents }],
  freightCents: 0, deliveryText: null, deliveryDate: "2026-11-01", paymentTerms: "PIX", validUntil: null, observation: null, origin: null, totalCents: cents * 2, createdAt: "" });
const invite = (id: string, name: string, cents: number) => ({ id, status: "quote_received" as const, supplier: { id: `s-${id}`, name, phone: "", contactName: null, city: null },
  conversationId: null, followupCount: 0, declinedReason: null, sentAt: null, lastReplyAt: null, quotes: [quote(cents)] });

describe("buyer agent bridge", () => {
  it("hands the agent the order in reais, the other suppliers' names only as private data, and the best competing total", () => {
    const items = [{ id: "i1", position: 0, description: "Cadeira", specification: null, quantity: 2, unit: "un", lastPaid: null }];
    const invites = [invite("a", "Móveis Silva", 89_000), invite("b", "Office Max", 81_200)];
    const request = { id: "r1", items, invites, deliveryDeadline: "2026-11-10", responseDeadline: "2026-10-18", deliveryCep: "89201000", deliveryCity: null,
      requiresInvoice: true, paymentPreference: null, notes: null, budgetCeilingCents: 180_000,
      comparison: buildPurchaseComparison({ items: [{ id: "i1", description: "Cadeira", quantity: 2 }], deliveryDeadline: "2026-11-10", today: "2026-10-16",
        invites: invites.map((row) => ({ id: row.id, status: row.status, supplierName: row.supplier.name, quotes: row.quotes })) }) } as unknown as PurchaseRequestDetailDto;
    const order = toBuyerAgentOrder(request, "a", { nome: "Prymeira" });
    expect(order.itens).toEqual([{ id: "i1", descricao: "Cadeira", quantidade: 2, unidade: "un" }]);
    expect(order.privado).toMatchObject({ teto: 1800, concorrentes: ["Office Max"], melhorProposta: { total: 1624 }, maxChoradinhas: 1 });
  });
});
