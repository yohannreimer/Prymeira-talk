import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPurchasingService, PurchasingError } from "./purchasing.service.js";

const url = process.env.PURCHASING_TEST_DATABASE_URL;
if (url && !/^postgresql:\/\/[^@]+@127\.0\.0\.1:\d+\/purchasing_test(?:\?|$)/.test(url)) {
  throw new Error("Refusing a non-disposable Purchasing test database.");
}

describe.skipIf(!url)("Orçamentos on PostgreSQL", () => {
  const db = new PrismaClient({ datasources: { db: { url: url ?? "postgresql://invalid/unused" } } });
  const service = createPurchasingService(db);
  const workspaceId = `purchasing-${randomUUID()}`;
  const actor = { workspaceId, userId: "user_owner" };
  // The fixture's response deadline is October 18. Keep this flow before that
  // deadline so a later CI date does not turn a partial response into a decision.
  beforeAll(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-17T12:00:00Z")); });
  afterAll(async () => { vi.useRealTimers(); await db.$disconnect(); });

  it("runs a request from suppliers to approval, keeping the choradinha visible and the price paid", async () => {
    const silva = await service.createSupplier(workspaceId, { name: "Móveis Silva", phone: "(47) 99999-0001", categories: ["Móveis"] });
    const office = await service.createSupplier(workspaceId, { name: "Office Max", phone: "47999990002", categories: ["móveis"], preferred: true });
    await expect(service.createSupplier(workspaceId, { name: "Outro", phone: "47 99999-0001" })).rejects.toMatchObject({ code: "PURCHASE_SUPPLIER_DUPLICATE" });
    expect(silva.phone).toBe("5547999990001");

    const imported = await service.importSuppliers(workspaceId, [
      { name: "Ergo Sul", phone: "4733330000", city: "Gaspar" }, { name: "", phone: "1" }, { name: "Office Max", phone: "47999990002", categories: ["escritório"] }
    ]);
    expect(imported).toMatchObject({ created: 1, updated: 1 });
    expect(imported.rejected).toHaveLength(1);

    await service.importPriceHistory(workspaceId, [{ itemName: "Cadeira Giratória", supplierName: "Office Max", unitPriceCents: 78_000, paidAt: "2026-03-10" }]);

    let request = await service.createRequest(actor, {
      title: "20 cadeiras", items: [{ description: "Cadeira giratória", quantity: 20, unit: "un" }],
      responseDeadline: "2026-10-18", deliveryDeadline: "2026-11-10", deliveryCep: "89201-000", budgetCeilingCents: 1_800_000,
      supplierIds: [silva.id, office.id]
    });
    expect(request.status).toBe("draft");
    expect(request.items[0]!.lastPaid).toMatchObject({ unitPriceCents: 78_000, supplierName: "Office Max" });
    const item = request.items[0]!.id;
    const silvaInvite = request.invites.find((invite) => invite.supplier.id === silva.id)!.id;
    const officeInvite = request.invites.find((invite) => invite.supplier.id === office.id)!.id;

    await expect(service.recordQuote(actor, request.id, silvaInvite, { lines: [], freightCents: 0 })).rejects.toMatchObject({ code: "PURCHASE_INVALID_TRANSITION" });
    request = await service.startQuoting(actor, request.id);
    expect(request.status).toBe("quoting");

    const quote = { freightCents: 35_000, deliveryDate: "2026-11-08", paymentTerms: "28/56", validUntil: "2026-10-30" };
    await service.recordQuote(actor, request.id, silvaInvite, { ...quote, lines: [{ itemId: item, unitPriceCents: 89_000 }] });
    request = await service.recordQuote(actor, request.id, silvaInvite, { ...quote, kind: "choradinha", lines: [{ itemId: item, unitPriceCents: 84_500 }] });
    const silvaColumn = request.comparison.columns.find((column) => column.inviteId === silvaInvite)!;
    expect(silvaColumn).toMatchObject({ firstTotalCents: 1_815_000, totalCents: 1_725_000, savingsCents: 90_000, choradinhaDone: true });
    expect(request.needsDecision).toBe(false);

    request = await service.recordQuote(actor, request.id, officeInvite, { freightCents: 0, deliveryDate: "2026-11-05", paymentTerms: "PIX",
      lines: [{ itemId: item, unitPriceCents: 81_200 }] });
    expect(request.needsDecision).toBe(true);
    expect(request.comparison.recommended?.inviteId).toBe(officeInvite);
    expect(request.events[0]!.summary).toContain("Office Max");

    request = await service.approve(actor, request.id, officeInvite);
    expect(request.status).toBe("approved");
    expect(request.invites.find((invite) => invite.id === officeInvite)!.status).toBe("winner");
    expect(request.invites.find((invite) => invite.id === silvaInvite)!.status).toBe("lost");
    await expect(service.approve(actor, request.id, silvaInvite)).rejects.toBeInstanceOf(PurchasingError);

    const prices = await service.listPriceHistory(workspaceId, "cadeira");
    expect(prices.map((price) => price.unitPriceCents)).toEqual(expect.arrayContaining([81_200, 78_000]));
    const list = await service.listRequests(workspaceId);
    expect(list[0]).toMatchObject({ approvedSupplierName: "Office Max", answered: 2, invited: 2, savingsCents: 90_000 });
    const suppliers = await service.listSuppliers(workspaceId);
    expect(suppliers[0]).toMatchObject({ name: "Office Max", stats: { invited: 1, answered: 1, won: 1 } });

    expect((await service.complete(actor, request.id)).status).toBe("completed");
  });

  it("keeps workspaces apart and refuses blocked suppliers", async () => {
    const blocked = await service.createSupplier(workspaceId, { name: "Bloqueado", phone: "47988887777", blocked: true });
    const base = { title: "x", items: [{ description: "y", quantity: 1, unit: "un" }], responseDeadline: "2026-10-18", deliveryDeadline: "2026-11-10", deliveryCep: "89201000" };
    await expect(service.createRequest(actor, { ...base, supplierIds: [blocked.id] })).rejects.toMatchObject({ code: "PURCHASE_SUPPLIER_BLOCKED" });
    await expect(service.createRequest({ workspaceId: `other-${randomUUID()}` }, { ...base, supplierIds: [blocked.id] })).rejects.toMatchObject({ code: "PURCHASE_SUPPLIER_NOT_FOUND" });
    const request = await service.createRequest(actor, base);
    await expect(service.getRequest(`other-${randomUUID()}`, request.id)).rejects.toMatchObject({ code: "PURCHASE_NOT_FOUND" });
  });
});
