import { describe, expect, it, vi } from "vitest";
import { createRealtimeHub } from "./realtime-hub.js";

describe("realtime hub", () => {
  it("publishes only to clients in the event workspace", () => {
    const hub = createRealtimeHub();
    const workspaceAClient = { send: vi.fn(), readyState: 1 };
    const workspaceBClient = { send: vi.fn(), readyState: 1 };

    hub.addClient("workspace_a", workspaceAClient);
    hub.addClient("workspace_b", workspaceBClient);
    hub.publish({
      type: "conversation.updated",
      workspaceId: "workspace_a",
      payload: {
        id: "conv_1",
        workspaceId: "workspace_a",
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
    });

    expect(workspaceAClient.send).toHaveBeenCalledTimes(1);
    expect(workspaceBClient.send).not.toHaveBeenCalled();
  });
});
