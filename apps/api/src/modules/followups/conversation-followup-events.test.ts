import { describe, expect, it, vi } from "vitest";
import { realtimeEventSchema } from "@prymeira-talk/shared";
import { createConversationFollowupRealtimePublisher } from "./conversation-followup-events.js";

describe("conversation follow-up realtime events", () => {
  it("derives the workspace from the persisted record and strips private decision/provider data", async () => {
    const publish = vi.fn();
    const publisher = createConversationFollowupRealtimePublisher({ publish });

    await publisher.publishUpdated({
      id: "00000000-0000-4000-8000-000000000701",
      workspaceId: "persisted_workspace",
      conversationId: "00000000-0000-4000-8000-000000000704",
      agentId: "00000000-0000-4000-8000-000000000703",
      kind: "human_commercial",
      status: "review",
      activeKey: "active",
      stepIndex: 1,
      scheduledAt: new Date("2026-09-22T12:00:00.000Z"),
      lockedAt: null,
      draftBody: "Podemos continuar?",
      finalBody: null,
      reason: "private_provider_reason",
      sentByUserId: null,
      sentAt: null,
      cancelledByUserId: null,
      cancelledAt: null,
      createdAt: new Date("2026-09-21T10:00:00.000Z"),
      updatedAt: new Date("2026-09-21T12:00:00.000Z"),
      decision: { prompt: "never expose" },
      providerLog: { authorization: "never expose" }
    });

    const event = publish.mock.calls[0]?.[0];
    expect(realtimeEventSchema.parse(event)).toEqual(event);
    expect(event).toEqual(expect.objectContaining({
      type: "conversation_followup.updated",
      workspaceId: "persisted_workspace",
      payload: expect.objectContaining({ status: "review", draftBody: "Podemos continuar?" })
    }));
    expect(JSON.stringify(event)).not.toContain("never expose");
    expect(JSON.stringify(event)).not.toContain("private_provider_reason");
  });
});
