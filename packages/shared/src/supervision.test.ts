import { describe, expect, it } from "vitest";
import { needsHumanAttention } from "./supervision.js";

describe("persistent seller next action", () => {
  it("starts with a handoff and remains pending after a seller or supervisor opens it", () => {
    expect(needsHumanAttention({ activeAgentSessionStatus: "active", aiControlStatus: "agent_allowed" })).toBe(false);
    expect(needsHumanAttention({ activeAgentSessionStatus: "handoff_requested" })).toBe(true);
    expect(needsHumanAttention({ activeAgentSessionStatus: "paused_by_human", aiControlStatus: "human_controlled", handoffReason: "Revisar cotação" })).toBe(true);
  });
  it("stops on completion or closure and does not derive pendencies from AI replies or follow-ups", () => {
    expect(needsHumanAttention({ activeAgentSessionStatus: "handoff_requested", handoffActionCompletedAt: "2026-09-29T12:00:00Z" })).toBe(false);
    expect(needsHumanAttention({ activeAgentSessionStatus: "handoff_requested", status: "closed" })).toBe(false);
    expect(needsHumanAttention({ activeAgentSessionStatus: "active", aiControlStatus: "agent_allowed", handoffReason: null })).toBe(false);
  });
});
