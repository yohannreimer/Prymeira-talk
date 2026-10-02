import Fastify from "fastify";
import type { ChannelHealthDto } from "@prymeira-talk/shared";
import { describe, expect, it, vi } from "vitest";
import { buildApp as buildFullApp } from "../../test/build-app.js";
import { channelsRoutes } from "./channels.routes.js";

const channelId = "00000000-0000-4000-8000-000000000001";
const otherChannelId = "00000000-0000-4000-8000-000000000002";

const channelRow = {
  id: channelId,
  workspaceId: "workspace_a",
  provider: "evolution" as const,
  providerKey: "demo-evolution",
  phoneNumber: null,
  displayName: "Vendas 6",
  status: "connected" as const,
  encryptedConfig: {},
  createdAt: new Date("2026-05-20T10:00:00.000Z"),
  updatedAt: new Date("2026-05-20T10:00:00.000Z")
};

function health(id: string, over: Partial<ChannelHealthDto> = {}): ChannelHealthDto {
  return { channelId: id, state: "ok", since: null, lastInboundAt: null, attempts: 0, ...over };
}

function fakeChannelHealth() {
  const byWorkspace: Record<string, ChannelHealthDto[]> = {
    workspace_a: [health(channelId, { state: "silent" })],
    workspace_b: [health(otherChannelId)]
  };
  return {
    getHealth: vi.fn((workspaceId: string) => byWorkspace[workspaceId] ?? []),
    markManualDisconnect: vi.fn(),
    clearManualDisconnect: vi.fn()
  };
}

async function buildChannelsApp(
  channelHealth?: ReturnType<typeof fakeChannelHealth>,
  channelUpdate: () => Promise<unknown> = async () => ({ ...channelRow, status: "disconnected" })
) {
  const app = Fastify({ logger: false });
  const prisma = {
    channel: {
      findMany: vi.fn().mockResolvedValue([channelRow]),
      findFirst: vi.fn().mockResolvedValue(channelRow),
      update: vi.fn().mockImplementation(channelUpdate)
    },
    integrationConfig: { findUnique: vi.fn().mockResolvedValue(null) }
  };

  app.decorate("prisma", prisma as never);
  app.decorate("realtime", { publish: vi.fn(), addClient: vi.fn(), clientCount: vi.fn() });
  app.addHook("preHandler", async (request) => {
    request.talk = { workspaceId: "workspace_a", role: "agent" };
  });
  await app.register(channelsRoutes, { channelHealth });

  return { app, prisma };
}

describe("GET /channels/health", () => {
  it("returns only the health entries of the requesting workspace", async () => {
    const channelHealth = fakeChannelHealth();
    const { app } = await buildChannelsApp(channelHealth);

    const response = await app.inject({ method: "GET", url: "/channels/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ health: [health(channelId, { state: "silent" })] });
    expect(channelHealth.getHealth).toHaveBeenCalledWith("workspace_a");
    expect(channelHealth.getHealth).not.toHaveBeenCalledWith("workspace_b");
    await app.close();
  });

  it("is served by the static route, not swallowed by /channels/:channelId", async () => {
    const { app, prisma } = await buildChannelsApp(fakeChannelHealth());

    const response = await app.inject({ method: "GET", url: "/channels/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveProperty("health");
    expect(prisma.channel.findMany).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns an empty list when no watchdog is configured", async () => {
    const { app } = await buildChannelsApp(undefined);

    const response = await app.inject({ method: "GET", url: "/channels/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ health: [] });
    await app.close();
  });

  it("is reachable in the fully assembled app, with an empty list while no watchdog runs", async () => {
    const app = await buildFullApp();

    const response = await app.inject({ method: "GET", url: "/channels/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ health: [] });
    await app.close();
  });
});

describe("manual disconnect tracking", () => {
  it("marks the channel as manually disconnected after a successful disconnect", async () => {
    const channelHealth = fakeChannelHealth();
    const { app } = await buildChannelsApp(channelHealth);

    const response = await app.inject({ method: "POST", url: `/channels/${channelId}/disconnect` });

    expect(response.statusCode).toBe(200);
    expect(channelHealth.markManualDisconnect).toHaveBeenCalledWith(channelId);
    expect(channelHealth.clearManualDisconnect).not.toHaveBeenCalled();
    await app.close();
  });

  it("does not mark the channel when the disconnect fails", async () => {
    const channelHealth = fakeChannelHealth();
    const { app } = await buildChannelsApp(channelHealth, async () => {
      throw new Error("database down");
    });

    const response = await app.inject({ method: "POST", url: `/channels/${channelId}/disconnect` });

    expect(response.statusCode).toBe(500);
    expect(channelHealth.markManualDisconnect).not.toHaveBeenCalled();
    await app.close();
  });

  it("clears the manual disconnect after a successful reconnect", async () => {
    const channelHealth = fakeChannelHealth();
    const { app } = await buildChannelsApp(channelHealth, async () => ({ ...channelRow, status: "connecting" }));

    const response = await app.inject({ method: "POST", url: `/channels/${channelId}/reconnect` });

    expect(response.statusCode).toBe(200);
    expect(channelHealth.clearManualDisconnect).toHaveBeenCalledWith(channelId);
    expect(channelHealth.markManualDisconnect).not.toHaveBeenCalled();
    await app.close();
  });

  it("does not clear the manual disconnect when the reconnect fails", async () => {
    const channelHealth = fakeChannelHealth();
    const { app } = await buildChannelsApp(channelHealth, async () => {
      throw new Error("database down");
    });

    const response = await app.inject({ method: "POST", url: `/channels/${channelId}/reconnect` });

    expect(response.statusCode).toBe(500);
    expect(channelHealth.clearManualDisconnect).not.toHaveBeenCalled();
    await app.close();
  });

  it("clears the manual disconnect after a successful QR session start", async () => {
    const channelHealth = fakeChannelHealth();
    const { app } = await buildChannelsApp(channelHealth, async () => ({ ...channelRow, status: "connecting" }));

    const response = await app.inject({ method: "POST", url: `/channels/${channelId}/qr` });

    expect(response.statusCode).toBe(200);
    expect(channelHealth.clearManualDisconnect).toHaveBeenCalledWith(channelId);
    await app.close();
  });

  it("does not clear the manual disconnect when the QR session fails", async () => {
    const channelHealth = fakeChannelHealth();
    const { app, prisma } = await buildChannelsApp(channelHealth);
    prisma.channel.findFirst.mockResolvedValue(null);

    const response = await app.inject({ method: "POST", url: `/channels/${channelId}/qr` });

    expect(response.statusCode).toBe(404);
    expect(channelHealth.clearManualDisconnect).not.toHaveBeenCalled();
    await app.close();
  });

  it("works without a watchdog configured", async () => {
    const { app } = await buildChannelsApp(undefined);

    const response = await app.inject({ method: "POST", url: `/channels/${channelId}/disconnect` });

    expect(response.statusCode).toBe(200);
    await app.close();
  });
});
