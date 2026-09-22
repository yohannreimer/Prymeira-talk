import { describe, expect, it, vi } from "vitest";
import {
  createJevFollowupDecision,
  JevFollowupDecisionUnavailableError,
  type JevFollowupDecisionInput
} from "./jev-followup-decision.js";

const baseInput: JevFollowupDecisionInput = {
  conversationMessages: [
    {
      id: "message_proposal",
      label: "atendente",
      body: "Enviei a proposta para as chapas solicitadas.",
      type: "text",
      createdAt: "2026-09-21T12:00:00.000Z"
    },
    {
      id: "message_customer",
      label: "cliente",
      body: "Vou analisar e retorno.",
      type: "text",
      createdAt: "2026-09-21T12:01:00.000Z"
    }
  ],
  selectedKnowledge: [
    {
      title: "Cadência aprovada",
      content: "O primeiro contato confirma o recebimento e investiga um bloqueio concreto."
    }
  ],
  followupKind: "qualification",
  step: 1,
  instruction: "Confirme somente dados técnicos que ainda estejam pendentes.",
  aiControlStatus: "agent_allowed",
  hasCompatibleActiveAgentSession: true
};

function choice(value: string) {
  return {
    type: "choice",
    choice: value,
    probabilities: { [value]: 1 },
    confidence: 1
  };
}

function decisionResponse(overrides: Record<string, string> = {}) {
  return new Response(JSON.stringify({
    model: "jev-1.13.0",
    answers: {
      outcome: choice(overrides.outcome ?? "follow_up"),
      purpose: choice(overrides.purpose ?? "missing_qualification"),
      route: choice(overrides.route ?? "human_review"),
      conversationStage: choice(overrides.conversationStage ?? "qualification"),
      risk: choice(overrides.risk ?? "none")
    }
  }));
}

describe("createJevFollowupDecision", () => {
  it("uses bounded history and approved knowledge, without forwarding a system prompt", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(decisionResponse());
    const decision = createJevFollowupDecision({ apiKey: "jev-test", model: "jev-1.13", fetchImpl });
    const inputWithSystemPrompt = {
      ...baseInput,
      systemPrompt: "TOP SECRET FULL AGENT SYSTEM PROMPT"
    };

    await expect(decision.decide(inputWithSystemPrompt)).resolves.toEqual({
      outcome: "follow_up",
      purpose: "missing_qualification",
      route: "human_review",
      conversationStage: "qualification",
      risk: "none"
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.typesafe.ai/v1/systemone",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer jev-test",
          "Content-Type": "application/json"
        },
        signal: expect.any(AbortSignal)
      })
    );
    const [, init] = fetchImpl.mock.calls[0] ?? [];
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe("jev-1.13");
    expect(body.state.conversationMessages).toEqual(baseInput.conversationMessages);
    expect(body.state.approvedKnowledge).toEqual(baseInput.selectedKnowledge);
    expect(body.state).not.toHaveProperty("systemPrompt");
    expect(JSON.stringify(body)).not.toContain("TOP SECRET FULL AGENT SYSTEM PROMPT");
    expect(body.questions).toEqual(expect.objectContaining({
      outcome: expect.any(Object),
      purpose: expect.any(Object),
      route: expect.any(Object),
      conversationStage: expect.any(Object),
      risk: expect.any(Object)
    }));
  });

  it("allows automatic send only for an active agent-controlled qualification follow-up with no risk", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      decisionResponse({ route: "automatic_send" })
    );
    const decision = createJevFollowupDecision({ apiKey: "jev-test", fetchImpl });

    await expect(decision.decide(baseInput)).resolves.toEqual({
      outcome: "follow_up",
      purpose: "missing_qualification",
      route: "automatic_send",
      conversationStage: "qualification",
      risk: "none"
    });
  });

  it("requires a compatible active agent session before preserving an automatic route", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      decisionResponse({ route: "automatic_send" })
    );
    const decision = createJevFollowupDecision({ apiKey: "jev-test", fetchImpl });

    await expect(decision.decide({
      ...baseInput,
      hasCompatibleActiveAgentSession: false
    })).resolves.toMatchObject({
      outcome: "follow_up",
      route: "human_review"
    });
  });

  it("downshifts unsupported commercial follow-ups to human review", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(decisionResponse({
      purpose: "proposal_checkin",
      route: "automatic_send",
      conversationStage: "post_proposal",
      risk: "commercial"
    }));
    const decision = createJevFollowupDecision({ apiKey: "jev-test", fetchImpl });

    await expect(decision.decide({
      ...baseInput,
      followupKind: "human_commercial"
    })).resolves.toEqual({
      outcome: "follow_up",
      purpose: "proposal_checkin",
      route: "human_review",
      conversationStage: "post_proposal",
      risk: "commercial"
    });
  });

  it("cancels a follow-up when the customer resolved the conversation and the stage is closed", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(decisionResponse({
      route: "automatic_send",
      conversationStage: "closure"
    }));
    const decision = createJevFollowupDecision({ apiKey: "jev-test", fetchImpl });

    await expect(decision.decide({
      ...baseInput,
      conversationMessages: [
        ...baseInput.conversationMessages,
        {
          id: "message_resolved",
          label: "cliente",
          body: "Já resolvi por aqui, obrigado.",
          type: "text",
          createdAt: "2026-09-21T12:02:00.000Z"
        }
      ]
    })).resolves.toEqual({
      outcome: "skip",
      purpose: "none",
      route: "cancel",
      conversationStage: "closure",
      risk: "none"
    });
  });

  it("downshifts human-controlled and post-proposal suggestions to human review", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(decisionResponse({
      purpose: "proposal_checkin",
      route: "automatic_send",
      conversationStage: "post_proposal"
    }));
    const decision = createJevFollowupDecision({ apiKey: "jev-test", fetchImpl });

    await expect(decision.decide({
      ...baseInput,
      followupKind: "human_commercial",
      aiControlStatus: "human_controlled"
    })).resolves.toEqual({
      outcome: "follow_up",
      purpose: "proposal_checkin",
      route: "human_review",
      conversationStage: "post_proposal",
      risk: "none"
    });
  });

  it("rejects malformed SystemOne responses as unavailable", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ answers: { outcome: choice("follow_up") } }))
    );
    const decision = createJevFollowupDecision({ apiKey: "jev-test", fetchImpl });

    const error = await decision.decide(baseInput).catch((reason: unknown) => reason);
    expect(error).toMatchObject({
      name: "JevFollowupDecisionUnavailableError",
      code: "JEV_FOLLOWUP_DECISION_RESPONSE_INVALID"
    });
    expect(error).toBeInstanceOf(JevFollowupDecisionUnavailableError);
  });

  it("rejects transport errors as unavailable and never supplies an automatic decision", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("network down"));
    const decision = createJevFollowupDecision({ apiKey: "jev-test", fetchImpl });

    await expect(decision.decide(baseInput)).rejects.toMatchObject({
      name: "JevFollowupDecisionUnavailableError",
      code: "JEV_FOLLOWUP_DECISION_TRANSPORT"
    });
  });

  it("classifies an aborted SystemOne request as a timeout", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(
      new DOMException("request timed out", "TimeoutError")
    );
    const decision = createJevFollowupDecision({ apiKey: "jev-test", fetchImpl });

    await expect(decision.decide(baseInput)).rejects.toMatchObject({
      name: "JevFollowupDecisionUnavailableError",
      code: "JEV_FOLLOWUP_DECISION_TIMEOUT"
    });
  });
});
