import { describe, expect, it, vi } from "vitest";
import { isInternalPersonal, readFollowupAudience, saveAiFollowupAudience } from "./followup-contact-audience.js";

function db(customFields: Record<string, unknown>) {
  return {
    contact: {
      findFirst: vi.fn(async () => ({ customFields })),
      updateMany: vi.fn(async (_args: { data: { customFields: Record<string, unknown> } }) => ({ count: 1 }))
    }
  };
}

const input = { workspaceId: "w", contactId: "c", now: new Date("2026-10-10T12:00:00.000Z") };

describe("follow-up contact audience", () => {
  it("marks a contact as internal when the AI is sure, keeping the other custom fields", async () => {
    const prisma = db({ nameInsight: { firstName: "Paulo" } });

    const saved = await saveAiFollowupAudience(prisma as never, { ...input, kind: "internal_personal", confidence: 0.9, reason: "Colega da Villefer" });

    expect(saved).toBe(true);
    const written = prisma.contact.updateMany.mock.calls[0]?.[0].data.customFields;
    expect(written).toEqual({
      nameInsight: { firstName: "Paulo" },
      followupAudience: { kind: "internal_personal", source: "ai", reason: "Colega da Villefer", at: "2026-10-10T12:00:00.000Z" }
    });
    expect(isInternalPersonal(written)).toBe(true);
  });

  it("does not mark on a weak guess and never overrides a person's choice", async () => {
    const unsure = db({});
    expect(await saveAiFollowupAudience(unsure as never, { ...input, kind: "internal_personal", confidence: 0.6, reason: null })).toBe(false);

    const manual = db({ followupAudience: { kind: "customer", source: "manual", reason: null, at: "x" } });
    expect(await saveAiFollowupAudience(manual as never, { ...input, kind: "internal_personal", confidence: 0.99, reason: null })).toBe(false);
    expect(manual.contact.updateMany).not.toHaveBeenCalled();
  });

  it("only writes a customer verdict to clear an earlier AI mark", async () => {
    const fresh = db({});
    expect(await saveAiFollowupAudience(fresh as never, { ...input, kind: "customer", confidence: 0.9, reason: null })).toBe(false);

    const marked = db({ followupAudience: { kind: "internal_personal", source: "ai", reason: "x", at: "x" } });
    expect(await saveAiFollowupAudience(marked as never, { ...input, kind: "customer", confidence: 0.9, reason: "Pediu orçamento" })).toBe(true);
    expect(readFollowupAudience(marked.contact.updateMany.mock.calls[0]?.[0].data.customFields)?.kind).toBe("customer");
  });
});
