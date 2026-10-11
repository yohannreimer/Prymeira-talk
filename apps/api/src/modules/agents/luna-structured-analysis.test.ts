import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createLunaStructuredAnalysis } from "./luna-structured-analysis.js";

const prisma = {
  integrationConfig: {
    findUnique: vi.fn(async () => ({
      mode: "real",
      settings: { baseUrl: "https://ai.example.test/v1", apiKey: "test-key", chatModel: "test-model" }
    }))
  }
};

function analyzeWithStub() {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
    choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ ok: true }) } }]
  }), { status: 200 }));
  const analyze = createLunaStructuredAnalysis({ prisma: prisma as never, fetchImpl: fetchImpl as never });
  const sentBody = () => JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, { body: string }])[1].body);
  return { analyze, sentBody };
}

describe("luna structured analysis", () => {
  const request = { workspaceId: "w", systemPrompt: "p", data: {}, schema: z.object({ ok: z.boolean() }) };

  it("usa 2048 tokens de saída por padrão", async () => {
    const { analyze, sentBody } = analyzeWithStub();
    expect(await analyze(request)).toEqual({ ok: true });
    expect(sentBody().max_completion_tokens).toBe(2048);
  });

  it("aceita um limite de tokens de saída maior quando pedido", async () => {
    const { analyze, sentBody } = analyzeWithStub();
    await analyze({ ...request, maxCompletionTokens: 8192 });
    expect(sentBody().max_completion_tokens).toBe(8192);
  });
});
