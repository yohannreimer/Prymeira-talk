import { describe, expect, it, vi } from "vitest";
import { createFollowupBrain, FOLLOWUP_BRAIN_MESSAGE_WINDOW } from "./followup-brain.js";

const prisma = {
  integrationConfig: {
    findUnique: vi.fn().mockResolvedValue({
      mode: "real",
      settings: { baseUrl: "https://api.openai.com/v1", apiKey: "test-key", chatModel: "gpt-6-luna" }
    })
  }
};

function completion(analysis: unknown) {
  return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(analysis) } }] }));
}

function message(index: number, label: "cliente" | "atendente" | "nota interna", body: string) {
  return {
    id: `m${index}`,
    direction: label === "cliente" ? "inbound" : "outbound",
    label,
    type: "text",
    body,
    createdAt: new Date(Date.UTC(2026, 9, 10, 12, index)).toISOString()
  };
}

const waitingCustomer = {
  situation: "waiting_customer",
  pendingItem: "Cliente ia confirmar a quantidade com o sócio",
  kind: "customer_will_return",
  nextStep: "Perguntar se já conseguiu falar com o sócio",
  timingNote: null,
  suggestedMessage: "Oi João, conseguiu ver com seu sócio a quantidade das chapas 3mm?",
  risk: "none",
  confidence: 0.82,
  rationale: "Cliente disse \"vou ver com meu sócio e te aviso\" depois da proposta."
};

describe("follow-up brain", () => {
  it("sends the last 25 customer and company messages and prior attempts to GPT-6 Luna", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(completion(waitingCustomer));
    const messages = [
      ...Array.from({ length: 30 }, (_, index) => message(index, index % 2 ? "atendente" : "cliente", `mensagem ${index}`)),
      message(31, "nota interna", "nota que não vai para a IA")
    ];

    const analysis = await createFollowupBrain({ prisma, fetchImpl }).analyze({
      workspaceId: "workspace",
      conversationMessages: messages,
      previousAttempts: [{ body: "Oi, conseguiu ver a proposta?", sentAt: "2026-10-09T12:00:00.000Z" }],
      agentRules: "Somos a Villefer.",
      now: new Date("2026-10-10T15:00:00.000Z")
    });

    expect(analysis).toEqual(waitingCustomer);
    const request = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(request.model).toBe("gpt-6-luna");
    expect(request.messages[0].content).toContain("\"Ok\" sozinho NÃO encerra");
    const data = JSON.parse(request.messages[1].content);
    expect(data.messages).toHaveLength(FOLLOWUP_BRAIN_MESSAGE_WINDOW);
    expect(data.messages.at(-1)).toMatchObject({ from: "empresa", body: "mensagem 29" });
    expect(data.messages.some((entry: { body: string }) => entry.body.includes("nota"))).toBe(false);
    expect(data.previousFollowups).toEqual([{ sentAt: "2026-10-09T12:00:00.000Z", body: "Oi, conseguiu ver a proposta?" }]);
  });

  it("drops any message the model drafted for a closed conversation", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(completion({
      ...waitingCustomer,
      situation: "closed",
      risk: "commercial",
      rationale: "Cliente confirmou o pedido e o pagamento."
    }));

    const analysis = await createFollowupBrain({ prisma, fetchImpl }).analyze({
      workspaceId: "workspace",
      conversationMessages: [message(1, "cliente", "Fechado, pode faturar.")],
      previousAttempts: [],
      now: new Date("2026-10-10T15:00:00.000Z")
    });

    expect(analysis).toMatchObject({ situation: "closed", pendingItem: null, kind: null, suggestedMessage: null, risk: "none" });
  });

  it("rejects an answer outside the expected shape", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(completion({ situation: "maybe" }));

    await expect(createFollowupBrain({ prisma, fetchImpl }).analyze({
      workspaceId: "workspace",
      conversationMessages: [message(1, "cliente", "ok")],
      previousAttempts: [],
      now: new Date()
    })).rejects.toThrow("LUNA_ANALYSIS_RESPONSE_INVALID");
  });
});
