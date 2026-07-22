import { describe, expect, it, vi } from "vitest";
import { clearDemoAgentSessions, readDemoVinculaLink } from "./demo-scenario.js";

describe("readDemoVinculaLink", () => {
  it("returns the fixed Vincula link for linked contacts and null for Carlos", () => {
    expect(readDemoVinculaLink("60000000-0000-4000-8000-000000000001")).toMatchObject({
      contactId: "9401",
      dealId: "9502"
    });
    expect(readDemoVinculaLink("60000000-0000-4000-8000-000000000010")).toBeNull();
  });
});

describe("clearDemoAgentSessions", () => {
  it("releases the active conversation relation before deleting sessions", async () => {
    const calls: string[] = [];
    const prisma = {
      conversation: {
        updateMany: vi.fn().mockImplementation(async () => {
          calls.push("release-conversations");
          return { count: 1 };
        })
      },
      aiAgentSession: {
        deleteMany: vi.fn().mockImplementation(async () => {
          calls.push("delete-sessions");
          return { count: 1 };
        })
      }
    };

    await clearDemoAgentSessions(prisma, "demo_workspace");

    expect(calls).toEqual(["release-conversations", "delete-sessions"]);
    expect(prisma.conversation.updateMany).toHaveBeenCalledWith({
      where: { workspaceId: "demo_workspace", activeAgentSessionId: { not: null } },
      data: { activeAgentSessionId: null }
    });
  });
});
