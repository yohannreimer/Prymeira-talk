import { describe, expect, it, vi } from "vitest";
import { createLunaFollowupEligibility } from "./luna-followup-eligibility.js";

const prisma = {
  integrationConfig: {
    findUnique: vi.fn().mockResolvedValue({
      mode: "real",
      settings: { baseUrl: "https://api.openai.com/v1", apiKey: "test-key", chatModel: "gpt-5.6-luna" }
    })
  }
};
const messages = [
  { id: "customer", direction: "inbound", label: "cliente" as const, type: "text", body: "Vocês têm essas chapas?", createdAt: "2026-09-25T11:00:00Z" },
  { id: "anchor", direction: "outbound", label: "atendente" as const, type: "text", body: "Temos as chapas de ferro e laminados nessa medida.", createdAt: "2026-09-25T11:01:00Z" }
];

function completion(decision: unknown) {
  return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(decision) } }] }));
}

describe("GPT-6 Luna follow-up eligibility", () => {
  it("reads the conversation with the pinned analysis model and accepts an implicit customer decision", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(completion({ eligibility: "schedule", reason: "customer_answer_pending" }));
    const eligibility = createLunaFollowupEligibility({ prisma, fetchImpl });
    await expect(eligibility.evaluate({ workspaceId: "workspace", kind: "human_commercial", anchorMessageId: "anchor", conversationMessages: messages }))
      .resolves.toEqual({ eligibility: "schedule", reason: "customer_answer_pending" });
    const request = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(request.model).toBe("gpt-6-luna");
    expect(request.messages[0].content).toContain("Esse passo pode ser implícito");
    expect(request.messages[0].content).toContain("despedida");
    expect(request.messages[0].content).toContain("empresa prometeu retornar");
  });

  it("vetoes seller action locally and rejects inconsistent scheduled reasons", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(completion({ eligibility: "schedule", reason: "resolved_or_unclear" }));
    const eligibility = createLunaFollowupEligibility({ prisma, fetchImpl });
    await expect(eligibility.evaluate({
      workspaceId: "workspace", kind: "human_commercial", anchorMessageId: "anchor",
      conversationMessages: [messages[0]!, { ...messages[1]!, body: "O vendedor responsável irá entrar em contato." }]
    })).resolves.toEqual({ eligibility: "skip", reason: "seller_action_pending" });
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(eligibility.evaluate({ workspaceId: "workspace", kind: "human_commercial", anchorMessageId: "anchor", conversationMessages: messages }))
      .resolves.toEqual({ eligibility: "skip", reason: "resolved_or_unclear" });
  });

  it("screens first-person seller commitments and outbound-only messages before calling Luna", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(completion({ eligibility: "schedule", reason: "customer_answer_pending" }));
    const eligibility = createLunaFollowupEligibility({ prisma, fetchImpl });
    await expect(eligibility.evaluate({
      workspaceId: "workspace", kind: "human_commercial", anchorMessageId: "anchor",
      conversationMessages: [messages[0]!, { ...messages[1]!, body: "Certo, vou deixar separado aqui." }]
    })).resolves.toEqual({ eligibility: "skip", reason: "seller_action_pending" });
    await expect(eligibility.evaluate({
      workspaceId: "workspace", kind: "human_commercial", anchorMessageId: "anchor",
      conversationMessages: [{ ...messages[1]!, body: "Precisando de algum material essa semana?" }]
    })).resolves.toEqual({ eligibility: "skip", reason: "resolved_or_unclear" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
