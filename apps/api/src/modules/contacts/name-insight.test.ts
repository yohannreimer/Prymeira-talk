import { describe, expect, it, vi } from "vitest";
import { acceptAiInsight, resolveNameInsight, ruleInsight } from "./name-insight.js";

describe("how to address a contact", () => {
  it("reads a plain personal name without AI", () => {
    expect(ruleInsight("jackson cappelli", null)).toMatchObject({ firstName: "Jackson", fullName: "Jackson Cappelli", source: "rule" });
    expect(ruleInsight("Maria Cecília Broering", "Villefer")).toMatchObject({ firstName: "Maria", company: "Villefer" });
    expect(ruleInsight("Sr. Carlos Souza", null)).toMatchObject({ firstName: "Carlos", salutation: "Sr." });
    expect(ruleInsight("Dra Ana", null)).toMatchObject({ firstName: "Ana", salutation: "Dra." });
  });
  it("hands messy or business names to the AI, and has nothing to say about numbers", () => {
    for (const name of ["Pedro - Serralheria Ideal 🔨", "JULIANA 💅 Nails", "Construtora Alfa", "Carlos Obras", "Rafa 47"]) expect(ruleInsight(name, null)).toBeNull();
    expect(ruleInsight("182364311425240@lid", null)).toMatchObject({ firstName: null, source: "none" });
    expect(ruleInsight(null, null)).toMatchObject({ firstName: null, source: "none" });
  });
  it("only accepts from the AI what is written in the name", () => {
    expect(acceptAiInsight("Pedro - Serralheria Ideal 🔨", { firstName: "pedro", company: "Serralheria Ideal", salutation: null }, null))
      .toMatchObject({ firstName: "Pedro", company: "Serralheria Ideal", source: "ai" });
    expect(acceptAiInsight("Serralheria Ideal", { firstName: "João", company: "Serralheria Ideal Ltda", salutation: null }, null))
      .toMatchObject({ firstName: null, company: null });
    expect(acceptAiInsight("Dra. Ana | Clínica Sorriso", { firstName: "Ana", company: "Clínica Sorriso", salutation: "Dra." }, null)).toMatchObject({ salutation: "Dra." });
    expect(acceptAiInsight("x", "nonsense", "Villefer")).toMatchObject({ firstName: null, company: "Villefer" });
  });
  it("asks the AI once per contact, saves the answer and reuses it (and a manual one wins)", async () => {
    let customFields: Record<string, unknown> = {};
    const prisma = { contact: {
      findFirst: vi.fn(async () => ({ name: "Pedro - Serralheria Ideal 🔨", company: null, customFields })),
      updateMany: vi.fn(async ({ data }: { data: { customFields: Record<string, unknown> } }) => { customFields = data.customFields; return { count: 1 }; })
    } };
    const generate = vi.fn(async () => ({ reply: JSON.stringify({ firstName: "Pedro", company: "Serralheria Ideal", salutation: null }) }));
    const first = await resolveNameInsight(prisma as never, { workspaceId: "w", contactId: "c" }, { provider: { generate } as never, model: "m" });
    expect(first).toMatchObject({ firstName: "Pedro", company: "Serralheria Ideal", source: "ai" });
    const again = await resolveNameInsight(prisma as never, { workspaceId: "w", contactId: "c" }, { provider: { generate } as never, model: "m" });
    expect(again).toMatchObject({ firstName: "Pedro", source: "ai" }); expect(generate).toHaveBeenCalledOnce();
    customFields = { nameInsight: { firstName: "Pedrinho", company: null, source: "manual" } };
    expect(await resolveNameInsight(prisma as never, { workspaceId: "w", contactId: "c" }, null)).toMatchObject({ firstName: "Pedrinho", source: "manual" });
  });
  it("gives up quietly when the AI is slow, without saving a guess", async () => {
    const prisma = { contact: { findFirst: vi.fn(async () => ({ name: "JULIANA 💅 Nails", company: null, customFields: {} })), updateMany: vi.fn() } };
    const generate = vi.fn(() => new Promise(() => {}));
    const insight = await resolveNameInsight(prisma as never, { workspaceId: "w", contactId: "c" }, { provider: { generate } as never, model: "m" }, 20);
    expect(insight).toMatchObject({ firstName: null, source: "none" }); expect(prisma.contact.updateMany).not.toHaveBeenCalled();
  });
});
