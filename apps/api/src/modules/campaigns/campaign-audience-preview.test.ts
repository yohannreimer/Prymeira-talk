import { describe, expect, it } from "vitest";
import { classifyRecipient, previewCampaignAudience } from "./campaign-audience-preview.js";

describe("campaign audience preview", () => {
  it("only accepts a verified response for the current normalized phone", () => {
    expect(classifyRecipient({ phone: "5547999999999", verification: {
      phone: "5547999999999", status: "available"
    } })).toBe("eligible");
    expect(classifyRecipient({ phone: "5547999999999", verification: {
      phone: "5547888888888", status: "available"
    } })).toBe("unverified");
    expect(classifyRecipient({ phone: "5547999999999", verification: {
      phone: "5547999999999", status: "unavailable"
    } })).toBe("no_whatsapp");
    expect(classifyRecipient({ phone: "invalid", verification: null })).toBe("missing_phone");
    expect(classifyRecipient({ phone: "5547999999999", verification: {
      phone: "5547999999999", status: "error"
    } })).toBe("verification_error");
  });

  it("deduplicates phones and reports unknown original selection for legacy drafts", async () => {
    const result = await previewCampaignAudience({
      campaign: { id: "campaign-1", updatedAt: new Date("2026-09-22T12:00:00Z"),
        audience: { type: "imported", rows: [] }, messageBody: "Olá {{nome}}", templates: ["Olá {{nome}}"] },
      channelId: "channel-1",
      contacts: [
        { audienceKey: "a", contactId: null, name: "Ana", phone: "47999999999", fields: {} },
        { audienceKey: "b", contactId: null, name: "Bia", phone: "5547999999999", fields: {} }
      ],
      verify: async () => [{ phone: "5547999999999", available: true }]
    });
    expect(result.selectedCount).toBeNull();
    expect(result.eligible).toHaveLength(1);
    expect(result.excluded[0]?.reason).toBe("duplicate");
    expect(result.audienceHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("checks the alternate Brazilian form before excluding a phone", async () => {
    const checked: string[][] = [];
    const result = await previewCampaignAudience({
      campaign: { id: "campaign-2", updatedAt: "2026-09-22T12:00:00Z",
        audience: {}, messageBody: "Olá" }, channelId: "channel-1",
      contacts: [{ audienceKey: "a", contactId: null, name: null,
        phone: "5547999999999", fields: {} }],
      verify: async (numbers) => { checked.push(numbers); return numbers.map((phone) => ({
        phone, available: phone.length === 12
      })); }
    });
    expect(checked).toHaveLength(2);
    expect(result.eligible).toHaveLength(1);
    expect(result.excluded).toHaveLength(0);
  });

  it("counts the current board audience without calling it an old imported selection", async () => {
    const result = await previewCampaignAudience({
      campaign: { id: "campaign-board", updatedAt: "2026-09-22T12:00:00Z",
        audience: { type: "board" }, messageBody: "Olá" }, channelId: "channel-1",
      contacts: [{ audienceKey: "a", contactId: "contact-a", name: null,
        phone: "5547999999999", fields: {} }],
      verify: async (numbers) => numbers.map((phone) => ({ phone, available: true }))
    });
    expect(result.selectedCount).toBe(1);
  });
});
