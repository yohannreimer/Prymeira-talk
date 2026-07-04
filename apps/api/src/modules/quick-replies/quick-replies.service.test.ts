import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { quickRepliesRoutes } from "./quick-replies.routes.js";

const workspaceId = "local_workspace";
const quickReply = {
  id: "00000000-0000-4000-8000-000000000901",
  workspaceId,
  title: "Boas-vindas",
  body: "Olá! Como posso ajudar?",
  category: "Atendimento",
  createdAt: new Date("2026-05-24T12:00:00.000Z"),
  updatedAt: new Date("2026-05-24T12:00:00.000Z")
};

const notFoundError = Object.assign(new Error("Record not found"), { code: "P2025" });

async function createApp(
  overrides: Partial<
    Record<"findMany" | "create" | "update" | "delete", ReturnType<typeof vi.fn>>
  > = {}
) {
  const app = Fastify();
  app.decorate("prisma", {
    quickReply: {
      findMany: overrides.findMany ?? vi.fn().mockResolvedValue([quickReply]),
      create: overrides.create ?? vi.fn().mockResolvedValue(quickReply),
      update:
        overrides.update ?? vi.fn().mockResolvedValue({ ...quickReply, title: "Atualizada" }),
      delete: overrides.delete ?? vi.fn().mockResolvedValue(quickReply)
    }
  } as never);
  app.addHook("preHandler", async (request) => {
    request.talk = { workspaceId, role: "manager" };
  });
  await app.register(quickRepliesRoutes);
  return app;
}

describe("quick replies routes", () => {
  it("lists workspace quick replies", async () => {
    const app = await createApp();
    const response = await app.inject({ method: "GET", url: "/quick-replies" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      {
        ...quickReply,
        createdAt: "2026-05-24T12:00:00.000Z",
        updatedAt: "2026-05-24T12:00:00.000Z"
      }
    ]);
  });

  it("creates a quick reply", async () => {
    const create = vi.fn().mockResolvedValue(quickReply);
    const app = await createApp({ create });
    const response = await app.inject({
      method: "POST",
      url: "/quick-replies",
      payload: { title: "Boas-vindas", body: "Olá!", category: "Atendimento" }
    });

    expect(response.statusCode).toBe(201);
    expect(create).toHaveBeenCalledWith({
      data: {
        workspaceId,
        title: "Boas-vindas",
        body: "Olá!",
        category: "Atendimento"
      }
    });
  });

  it("updates a quick reply inside the workspace", async () => {
    const update = vi.fn().mockResolvedValue({ ...quickReply, title: "Atualizada" });
    const app = await createApp({ update });
    const response = await app.inject({
      method: "PATCH",
      url: `/quick-replies/${quickReply.id}`,
      payload: { title: "Atualizada" }
    });

    expect(response.statusCode).toBe(200);
    expect(update).toHaveBeenCalledWith({
      where: { workspaceId_id: { workspaceId, id: quickReply.id } },
      data: { title: "Atualizada" }
    });
  });

  it("returns 404 when updating a missing quick reply", async () => {
    const update = vi.fn().mockRejectedValue(notFoundError);
    const app = await createApp({ update });
    const response = await app.inject({
      method: "PATCH",
      url: `/quick-replies/${quickReply.id}`,
      payload: { title: "Atualizada" }
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      code: "QUICK_REPLY_NOT_FOUND",
      error: "Quick reply not found."
    });
  });

  it("rejects invalid quick reply create body", async () => {
    const create = vi.fn();
    const app = await createApp({ create });
    const response = await app.inject({
      method: "POST",
      url: "/quick-replies",
      payload: { title: "", body: "Olá!" }
    });

    expect(response.statusCode).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects empty quick reply update body", async () => {
    const update = vi.fn();
    const app = await createApp({ update });
    const response = await app.inject({
      method: "PATCH",
      url: `/quick-replies/${quickReply.id}`,
      payload: {}
    });

    expect(response.statusCode).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects invalid quick reply update id", async () => {
    const update = vi.fn();
    const app = await createApp({ update });
    const response = await app.inject({
      method: "PATCH",
      url: "/quick-replies/not-a-uuid",
      payload: { title: "Atualizada" }
    });

    expect(response.statusCode).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });

  it("deletes a quick reply inside the workspace", async () => {
    const remove = vi.fn().mockResolvedValue(quickReply);
    const app = await createApp({ delete: remove });
    const response = await app.inject({
      method: "DELETE",
      url: `/quick-replies/${quickReply.id}`
    });

    expect(response.statusCode).toBe(204);
    expect(remove).toHaveBeenCalledWith({
      where: { workspaceId_id: { workspaceId, id: quickReply.id } }
    });
  });

  it("returns 404 when deleting a missing quick reply", async () => {
    const remove = vi.fn().mockRejectedValue(notFoundError);
    const app = await createApp({ delete: remove });
    const response = await app.inject({
      method: "DELETE",
      url: `/quick-replies/${quickReply.id}`
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      code: "QUICK_REPLY_NOT_FOUND",
      error: "Quick reply not found."
    });
  });

  it("rejects invalid quick reply delete id", async () => {
    const remove = vi.fn();
    const app = await createApp({ delete: remove });
    const response = await app.inject({
      method: "DELETE",
      url: "/quick-replies/not-a-uuid"
    });

    expect(response.statusCode).toBe(400);
    expect(remove).not.toHaveBeenCalled();
  });
});
