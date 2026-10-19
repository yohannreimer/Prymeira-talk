import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { assistantInboxRoutes } from "./assistant-inbox.routes.js";
import { createEvolutionRuntime } from "../evolution/evolution-runtime.js";
import { createRealtimeHub } from "../realtime/realtime-hub.js";

describe("private handoff brief endpoint", () => {
  it("checks actor and conversation access, then reads even with suggestions disabled", async () => {
    const conversationId = randomUUID();
    const userId = randomUUID();
    const get = vi.fn(async () => ({ status: "ready", nextAction: "Verifique o material.", summary: "Quatro peças 1045.", contextKey: "key", updatedAt: new Date().toISOString(), error: null }));
    const prisma = {
      userProfile: { findFirst: vi.fn(async () => ({ id: userId })) },
      conversation: { findFirst: vi.fn(async ({ where }: any) => where.workspaceId === "other" ? null : ({ id: conversationId, assignedUserId: userId, channel: { encryptedConfig: { assistant: { mode: "disabled" } } } })) }
    };
    let auth = { workspaceId: "workspace", clerkUserId: "clerk", role: "agent" as "agent" | "owner" };
    const app = Fastify();
    app.decorate("prisma", prisma as never);
    app.decorate("realtime", createRealtimeHub());
    app.addHook("onRequest", async request => { request.talk = auth; });
    await app.register(assistantInboxRoutes, {
      evolution: createEvolutionRuntime({ mode: "simulated", publicTalkUrl: "http://localhost", localTalkUrl: "http://localhost", webhookSecret: "test" }),
      handoffBriefService: { get, schedule: vi.fn(), stop: vi.fn() } as never
    });
    try {
      const path = `/assistant/conversations/${conversationId}/handoff-brief`;
      expect((await app.inject({ url: path })).json()).toMatchObject({ status: "ready", nextAction: "Verifique o material." });
      expect(get).toHaveBeenCalledWith({ workspaceId: "workspace", conversationId });
      auth = { ...auth, workspaceId: "other" };
      expect((await app.inject({ url: path })).statusCode).toBe(404);
      expect(get).toHaveBeenCalledTimes(1);
      auth = { ...auth, workspaceId: "workspace", clerkUserId: "" };
      expect((await app.inject({ url: path })).statusCode).toBe(422);
    } finally { await app.close(); }
  });
});
