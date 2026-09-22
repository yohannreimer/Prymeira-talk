import { describe, expect, it, vi } from "vitest";
import { realtimeEventSchema } from "@prymeira-talk/shared";
import {
  createConversationFollowupRealtimePublisher,
  toConversationFollowupDto
} from "./conversation-followup-events.js";

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
      conversation: {
        contact: { name: "Ana Souza", phone: "+5547999991010", customFields: { secret: "never expose" } },
        channel: { displayName: "Villefer Geral", encryptedConfig: { token: "never expose" } }
      },
      anchorMessage: {
        id: "00000000-0000-4000-8000-000000000706",
        body: "Vou avaliar a proposta.",
        type: "text",
        createdAt: new Date("2026-09-21T09:55:00.000Z"),
        metadata: { raw: "never expose" },
        mediaUrl: "https://secret.invalid/file"
      },
      decision: { purpose: "proposal_checkin", prompt: "never expose", providerTrace: "never expose" },
      providerLog: { authorization: "never expose" }
    });

    const event = publish.mock.calls[0]?.[0];
    expect(realtimeEventSchema.parse(event)).toEqual(event);
    expect(event).toEqual(expect.objectContaining({
      type: "conversation_followup.updated",
      workspaceId: "persisted_workspace",
      payload: expect.objectContaining({
        status: "review",
        draftBody: "Podemos continuar?",
        contact: { name: "Ana Souza", phone: "+5547999991010" },
        channel: { displayName: "Villefer Geral" },
        anchorMessage: {
          id: "00000000-0000-4000-8000-000000000706",
          body: "Vou avaliar a proposta.",
          type: "text",
          createdAt: "2026-09-21T09:55:00.000Z"
        },
        purpose: "proposal_checkin",
        reasonCode: null
      })
    }));
    expect(JSON.stringify(event)).not.toContain("never expose");
    expect(JSON.stringify(event)).not.toContain("private_provider_reason");
    expect(JSON.stringify(event)).not.toContain("secret.invalid");
    expect(event.payload).not.toHaveProperty("decision");
    expect(event.payload).not.toHaveProperty("providerLog");
    expect(event.payload.anchorMessage).not.toHaveProperty("metadata");
    expect(event.payload.anchorMessage).not.toHaveProperty("mediaUrl");
  });

  it("uses nullable relation fallbacks and allowlists purpose and active reason codes", () => {
    const common = {
      id: "00000000-0000-4000-8000-000000000701",
      workspaceId: "persisted_workspace",
      conversationId: "00000000-0000-4000-8000-000000000704",
      agentId: "00000000-0000-4000-8000-000000000703",
      kind: "qualification" as const,
      status: "review",
      stepIndex: 1,
      scheduledAt: new Date("2026-09-22T12:00:00.000Z"),
      draftBody: "Podemos continuar?",
      createdAt: new Date("2026-09-21T10:00:00.000Z"),
      updatedAt: new Date("2026-09-21T12:00:00.000Z")
    };

    expect(toConversationFollowupDto({
      ...common,
      reason: "jev_human_review",
      decision: { purpose: "missing_qualification", prompt: "private" }
    })).toEqual(expect.objectContaining({
      contact: { name: null, phone: null },
      channel: { displayName: null },
      anchorMessage: { id: null, body: null, type: null, createdAt: null },
      purpose: "missing_qualification",
      reasonCode: "jev_human_review"
    }));

    expect(toConversationFollowupDto({
      ...common,
      reason: "provider_failed: raw provider response",
      decision: { purpose: "inject_private_data", prompt: "private" }
    })).toEqual(expect.objectContaining({ purpose: null, reasonCode: null }));
  });

  it.each([
    ["followup_agent_unavailable", "agent_unavailable"],
    ["followup_conversation_unavailable", "context_unavailable"],
    ["provider_handoff_required", "handoff_required"],
    ["provider_reply_missing", "provider_reply_missing"],
    ["audit_commercial_policy_risk: raw provider detail", "audit_blocked"]
  ])("categorizes active reason %s without exposing its raw detail", (reason, reasonCode) => {
    const dto = toConversationFollowupDto({
      id: "00000000-0000-4000-8000-000000000701",
      workspaceId: "persisted_workspace",
      conversationId: "00000000-0000-4000-8000-000000000704",
      agentId: "00000000-0000-4000-8000-000000000703",
      kind: "qualification",
      status: "review",
      stepIndex: 1,
      scheduledAt: new Date("2026-09-22T12:00:00.000Z"),
      draftBody: null,
      reason,
      createdAt: new Date("2026-09-21T10:00:00.000Z"),
      updatedAt: new Date("2026-09-21T12:00:00.000Z")
    });

    expect(dto.reasonCode).toBe(reasonCode);
    expect(JSON.stringify(dto)).not.toContain("raw provider detail");
    expect(JSON.stringify(dto)).not.toContain("commercial_policy_risk");
  });
});
