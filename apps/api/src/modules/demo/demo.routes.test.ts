import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { demoRoutes } from "./demo.routes.js";
import type { DemoScenarioService } from "./demo-scenario.js";

const resetResult = {
  workspaceId: "demo_workspace",
  users: 5,
  conversations: 10,
  contacts: 10,
  agents: 1
};

const leadResult = {
  workspaceId: "demo_workspace",
  conversationId: "50000000-0000-4000-8000-000000000010",
  contactId: "60000000-0000-4000-8000-000000000010",
  created: true
};

async function buildDemoApp(input: {
  enabled?: boolean;
  workspaceId?: string;
  role?: "owner" | "manager" | "agent";
} = {}) {
  const app = Fastify({ logger: false });
  const service = {
    reset: vi.fn().mockResolvedValue(resetResult),
    simulateLead: vi.fn().mockResolvedValueOnce(leadResult).mockResolvedValue({
      ...leadResult,
      created: false
    })
  } as unknown as DemoScenarioService;

  app.addHook("preHandler", async (request) => {
    request.talk = {
      workspaceId: input.workspaceId ?? "demo_workspace",
      role: input.role ?? "owner"
    };
  });
  await app.register(demoRoutes, {
    enabled: input.enabled ?? true,
    demoWorkspaceId: "demo_workspace",
    service
  });

  return { app, service };
}

describe("demo routes", () => {
  it("rejects operations when local demo mode is disabled", async () => {
    const { app, service } = await buildDemoApp({ enabled: false });

    try {
      const response = await app.inject({ method: "POST", url: "/demo/reset" });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: "LOCAL_DEMO_DISABLED" });
      expect(service.reset).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("rejects a workspace other than the configured demo workspace", async () => {
    const { app } = await buildDemoApp({ workspaceId: "customer_workspace" });

    try {
      const response = await app.inject({ method: "POST", url: "/demo/reset" });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: "LOCAL_DEMO_WORKSPACE_MISMATCH" });
    } finally {
      await app.close();
    }
  });

  it("requires owner access", async () => {
    const { app } = await buildDemoApp({ role: "manager" });

    try {
      const response = await app.inject({ method: "POST", url: "/demo/reset" });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: "LOCAL_DEMO_OWNER_REQUIRED" });
    } finally {
      await app.close();
    }
  });

  it("resets the configured workspace", async () => {
    const { app, service } = await buildDemoApp();

    try {
      const response = await app.inject({ method: "POST", url: "/demo/reset" });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(resetResult);
      expect(service.reset).toHaveBeenCalledWith("demo_workspace");
    } finally {
      await app.close();
    }
  });

  it("keeps repeated lead simulation on the same contact and conversation", async () => {
    const { app, service } = await buildDemoApp();

    try {
      const first = await app.inject({ method: "POST", url: "/demo/simulate-lead" });
      const second = await app.inject({ method: "POST", url: "/demo/simulate-lead" });

      expect(first.json()).toEqual(leadResult);
      expect(second.json()).toEqual({ ...leadResult, created: false });
      expect(service.simulateLead).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });
});
