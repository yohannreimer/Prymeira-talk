import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { quickRepliesRoutes } from "./quick-replies.routes.js";
import { normalizeShortcut } from "./quick-replies.service.js";

const workspaceId = "local_workspace";
type Row = { id: string; workspaceId: string; title: string; body: string; category: string | null; ownerUserId: string | null; shortcut: string | null; createdAt: Date; updatedAt: Date };

/** An in-memory quick_replies table with the filters the service uses. */
function fakePrisma(rows: Row[]) {
  let next = 1;
  const matches = (row: Row, where: { workspaceId: string; id?: string; OR?: Array<{ ownerUserId: string | null }> }) =>
    row.workspaceId === where.workspaceId && (!where.id || row.id === where.id) && (!where.OR || where.OR.some(option => option.ownerUserId === row.ownerUserId));
  return { quickReply: {
    findMany: async ({ where }: { where: never }) => rows.filter(row => matches(row, where)),
    findFirst: async ({ where }: { where: never }) => rows.find(row => matches(row, where)) ?? null,
    create: async ({ data }: { data: Partial<Row> }) => {
      const row = { id: `00000000-0000-4000-8000-${String(next++).padStart(12, "0")}`, category: null, ownerUserId: null, shortcut: null,
        createdAt: new Date("2026-10-04T00:00:00Z"), updatedAt: new Date("2026-10-04T00:00:00Z"), ...data } as Row;
      rows.push(row); return row;
    },
    update: async ({ where, data }: { where: { workspaceId_id: { id: string } }; data: Partial<Row> }) => Object.assign(rows.find(row => row.id === where.workspaceId_id.id)!, data),
    delete: async ({ where }: { where: { workspaceId_id: { id: string } } }) => rows.splice(rows.findIndex(row => row.id === where.workspaceId_id.id), 1)[0]
  } };
}
const row = (id: string, ownerUserId: string | null, title: string): Row => ({ id, workspaceId, title, body: `${title} texto`, category: null, ownerUserId,
  shortcut: normalizeShortcut(title), createdAt: new Date("2026-10-01T00:00:00Z"), updatedAt: new Date("2026-10-01T00:00:00Z") });

async function createApp(rows: Row[], clerkUserId: string | null = "user-junior") {
  const app = Fastify();
  app.decorate("prisma", fakePrisma(rows) as never);
  app.addHook("preHandler", async request => { request.talk = { workspaceId, role: "agent", clerkUserId }; });
  await app.register(quickRepliesRoutes);
  return app;
}
const ids = { team: "00000000-0000-4000-8000-000000000a01", mine: "00000000-0000-4000-8000-000000000a02", theirs: "00000000-0000-4000-8000-000000000a03" };
const seed = () => [row(ids.team, null, "Prospecção — Clínica padrão"), row(ids.mine, "user-junior", "Bem-vindo"), row(ids.theirs, "user-diogo", "Preços do Diogo")];

describe("personal quick replies", () => {
  it("lists my own and the team's, never a colleague's", async () => {
    const app = await createApp(seed());
    const list = (await app.inject({ method: "GET", url: "/quick-replies" })).json() as Array<{ title: string; shared: boolean; shortcut: string }>;
    expect(list.map(reply => [reply.title, reply.shared, reply.shortcut])).toEqual([["Prospecção — Clínica padrão", true, "prospeccaoclinicapadrao"], ["Bem-vindo", false, "bemvindo"]]);
  });
  it("creates mine, with a shortcut from the title unless one is given", async () => {
    const rows = seed(); const app = await createApp(rows);
    const created = await app.inject({ method: "POST", url: "/quick-replies", payload: { title: "Boa tarde!", body: "{saudacao}, {primeiro_nome}!" } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ shortcut: "boatarde", shared: false });
    expect(rows.at(-1)).toMatchObject({ ownerUserId: "user-junior" });
    expect((await app.inject({ method: "POST", url: "/quick-replies", payload: { title: "X", body: "y", shortcut: "Olá Mundo!" } })).json()).toMatchObject({ shortcut: "olamundo" });
  });
  it("edits and deletes mine and the team's, but a colleague's is not found", async () => {
    const app = await createApp(seed());
    expect((await app.inject({ method: "PATCH", url: `/quick-replies/${ids.mine}`, payload: { title: "Bem-vindo 2", shortcut: "oi" } })).json()).toMatchObject({ title: "Bem-vindo 2", shortcut: "oi" });
    expect((await app.inject({ method: "PATCH", url: `/quick-replies/${ids.theirs}`, payload: { title: "x" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `/quick-replies/${ids.theirs}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `/quick-replies/${ids.mine}` })).statusCode).toBe(204);
  });
  it("imports a pack as my own copies and skips what I already have", async () => {
    const rows = seed(); const app = await createApp(rows);
    const response = await app.inject({ method: "POST", url: "/quick-replies/import", payload: { version: 1, replies: [
      { title: "Bem-vindo", body: "Bem-vindo texto" }, { title: "Frete", body: "O frete para {empresa} é grátis.", category: "Vendas" }] } });
    expect(response.json()).toEqual({ created: 1, skipped: 1 });
    expect(rows.at(-1)).toMatchObject({ title: "Frete", ownerUserId: "user-junior", shortcut: "frete", category: "Vendas" });
    expect((await app.inject({ method: "POST", url: "/quick-replies/import", payload: { replies: [] } })).statusCode).toBe(400);
  });
  it("without a known user (local development) everything stays shared, as before", async () => {
    const app = await createApp(seed(), null);
    expect(((await app.inject({ method: "GET", url: "/quick-replies" })).json() as unknown[]).length).toBe(3);
  });
});
