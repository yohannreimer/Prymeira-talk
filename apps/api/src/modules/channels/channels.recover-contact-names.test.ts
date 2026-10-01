import Fastify from "fastify";
import type { UserRole } from "@prymeira-talk/shared";
import { describe, expect, it, vi } from "vitest";
import { channelsRoutes } from "./channels.routes.js";

const workspaceId = "workspace_a";
const updatedAt = new Date("2026-05-01T10:00:00.000Z");

function createPrisma(channels: Array<{ id: string; providerKey: string }> = [{ id: "channel-1", providerKey: "instance-1" }]) {
  const contacts = [
    { id: "c-1", phone: "5547999990001", name: "Você", updatedAt },
    { id: "c-2", phone: "5547999990002", name: "5547999990002", updatedAt },
    { id: "c-3", phone: "5547999990003", name: "Ana", updatedAt }
  ];
  return {
    channel: { findMany: vi.fn().mockResolvedValue(channels) },
    contact: {
      findMany: vi.fn().mockImplementation(async (args: { where: { id?: unknown } }) => (args.where.id ? [] : contacts)),
      updateMany: vi.fn().mockResolvedValue({ count: 1 })
    }
  };
}

function createSource() {
  return {
    recentContacts: vi.fn().mockResolvedValue([
      { phoneJid: "5547999990001@s.whatsapp.net", name: "Maria Souza", profilePicUrl: null }
    ])
  };
}

async function buildApp(input: {
  role?: UserRole;
  prisma?: ReturnType<typeof createPrisma>;
  source?: ReturnType<typeof createSource> | undefined;
} = {}) {
  const prisma = input.prisma ?? createPrisma();
  const source = "source" in input ? input.source : createSource();
  const app = Fastify({ logger: false });
  app.decorate("prisma", prisma as never);
  app.decorate("realtime", { publish: vi.fn(), addClient: vi.fn(), clientCount: vi.fn() });
  app.addHook("preHandler", async (request) => {
    request.talk = { workspaceId, role: input.role ?? "owner" } as never;
  });
  await app.register(channelsRoutes, { evolutionHistorySource: source });
  return { app, prisma, source };
}

describe("POST /channels/recover-contact-names", () => {
  it("rejects roles that cannot manage the workspace", async () => {
    for (const role of ["agent", "manager"] as const) {
      const { app, prisma, source } = await buildApp({ role });
      const response = await app.inject({ method: "POST", url: "/channels/recover-contact-names", payload: { dryRun: false } });
      expect(response.statusCode).toBe(403);
      expect(response.json().error).toMatch(/permissão/i);
      expect(prisma.channel.findMany).not.toHaveBeenCalled();
      expect(source!.recentContacts).not.toHaveBeenCalled();
      expect(prisma.contact.updateMany).not.toHaveBeenCalled();
    }
  });

  it("returns 409 when the workspace has no connected Evolution channel", async () => {
    const { app, prisma, source } = await buildApp({ prisma: createPrisma([]) });
    const response = await app.inject({ method: "POST", url: "/channels/recover-contact-names", payload: {} });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatch(/nenhum canal/i);
    expect(prisma.channel.findMany).toHaveBeenCalledWith({
      where: { workspaceId, provider: "evolution", status: "connected" },
      select: { id: true, providerKey: true }
    });
    expect(source!.recentContacts).not.toHaveBeenCalled();
  });

  it("returns 409 when the Evolution history source is not configured", async () => {
    const { app, prisma } = await buildApp({ source: undefined });
    const response = await app.inject({ method: "POST", url: "/channels/recover-contact-names", payload: { dryRun: true } });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("Histórico da Evolution indisponível");
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
  });

  it("defaults to a dry run without writing anything", async () => {
    const { app, prisma, source } = await buildApp();
    const response = await app.inject({ method: "POST", url: "/channels/recover-contact-names" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ dryRun: true, channelsChecked: 1, failedChannels: 0, candidates: 2, recovered: 1, cleared: 1, skipped: 0 });
    expect(source!.recentContacts).toHaveBeenCalledWith({ instanceName: "instance-1" });
    expect(prisma.contact.updateMany).not.toHaveBeenCalled();
  });

  it("rejects an invalid body", async () => {
    const { app } = await buildApp();
    const response = await app.inject({ method: "POST", url: "/channels/recover-contact-names", payload: { dryRun: "nope" } });
    expect(response.statusCode).toBe(400);
  });

  it("repairs names when dryRun is false", async () => {
    const { app, prisma } = await buildApp();
    const response = await app.inject({ method: "POST", url: "/channels/recover-contact-names", payload: { dryRun: false } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ dryRun: false, channelsChecked: 1, failedChannels: 0, candidates: 2, recovered: 1, cleared: 1, skipped: 0 });
    expect(prisma.contact.updateMany).toHaveBeenCalledWith({
      where: { id: "c-1", workspaceId, name: "Você" }, data: { name: "Maria Souza", updatedAt }
    });
    expect(prisma.contact.updateMany).toHaveBeenCalledWith({
      where: { id: "c-2", workspaceId, name: "5547999990002" }, data: { name: null, updatedAt }
    });
  });
});
