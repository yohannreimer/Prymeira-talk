import { describe, expect, it, vi } from "vitest";
import type { RealtimeEvent } from "@prymeira-talk/shared";
import { createRealtimeHub } from "./realtime-hub.js";

type ConversationUpdatedEvent = Extract<RealtimeEvent, { type: "conversation.updated" }>;

function conversationUpdatedEvent(workspaceId: string): ConversationUpdatedEvent {
  return {
    type: "conversation.updated",
    workspaceId,
    payload: {
      id: "conv_1",
      workspaceId,
      channelId: "channel_1",
      contactId: "contact_1",
      status: "open",
      assignedUserId: null,
      departmentId: null,
      lastMessageAt: null,
      lastMessagePreview: null,
      unreadCount: 0,
      priority: "normal"
    }
  };
}

describe("realtime hub", () => {
  it("publishes only to clients in the event workspace", () => {
    const hub = createRealtimeHub();
    const workspaceAClient = { send: vi.fn(), readyState: 1 };
    const workspaceBClient = { send: vi.fn(), readyState: 1 };

    hub.addClient("workspace_a", workspaceAClient);
    hub.addClient("workspace_b", workspaceBClient);
    hub.publish(conversationUpdatedEvent("workspace_a"));

    expect(workspaceAClient.send).toHaveBeenCalledTimes(1);
    expect(workspaceBClient.send).not.toHaveBeenCalled();
  });

  it("rejects events whose payload workspace does not match the envelope", () => {
    const hub = createRealtimeHub();
    const client = { send: vi.fn(), readyState: 1 };

    hub.addClient("workspace_a", client);

    expect(() =>
      hub.publish({
        ...conversationUpdatedEvent("workspace_a"),
        payload: {
          ...conversationUpdatedEvent("workspace_a").payload,
          workspaceId: "workspace_b"
        }
      })
    ).toThrow("Payload workspaceId must match event workspaceId");
    expect(client.send).not.toHaveBeenCalled();
  });

  it("removes non-open clients during publish", () => {
    const hub = createRealtimeHub();
    const openClient = { send: vi.fn(), readyState: 1 };
    const closedClient = { send: vi.fn(), readyState: 3 };

    hub.addClient("workspace_a", openClient);
    hub.addClient("workspace_a", closedClient);
    hub.publish(conversationUpdatedEvent("workspace_a"));

    expect(openClient.send).toHaveBeenCalledTimes(1);
    expect(closedClient.send).not.toHaveBeenCalled();
    expect(hub.clientCount("workspace_a")).toBe(1);
  });

  it("removes clients whose send fails and continues publishing", () => {
    const hub = createRealtimeHub();
    const failingClient = {
      send: vi.fn(() => {
        throw new Error("send failed");
      }),
      readyState: 1
    };
    const healthyClient = { send: vi.fn(), readyState: 1 };

    hub.addClient("workspace_a", failingClient);
    hub.addClient("workspace_a", healthyClient);

    expect(() => hub.publish(conversationUpdatedEvent("workspace_a"))).not.toThrow();
    expect(failingClient.send).toHaveBeenCalledTimes(1);
    expect(healthyClient.send).toHaveBeenCalledTimes(1);
    expect(hub.clientCount("workspace_a")).toBe(1);
  });

  it("ignores stale cleanup callbacks after a workspace receives a new client set", () => {
    const hub = createRealtimeHub();
    const closedClient = { send: vi.fn(), readyState: 3 };
    const openClient = { send: vi.fn(), readyState: 1 };

    const cleanupClosedClient = hub.addClient("workspace_a", closedClient);
    hub.publish(conversationUpdatedEvent("workspace_a"));

    expect(hub.clientCount("workspace_a")).toBe(0);

    hub.addClient("workspace_a", openClient);
    cleanupClosedClient();

    expect(hub.clientCount("workspace_a")).toBe(1);

    hub.publish(conversationUpdatedEvent("workspace_a"));

    expect(openClient.send).toHaveBeenCalledTimes(1);
  });
});
