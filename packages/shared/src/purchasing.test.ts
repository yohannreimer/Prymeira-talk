import { describe, expect, it } from "vitest";
import { buildPurchaseComparison, normalizePhone, purchaseItemKey, purchaseRequestInputSchema, quoteTotalCents } from "./purchasing.js";

const items = [{ id: "i1", description: "Cadeira giratória", quantity: 20 }];
const base = { deliveryText: null, paymentTerms: "PIX", validUntil: "2026-10-30" };

describe("purchase comparison", () => {
  it("totals items times quantity plus freight, and only when every item has a price", () => {
    expect(quoteTotalCents(items, { lines: [{ itemId: "i1", unitPriceCents: 81_200 }], freightCents: 0 })).toBe(1_624_000);
    expect(quoteTotalCents(items, { lines: [], freightCents: 0 })).toBeNull();
  });

  it("shows the price before and after the choradinha and recommends the cheapest complete quote on time", () => {
    const comparison = buildPurchaseComparison({
      items, deliveryDeadline: "2026-11-10", today: "2026-10-16",
      invites: [
        { id: "silva", status: "quote_received", supplierName: "Móveis Silva", quotes: [
          { ...base, version: 1, kind: "initial", lines: [{ itemId: "i1", unitPriceCents: 89_000 }], freightCents: 35_000, deliveryDate: "2026-11-08" },
          { ...base, version: 2, kind: "choradinha", lines: [{ itemId: "i1", unitPriceCents: 84_500 }], freightCents: 35_000, deliveryDate: "2026-11-08" }
        ] },
        { id: "office", status: "quote_received", supplierName: "Office Max", quotes: [
          { ...base, version: 1, kind: "initial", lines: [{ itemId: "i1", unitPriceCents: 81_200 }], freightCents: 0, deliveryDate: "2026-11-05" }
        ] },
        { id: "ergo", status: "quote_received", supplierName: "Ergo Sul", quotes: [
          { ...base, version: 1, kind: "initial", lines: [{ itemId: "i1", unitPriceCents: 70_000 }], freightCents: 0, deliveryDate: "2026-11-15" }
        ] }
      ]
    });
    const silva = comparison.columns.find((column) => column.inviteId === "silva")!;
    expect(silva.firstTotalCents).toBe(1_815_000);
    expect(silva.totalCents).toBe(1_725_000);
    expect(silva.savingsCents).toBe(90_000);
    expect(silva.lines.i1).toEqual({ unitPriceCents: 84_500, firstUnitPriceCents: 89_000 });
    expect(silva.choradinhaDone).toBe(true);
    // Ergo is cheapest but delivers after the deadline, so it is flagged and not recommended.
    expect(comparison.columns.find((column) => column.inviteId === "ergo")!.deliveryLate).toBe(true);
    expect(comparison.bestPerItem.i1).toBe("ergo");
    expect(comparison.recommended?.inviteId).toBe("office");
    expect(comparison.recommended?.reason).toContain("5 dias antes do limite");
    expect(comparison.totalSavingsCents).toBe(90_000);
    expect(comparison.columns.map((column) => column.inviteId)).toEqual(["ergo", "office", "silva"]);
  });

  it("lists what is still missing and never recommends an incomplete quote", () => {
    const comparison = buildPurchaseComparison({
      items, deliveryDeadline: "2026-11-10", today: "2026-10-16",
      invites: [{ id: "a", status: "replied", supplierName: "A", quotes: [
        { version: 1, kind: "initial", lines: [{ itemId: "i1", unitPriceCents: 1 }], freightCents: null, deliveryText: null, deliveryDate: null, paymentTerms: null, validUntil: null }
      ] }]
    });
    expect(comparison.columns[0]!.missing).toEqual(["frete", "prazo de entrega", "pagamento"]);
    expect(comparison.recommended).toBeNull();
  });
});

describe("purchase inputs", () => {
  it("normalizes phones, CEP and item keys", () => {
    expect(normalizePhone("(47) 99139-6920")).toBe("5547991396920");
    expect(purchaseItemKey("  Cadeira Giratória c/ braço ")).toBe("cadeira giratoria c braco");
    const parsed = purchaseRequestInputSchema.parse({ title: "Cadeiras", items: [{ description: "Cadeira", quantity: 20, unit: "un" }],
      responseDeadline: "2026-10-18", deliveryDeadline: "2026-11-10", deliveryCep: "89201-000" });
    expect(parsed.deliveryCep).toBe("89201000");
    expect(parsed.requiresInvoice).toBe(true);
  });

  it("refuses a response deadline after the delivery date", () => {
    expect(purchaseRequestInputSchema.safeParse({ title: "x", items: [{ description: "y", quantity: 1, unit: "un" }],
      responseDeadline: "2026-12-01", deliveryDeadline: "2026-11-10", deliveryCep: "89201000" }).success).toBe(false);
  });
});
