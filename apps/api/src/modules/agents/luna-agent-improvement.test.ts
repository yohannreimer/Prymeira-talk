import { describe, expect, it, vi } from "vitest";
import { createLunaAgentImprovementDetector } from "./luna-agent-improvement.js";

const prisma = {
  integrationConfig: {
    findUnique: vi.fn().mockResolvedValue({
      mode: "real",
      settings: { baseUrl: "https://api.openai.com/v1", apiKey: "test-key", chatModel: "gpt-5.6-luna" }
    })
  }
};

function completion(assessment: unknown) {
  return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(assessment) } }] }));
}

describe("GPT-6 Luna improvement detection", () => {
  it("turns an explicit human catalog refusal into a pending improvement proposal", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(completion({
      outcome: "suggest", kind: "not_sold", confidence: 0.94, reason: "item_confirmed_not_sold"
    }));
    const detector = createLunaAgentImprovementDetector({ prisma, fetchImpl });
    await expect(detector.assess({
      workspaceId: "workspace", customerMessage: "Vocês teriam flange em inox?",
      humanReply: "Bom dia, flange não trabalhamos. Nosso foco são as chapas de ferro e laminados.",
      conversationMessages: []
    })).resolves.toEqual({ outcome: "suggest", kind: "not_sold", confidence: 0.94, provider: "gpt-6-luna" });
    const request = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(request.model).toBe("gpt-6-luna");
    expect(request.messages[0].content).toContain("flange não trabalhamos");
  });

  it("does not turn a low-confidence observation into an improvement", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(completion({
      outcome: "suggest", kind: "policy", confidence: 0.5, reason: "unclear"
    }));
    const detector = createLunaAgentImprovementDetector({ prisma, fetchImpl });
    await expect(detector.assess({ workspaceId: "workspace", customerMessage: "Olá", humanReply: "Até mais", conversationMessages: [] }))
      .resolves.toEqual({ outcome: "ignore", reason: "unclear", provider: "gpt-6-luna" });
  });
});
