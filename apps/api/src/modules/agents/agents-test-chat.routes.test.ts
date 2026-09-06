import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { agentsRoutes } from "./agents.routes.js";

async function setup() {
  const app = Fastify();
  app.decorate("prisma", {
    aiAgent: { findFirst: vi.fn().mockResolvedValue({ id: "00000000-0000-4000-8000-000000000101", model: "simulated", systemPrompt: "Atenda bem." }) },
    aiKnowledgeSource: { findMany: vi.fn().mockResolvedValue([]) },
    integrationConfig: { findUnique: vi.fn().mockResolvedValue(null) }
  } as unknown as typeof app.prisma);
  app.addHook("onRequest", async (request) => { request.talk = { workspaceId: "workspace_a", role: "owner" } as typeof request.talk; });
  await app.register(agentsRoutes);
  return app;
}
const url = "/agents/00000000-0000-4000-8000-000000000101/test-chat";
describe("test chat attachment route", () => {
  it("accepts retained extracted history beyond 4k and reports an unreadable attachment safely", async () => {
    const app = await setup();
    try {
      const response = await app.inject({ method: "POST", url, payload: { messages: [{ role: "user", content: "Lista de materiais: ".repeat(300) }, { role: "user", content: "Segue o próximo arquivo" }], attachment: { fileName: "corrupt.pdf", mimeType: "application/pdf", base64Content: "YmFk" } } });
      expect(response.statusCode).toBe(200);
      expect(response.json().debug.media).toMatchObject({ status: "failed", errorCode: "INVALID_PDF" });
    } finally { await app.close(); }
  });
  it.each([
    { attachment: { fileName: "file.pdf", mimeType: "application/pdf", url: "http://127.0.0.1/private" } },
    { attachments: [{ fileName: "file.pdf", mimeType: "application/pdf", base64Content: "JVBERi0=" }] },
    { attachment: { fileName: "file.exe", mimeType: "application/octet-stream", base64Content: "YmFk" } }
  ])("rejects unsupported attachment contracts", async (extra) => {
    const app = await setup();
    try {
      const response = await app.inject({ method: "POST", url, payload: { messages: [{ role: "user", content: "Segue" }], ...extra } });
      expect(response.statusCode).toBe(400);
    } finally { await app.close(); }
  });
  it("enforces route body size before attempting to decode an oversized upload", async () => {
    const app = await setup();
    try {
      const response = await app.inject({ method: "POST", url, payload: { messages: [{ role: "user", content: "Segue" }], attachment: { fileName: "file.pdf", mimeType: "application/pdf", base64Content: "A".repeat(12 * 1024 * 1024) } } });
      expect(response.statusCode).toBe(413);
    } finally { await app.close(); }
  });
});
