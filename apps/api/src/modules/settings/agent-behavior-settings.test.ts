import { describe, expect, it } from "vitest";
import {
  readAgentBehaviorSettings,
  writeAgentBehaviorSettings
} from "./agent-behavior-settings.js";

describe("agent behavior settings", () => {
  it("uses 40 seconds when no setting exists", () => {
    expect(readAgentBehaviorSettings({})).toEqual({ agentReplyWaitSeconds: 40 });
  });

  it("reads a valid saved quiet window", () => {
    expect(readAgentBehaviorSettings({ agentBehavior: { replyWaitSeconds: 10 } }))
      .toEqual({ agentReplyWaitSeconds: 10 });
  });

  it.each([-1, 301, 10.5, "10", Number.NaN])(
    "falls back for malformed value %s",
    (replyWaitSeconds) => {
      expect(readAgentBehaviorSettings({ agentBehavior: { replyWaitSeconds } }))
        .toEqual({ agentReplyWaitSeconds: 40 });
    }
  );

  it("preserves unrelated root and agent behavior keys", () => {
    expect(writeAgentBehaviorSettings(
      { campaignLimit: 500, agentBehavior: { existing: true } },
      { agentReplyWaitSeconds: 0 }
    )).toEqual({
      campaignLimit: 500,
      agentBehavior: { existing: true, replyWaitSeconds: 0 }
    });
  });
});
