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

  it('counts contacts in a saved list during review', async () => {
    const result = await previewCampaignAudience({
      campaign: { id: 'campaign-list', updatedAt: '2026-09-28T19:15:00Z',
        audience: { type: 'list', listId: 'list-1' }, messageBody: 'Olá' }, channelId: 'channel-1',
      contacts: [{ audienceKey: 'contact-1', contactId: 'contact-1', name: 'Ana', phone: '5547999999999', fields: {} }],
      verify: async (numbers) => numbers.map((phone) => ({ phone, available: true }))
    });
    expect(result.selectedCount).toBe(1);
  });
});

const baseCampaign = { id: "c1", updatedAt: "2026-10-01T00:00:00Z", audience: { type: "imported" }, messageBody: "Olá {{nome}}, tudo bem?", templates: ["Olá {{nome}}, tudo bem?"], fallbackName: "cliente" };
const verifyAll = async (numbers: string[]) => numbers.map((phone) => ({ phone, available: true }));

describe("previewCampaignAudience com nome inteligente", () => {
  it("usa o primeiro nome da pessoa e omite o nome de empresas", async () => {
    const preview = await previewCampaignAudience({
      campaign: baseCampaign, channelId: "ch",
      contacts: [
        { audienceKey: "a", contactId: null, name: "Agnaldo - Teporti", phone: "5547991309466", fields: {} },
        { audienceKey: "b", contactId: null, name: "Metalpress", phone: "5547933944090", fields: {} }
      ],
      firstNames: { a: "Agnaldo", b: null }, verify: verifyAll
    });
    expect(preview.eligible.map((row) => row.message)).toEqual(["Olá Agnaldo, tudo bem?", "Olá, tudo bem?"]);
    expect(preview.unresolvedVariables).toEqual([]);
  });

  it("sem firstNames, nunca envia o nome salvo nem a palavra cliente", async () => {
    const preview = await previewCampaignAudience({
      campaign: baseCampaign, channelId: "ch",
      contacts: [{ audienceKey: "a", contactId: null, name: "Metalpress", phone: "5547933944090", fields: {} }],
      verify: verifyAll
    });
    expect(preview.eligible[0]!.message).toBe("Olá, tudo bem?");
  });

  it("continua apontando campos personalizados sem valor", async () => {
    const preview = await previewCampaignAudience({
      campaign: { ...baseCampaign, messageBody: "{{cidade}}", templates: ["{{cidade}}"] }, channelId: "ch",
      contacts: [{ audienceKey: "a", contactId: null, name: null, phone: "5547933944090", fields: {} }],
      verify: verifyAll
    });
    expect(preview.unresolvedVariables).toEqual(["cidade"]);
  });
});
