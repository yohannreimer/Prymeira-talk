import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { agentsRoutes } from "./agents.routes.js";

async function setup() {
  const app = Fastify();
  const agent = { id: "00000000-0000-4000-8000-000000000101", workspaceId: "workspace_a", name: "Pilot", status: "inactive", providerMode: "prymeira_managed", provider: "simulated", model: "simulated", systemPrompt: "Atenda bem e com clareza.", behaviorConfig: { reasoningEffort: "none", qualification: { mode: "pilot" } }, handoffConfig: {}, limitsConfig: {}, allowedActions: ["send_message"], createdAt: new Date(), updatedAt: new Date() };
  const create = vi.fn().mockImplementation(async ({ data }) => ({ ...agent, ...data }));
  const update = vi.fn().mockImplementation(async ({ data }) => ({ ...agent, ...data }));
  app.decorate("prisma", { aiAgent: { findFirst: vi.fn().mockResolvedValue(agent), create, update } } as unknown as typeof app.prisma);
  app.addHook("onRequest", async (request) => { request.talk = { workspaceId: "workspace_a", role: "owner" } as typeof request.talk; });
  await app.register(agentsRoutes);
  return { app, create, update };
}

describe("agent reasoning settings route", () => {
  it("accepts an explicit opt-in on create and reasoning-only updates", async () => {
    const { app } = await setup();
    try {
      const created = await app.inject({ method: "POST", url: "/agents", payload: { name: "Pilot", systemPrompt: "Atenda com clareza.", reasoningEffort: "low" } });
      expect(created.statusCode).toBe(201);
      expect(created.json().behaviorConfig.reasoningEffort).toBe("low");
      const updated = await app.inject({ method: "PATCH", url: "/agents/00000000-0000-4000-8000-000000000101", payload: { reasoningEffort: "low" } });
      expect(updated.statusCode).toBe(200);
      expect(updated.json().behaviorConfig).toEqual({ reasoningEffort: "low", qualification: { mode: "pilot" } });
    } finally { await app.close(); }
  });
  it.each(["high", "medium", "", null, 1])("rejects invalid reasoning on create/update: %s", async (reasoningEffort) => {
    const { app, create, update } = await setup();
    try {
      const created = await app.inject({ method: "POST", url: "/agents", payload: { name: "Pilot", systemPrompt: "Atenda com clareza.", reasoningEffort } });
      const updated = await app.inject({ method: "PATCH", url: "/agents/00000000-0000-4000-8000-000000000101", payload: { name: "Pilot", reasoningEffort } });
      expect(created.statusCode).toBe(400);
      expect(updated.statusCode).toBe(400);
      expect(create).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
});
