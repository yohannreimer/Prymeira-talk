import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { readTalkAddons } from "../../plugins/auth-context.js";
import { purchasingRoutes } from "./purchasing.routes.js";
import type { PurchasingService } from "./purchasing.service.js";

async function appWith(talk: { role: "owner" | "manager" | "agent"; orcamentos: boolean }) {
  const app = Fastify();
  const service = { listRequests: vi.fn(async () => []), approve: vi.fn(async () => ({ status: "approved" })) } as unknown as PurchasingService;
  app.addHook("onRequest", async (request) => {
    request.talk = { workspaceId: "w1", role: talk.role, addons: { orcamentos: talk.orcamentos } };
  });
  await app.register(purchasingRoutes, { service });
  return { app, service };
}

const inviteUrl = "/purchasing/requests/2f1b6d2e-7c55-4f7f-9a61-6f1b0b4a7f10/invites/7a3a7d1d-1c8e-4c1b-8f7a-2d8f3a9b1c22/approve";

describe("Orçamentos routes", () => {
  it("answers 403 until the Hub releases the add-on", async () => {
    const { app } = await appWith({ role: "owner", orcamentos: false });
    const response = await app.inject({ method: "GET", url: "/purchasing/requests" });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("PURCHASING_ADDON_DISABLED");
  });

  it("serves the module once released", async () => {
    const { app } = await appWith({ role: "agent", orcamentos: true });
    expect((await app.inject({ method: "GET", url: "/purchasing/requests" })).statusCode).toBe(200);
  });

  it("lets only an owner or manager approve a purchase", async () => {
    const agent = await appWith({ role: "agent", orcamentos: true });
    expect((await agent.app.inject({ method: "POST", url: inviteUrl })).json().code).toBe("PURCHASE_APPROVE_FORBIDDEN");
    expect(agent.service.approve).not.toHaveBeenCalled();
    const manager = await appWith({ role: "manager", orcamentos: true });
    expect((await manager.app.inject({ method: "POST", url: inviteUrl })).statusCode).toBe(200);
  });
});

describe("add-on release", () => {
  it("reads limits.modules.orcamentos from the Hub and the internal-test override", () => {
    expect(readTalkAddons({ modules: { orcamentos: true } }, "w1").orcamentos).toBe(true);
    expect(readTalkAddons({ modules: { campaignProspecting: true } }, "w1").orcamentos).toBe(false);
    expect(readTalkAddons(undefined, "w1", new Set(["w1"])).orcamentos).toBe(true);
    expect(readTalkAddons(undefined, "w2", new Set(["w1"])).orcamentos).toBe(false);
    expect(readTalkAddons({}, "any", "*").orcamentos).toBe(true);
  });
});
