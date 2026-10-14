import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SupervisionGrant } from "@prymeira-talk/shared";
import { createSupervisionService } from "./supervision.service.js";
import { loadWeeklyFollowupCatalog, weeklyFollowupCatalogSchema, type WeeklyFollowupCatalog } from "./weekly-followup-catalog.js";

const workspace = randomUUID(), channel = randomUUID(), conversationId = randomUUID();
const grant: SupervisionGrant = { id: randomUUID(), supervisor_customer_id: randomUUID(), seller_customer_id: randomUUID(),
  seller_name: "Ana", seller_email: "ana@example.test", workspace_id: workspace, channel_id: channel };
const record = { id: conversationId, workspaceId: workspace, channelId: channel, contactId: randomUUID(),
  contact: { name: "Cliente autorizado", phone: "5511000000000" }, channel: { phoneNumber: "5511999999999", provider: "evolution" },
  status: "closed", priority: "normal", unreadCount: 0, assignedUserId: null, departmentId: null, activeAgentSession: null };
const catalog: WeeklyFollowupCatalog = [{ id: "2026-10-05", label: "5 a 11 de outubro", startDate: "2026-10-05", endDate: "2026-10-11",
  items: [{ workspaceId: workspace, conversationId, kind: "follow_up", suggestion: "Conseguiu avaliar o material?" },
    { workspaceId: randomUUID(), conversationId: randomUUID(), kind: "seller_reminder", suggestion: "Privado de outro cliente" }] }];
function setup(records = [record]) {
  const findMany = vi.fn().mockResolvedValue(records);
  const prisma = { conversation: { findMany }, message: {}, channel: {} };
  return { findMany, service: createSupervisionService(prisma as never) };
}

describe("manual weekly supervision selection", () => {
  it("intersects published workspace/conversation pairs with authorized channel scope; keeps closed conversations and current identities", async () => {
    const { service, findMany } = setup();
    const data = await service.followupWeeks([grant], catalog);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { AND: [
      { OR: [{ workspaceId: workspace, channelId: channel }] }, { hiddenUntilReply: false, retiredIntoConversationId: null },
      { OR: catalog[0].items.map(item => ({ workspaceId: item.workspaceId, id: item.conversationId })) }
    ] } }));
    expect(data.weeks[0]).toMatchObject({ followupCount: 1, reminderCount: 0 });
    expect(data.conversations).toHaveLength(1);
    expect(data.conversations[0]).toMatchObject({ status: "closed", contactName: "Cliente autorizado", channelPhoneNumber: "5511999999999",
      sellerName: "Ana", weeklyFollowup: { weekId: "2026-10-05", kind: "follow_up", suggestion: "Conseguiu avaliar o material?" } });
    expect(JSON.stringify(data)).not.toContain("Privado de outro cliente");
  });
  it("reveals no week labels or totals without matching authorized records", async () => {
    const { service } = setup([]);
    await expect(service.followupWeeks([grant], catalog)).resolves.toEqual({ weeks: [], selectedWeekId: null, conversations: [] });
    await expect(service.followupWeeks([grant], catalog, "2026-10-05")).rejects.toMatchObject({ statusCode: 404 });
  });
  it("fails closed when grants or filtered seller access have been revoked", async () => {
    const { service, findMany } = setup();
    await expect(service.followupWeeks([], catalog)).rejects.toMatchObject({ statusCode: 403 });
    await expect(service.followupWeeks([grant], catalog, undefined, randomUUID())).rejects.toMatchObject({ statusCode: 403 });
    expect(findMany).not.toHaveBeenCalled();
  });
  it("rejects duplicated items, inverted periods and malformed dates", () => {
    expect(weeklyFollowupCatalogSchema.safeParse([{ ...catalog[0], items: [catalog[0].items[0], catalog[0].items[0]] }]).success).toBe(false);
    expect(weeklyFollowupCatalogSchema.safeParse([{ ...catalog[0], endDate: "2026-10-04" }]).success).toBe(false);
    expect(weeklyFollowupCatalogSchema.safeParse([{ ...catalog[0], startDate: "2026-02-30" }]).success).toBe(false);
  });
  it("reads each manual publication anew and rejects unreadable or invalid configured files without exposing their contents", async () => {
    const directory = await mkdtemp(join(tmpdir(), "talk-weekly-test-")); const path = join(directory, "weeks.json");
    try {
      await writeFile(path, JSON.stringify(catalog)); expect(await loadWeeklyFollowupCatalog(path)).toEqual(catalog);
      await writeFile(path, "[]"); expect(await loadWeeklyFollowupCatalog(path)).toEqual([]);
      await writeFile(path, "private invalid catalog"); await expect(loadWeeklyFollowupCatalog(path)).rejects.toMatchObject({ statusCode: 503 });
      await expect(loadWeeklyFollowupCatalog(join(directory, "missing"))).rejects.toMatchObject({ statusCode: 503 });
    } finally { await rm(directory, { recursive: true }); }
  });
});
