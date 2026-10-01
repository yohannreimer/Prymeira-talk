import { describe, expect, it, vi } from "vitest";
import { cleanFirstName, createNameInsightService } from "./name-insight.js";

type Row = { id: string; customFields: unknown; updatedAt: Date };

function setup(rows: Row[], analyzeImpl?: (request: { data: { names: Array<{ id: number; name: string }> } }) => unknown) {
  const updates: Array<{ id: string; customFields: Record<string, unknown>; updatedAt: Date }> = [];
  const prisma = {
    contact: {
      findMany: vi.fn(async () => rows),
      update: vi.fn(async (args: { where: { workspaceId_id: { id: string } }; data: { customFields: Record<string, unknown>; updatedAt: Date } }) => {
        updates.push({ id: args.where.workspaceId_id.id, ...args.data });
      })
    }
  };
  const analyze = vi.fn(async (request: never) => (analyzeImpl ?? ((r) => ({
    results: r.data.names.map((item) => ({
      id: item.id,
      kind: /ltda|metal/i.test(item.name) ? "company" : "person",
      firstName: /ltda|metal/i.test(item.name) ? null : item.name.split(/[ -]/)[0]
    }))
  })))(request as never));
  const service = createNameInsightService({ prisma, analyze: analyze as never, now: () => new Date("2026-10-01T12:00:00Z") });
  return { service, prisma, analyze, updates };
}

describe("cleanFirstName", () => {
  it("tira símbolos, pega a primeira palavra e normaliza a caixa", () => {
    expect(cleanFirstName("🏄‍♂️Alexei")).toBe("Alexei");
    expect(cleanFirstName("LUCAS Fortunato")).toBe("Lucas");
    expect(cleanFirstName("maria helena")).toBe("Maria");
    expect(cleanFirstName("  ")).toBeNull();
  });
});

describe("name insight service", () => {
  it("classifica nomes novos, grava no contato e devolve o primeiro nome", async () => {
    const { service, updates, analyze } = setup([
      { id: "c1", customFields: { vip: true }, updatedAt: new Date("2026-09-01T00:00:00Z") },
      { id: "c2", customFields: {}, updatedAt: new Date("2026-09-02T00:00:00Z") }
    ]);
    const result = await service.resolve({ workspaceId: "w", contacts: [
      { audienceKey: "a", contactId: "c1", name: "Agnaldo - Teporti" },
      { audienceKey: "b", contactId: "c2", name: "Metalpress Ltda" }
    ] });
    expect(result).toEqual({ status: "ok", firstNames: { a: "Agnaldo", b: null } });
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(updates).toHaveLength(2);
    expect(updates[0]!.customFields).toMatchObject({ vip: true, nameInsight: { sourceName: "Agnaldo - Teporti", kind: "person", firstName: "Agnaldo" } });
    expect(updates[0]!.updatedAt).toEqual(new Date("2026-09-01T00:00:00Z"));
  });

  it("reaproveita a classificação guardada quando o nome não mudou", async () => {
    const stored = { nameInsight: { sourceName: "Ana Paula", kind: "person", firstName: "Ana", classifiedAt: "2026-09-30T00:00:00Z" } };
    const { service, analyze } = setup([{ id: "c1", customFields: stored, updatedAt: new Date() }]);
    const result = await service.resolve({ workspaceId: "w", contacts: [{ audienceKey: "a", contactId: "c1", name: "Ana Paula" }] });
    expect(result.firstNames).toEqual({ a: "Ana" });
    expect(analyze).not.toHaveBeenCalled();
  });

  it("reclassifica quando o nome do contato mudou", async () => {
    const stored = { nameInsight: { sourceName: "Ana Paula", kind: "person", firstName: "Ana", classifiedAt: "x" } };
    const { service, analyze } = setup([{ id: "c1", customFields: stored, updatedAt: new Date() }]);
    await service.resolve({ workspaceId: "w", contacts: [{ audienceKey: "a", contactId: "c1", name: "Metal Forte" }] });
    expect(analyze).toHaveBeenCalledTimes(1);
  });

  it("classifica linhas sem contato em memória e reaproveita no cache", async () => {
    const { service, analyze, prisma } = setup([]);
    const input = { workspaceId: "w", contacts: [{ audienceKey: "x", contactId: null, name: "Rodrigo Lippel" }] };
    expect((await service.resolve(input)).firstNames).toEqual({ x: "Rodrigo" });
    await service.resolve(input);
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(prisma.contact.update).not.toHaveBeenCalled();
  });

  it("nomes vazios ficam sem nome e não chamam a IA", async () => {
    const { service, analyze } = setup([]);
    const result = await service.resolve({ workspaceId: "w", contacts: [{ audienceKey: "a", contactId: null, name: "  " }, { audienceKey: "b", contactId: null, name: null }] });
    expect(result).toEqual({ status: "ok", firstNames: { a: null, b: null } });
    expect(analyze).not.toHaveBeenCalled();
  });

  it("quando a IA falha, segue sem nome e marca indisponível", async () => {
    const { service, updates } = setup([{ id: "c1", customFields: {}, updatedAt: new Date() }], () => { throw new Error("LUNA_ANALYSIS_UNAVAILABLE_not_configured"); });
    const result = await service.resolve({ workspaceId: "w", contacts: [{ audienceKey: "a", contactId: "c1", name: "Ana" }] });
    expect(result).toEqual({ status: "unavailable", firstNames: { a: null } });
    expect(updates).toHaveLength(0);
  });

  it("divide em lotes de 40 nomes", async () => {
    const contacts = Array.from({ length: 85 }, (_, i) => ({ audienceKey: `k${i}`, contactId: null, name: `Pessoa${i} Silva` }));
    const { service, analyze } = setup([]);
    await service.resolve({ workspaceId: "w", contacts });
    expect(analyze).toHaveBeenCalledTimes(3);
  });

  it("person sem primeiro nome utilizável vira unknown", async () => {
    const { service } = setup([], (r) => ({ results: r.data.names.map((n) => ({ id: n.id, kind: "person", firstName: "🙂" })) }));
    const result = await service.resolve({ workspaceId: "w", contacts: [{ audienceKey: "a", contactId: null, name: "🙂" }] });
    expect(result.firstNames).toEqual({ a: null });
  });
});
