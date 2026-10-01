import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { campaignsRoutes } from "./campaigns.routes.js";

const workspaceId = "workspace-a";
const campaignId = "00000000-0000-4000-8000-000000000301";
const channelId = "00000000-0000-4000-8000-000000000302";
const date = new Date("2026-10-01T12:00:00Z");

const realAiConfig = { mode: "real", settings: {
  baseUrl: "https://ai.example.test/v1", apiKey: "test-key", chatModel: "test-model" } };

function setup(options: { role?: "owner" | "agent"; ai?: boolean } = {}) {
  const prisma = {
    integrationConfig: { findUnique: vi.fn().mockResolvedValue(options.ai ? realAiConfig : null) },
    channel: { findFirst: vi.fn().mockResolvedValue({ providerKey: "instance-a" }) },
    campaign: { findFirst: vi.fn().mockResolvedValue({
      id: campaignId, workspaceId, name: "Disparo", status: "draft",
      audience: { type: "imported", rows: [{ name: "Metalpress Ltda", phone: "5547999999999", fields: {} }] },
      messageBody: "Olá {{nome}}, tudo bem?", templates: ["Olá {{nome}}, tudo bem?"], fallbackName: "cliente",
      cadence: {}, scheduledAt: null, timeZone: "America/Sao_Paulo", prospectingAgentId: null,
      prospectingContext: null, hideFromInboxUntilReply: false, activationKey: null, mode: "real",
      createdAt: date, updatedAt: date }) }
  };
  const app = Fastify({ logger: false });
  app.decorate("prisma", prisma as never);
  app.addHook("preHandler", async (request) => {
    request.talk = { workspaceId, role: options.role ?? "owner" } as never;
  });
  const evolution = { mode: "real", client: { checkWhatsappNumbersAvailability: vi.fn(async ({ numbers }: { numbers: string[] }) =>
    ({ numbers: numbers.map((phone) => ({ phone, available: true })), raw: {} })) } };
  return { app, prisma, evolution };
}

async function build(options: Parameters<typeof setup>[0] = {}) {
  const ctx = setup(options);
  await ctx.app.register(campaignsRoutes, { evolution: ctx.evolution as never });
  return ctx;
}

afterEach(() => { vi.unstubAllGlobals(); });

const variationsRequest = (message: string) => ({
  method: "POST" as const, url: "/campaigns/message-variations", payload: { message } });

describe("POST /campaigns/message-variations", () => {
  it("denies roles without campaign management", async () => {
    const { app } = await build({ role: "agent" });
    try {
      expect((await app.inject(variationsRequest("Olá {{nome}}"))).statusCode).toBe(403);
    } finally { await app.close(); }
  });

  it("answers 409 when the workspace has no AI configured", async () => {
    const { app } = await build({ role: "owner" });
    try {
      const response = await app.inject(variationsRequest("Olá {{nome}}"));
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toContain("IA");
    } finally { await app.close(); }
  });

  it("rejects an empty message", async () => {
    const { app } = await build({ ai: true });
    try {
      expect((await app.inject(variationsRequest("   "))).statusCode).toBe(400);
    } finally { await app.close(); }
  });

  it("returns five valid variations from the AI", async () => {
    const variations = ["Oi {{nome}}", "E aí {{nome}}", "Bom dia {{nome}}", "Fala {{nome}}", "Opa {{nome}}", "Salve {{nome}}"];
    const fetchStub = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ variations }) } }]
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchStub);
    const { app } = await build({ ai: true });
    try {
      const response = await app.inject(variationsRequest("Olá {{nome}}"));
      expect(response.statusCode).toBe(200);
      expect(response.json().variations).toHaveLength(5);
      expect(fetchStub).toHaveBeenCalledTimes(1);
    } finally { await app.close(); }
  });
});

describe("POST /campaigns/message-variations when the AI answer is cut", () => {
  it("answers 422 with a clear message when the AI response is invalid", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      choices: [{ finish_reason: "length", message: { content: "" } }]
    }), { status: 200 })));
    const { app } = await build({ ai: true });
    try {
      const response = await app.inject(variationsRequest("Olá {{nome}}"));
      expect(response.statusCode).toBe(422);
      expect(response.json().error).toBe("A IA não conseguiu gerar variações para esta mensagem. Tente uma mensagem menor ou gere novamente.");
    } finally { await app.close(); }
  });
});

describe("POST /campaigns/:id/preview-audience", () => {
  it("reports nameCheck unavailable and omits a company-like name when the AI is unavailable", async () => {
    const { app } = await build({ role: "owner" });
    try {
      const response = await app.inject({ method: "POST", url: `/campaigns/${campaignId}/preview-audience`,
        payload: { channelId } });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.nameCheck).toBe("unavailable");
      expect(body.eligible).toHaveLength(1);
      expect(body.eligible[0].message).not.toContain("Metalpress");
    } finally { await app.close(); }
  });

  it("reports nameCheck ok and uses the first name of a person when the AI classifies it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
        results: [{ id: 0, kind: "person", firstName: "Agnaldo" }] }) } }]
    }), { status: 200 })));
    const { app, prisma } = await build({ ai: true });
    prisma.campaign.findFirst.mockResolvedValue({ ...(await prisma.campaign.findFirst()),
      audience: { type: "imported", rows: [{ name: "Agnaldo - Teporti", phone: "5547999999999", fields: {} }] } });
    try {
      const response = await app.inject({ method: "POST", url: `/campaigns/${campaignId}/preview-audience`,
        payload: { channelId } });
      expect(response.statusCode).toBe(200);
      expect(response.json().nameCheck).toBe("ok");
      expect(response.json().eligible[0].message).toContain("Agnaldo");
      expect(response.json().eligible[0].message).not.toContain("Teporti");
    } finally { await app.close(); }
  });
});
