import { describe, expect, it, vi } from "vitest";
import { createJevFollowupEligibility } from "./jev-followup-eligibility.js";

const anchorMessageId = "anchor_1";
const conversationMessages = [
  { id: "customer_1", direction: "inbound", label: "cliente" as const, type: "text", body: "Preciso de chapas.", createdAt: "2026-09-25T11:00:00Z" },
  { id: anchorMessageId, direction: "outbound", label: "atendente" as const, type: "text", body: "Bom dia, vendedor responsável irá entrar em contato.", createdAt: "2026-09-25T11:01:00Z" }
];

function response(eligibility: string, reason: string) {
  return new Response(JSON.stringify({ answers: {
    eligibility: { type: "choice", choice: eligibility },
    reason: { type: "choice", choice: reason }
  } }));
}

describe("JEV follow-up eligibility", () => {
  it("screens promised seller action before it becomes a scheduled follow-up", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response("schedule", "seller_action_pending"));
    const eligibility = createJevFollowupEligibility({ apiKey: "test", fetchImpl });

    await expect(eligibility.evaluate({ workspaceId: "workspace_1", kind: "human_commercial", anchorMessageId, conversationMessages }))
      .resolves.toEqual({ eligibility: "skip", reason: "seller_action_pending" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("requires an explicit customer pendency in the classification instructions", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response("skip", "resolved_or_unclear"));
    const eligibility = createJevFollowupEligibility({ apiKey: "test", fetchImpl });
    const messages = [
      conversationMessages[0]!,
      { ...conversationMessages[1]!, body: "Vamos continuar esta conversa em breve." }
    ];
    await eligibility.evaluate({ workspaceId: "workspace_1", kind: "human_commercial", anchorMessageId, conversationMessages: messages });
    const request = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(request.state.anchorMessageId).toBe(anchorMessageId);
    expect(request.questions.eligibility.instructions).toContain("vendedor/empresa entrará em contato");
    expect(request.questions.eligibility.instructions).toContain("uma explicação que o cliente precisa avaliar");
  });

  it("accepts a confirmed proposal awaiting the customer's decision", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response("schedule", "proposal_response_pending"));
    const eligibility = createJevFollowupEligibility({ apiKey: "test", fetchImpl });

    const messages = [conversationMessages[0]!, { ...conversationMessages[1]!, body: "Enviei a proposta. Você conseguiu avaliar?" }];
    await expect(eligibility.evaluate({ workspaceId: "workspace_1", kind: "human_commercial", anchorMessageId, conversationMessages: messages }))
      .resolves.toEqual({ eligibility: "schedule", reason: "proposal_response_pending" });
  });

  it("requires a visible anchor and rejects proposal classification for agent qualification", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response("schedule", "proposal_response_pending"));
    const eligibility = createJevFollowupEligibility({ apiKey: "test", fetchImpl });

    await expect(eligibility.evaluate({ workspaceId: "workspace_1", kind: "qualification", anchorMessageId: "missing", conversationMessages }))
      .resolves.toEqual({ eligibility: "skip", reason: "resolved_or_unclear" });
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(eligibility.evaluate({ workspaceId: "workspace_1", kind: "qualification", anchorMessageId, conversationMessages }))
      .resolves.toEqual({ eligibility: "skip", reason: "proposal_response_pending" });
  });
});
