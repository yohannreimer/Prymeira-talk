import { describe, expect, it, vi } from "vitest";
import { DEMO_VINCULA_LINKS, buildDemoVinculaSyncActions } from "./demo-vincula-portfolio.js";
import {
  buildDemoVinculaSeedState,
  clearDemoAgentSessions,
  readDemoVinculaLink
} from "./demo-scenario.js";

describe("readDemoVinculaLink", () => {
  it("returns the fixed Vincula link for linked contacts and null for Carlos", () => {
    expect(readDemoVinculaLink("60000000-0000-4000-8000-000000000001")).toMatchObject({
      contactId: "9401",
      dealId: "9502"
    });
    expect(readDemoVinculaLink("60000000-0000-4000-8000-000000000010")).toBeNull();
  });
});

describe("buildDemoVinculaSeedState", () => {
  it("builds the complete real Vincula seed state", () => {
    const state = buildDemoVinculaSeedState({ workspaceId: "demo_workspace" });
    const fields = Object.entries(state.contactFieldsById);

    expect(fields.filter(([, field]) => field.atomicCrmContactId)).toEqual([
      ["60000000-0000-4000-8000-000000000001", { atomicCrmContactId: "9401", atomicCrmLeadId: "9502" }],
      ["60000000-0000-4000-8000-000000000002", { atomicCrmContactId: "9402", atomicCrmLeadId: undefined }],
      ["60000000-0000-4000-8000-000000000003", { atomicCrmContactId: "9403", atomicCrmLeadId: "9504" }],
      ["60000000-0000-4000-8000-000000000004", { atomicCrmContactId: "9404", atomicCrmLeadId: undefined }],
      ["60000000-0000-4000-8000-000000000005", { atomicCrmContactId: "9405", atomicCrmLeadId: "9503" }],
      ["60000000-0000-4000-8000-000000000006", { atomicCrmContactId: "9406", atomicCrmLeadId: "9501" }],
      ["60000000-0000-4000-8000-000000000007", { atomicCrmContactId: "9407", atomicCrmLeadId: "9505" }],
      ["60000000-0000-4000-8000-000000000008", { atomicCrmContactId: "9408", atomicCrmLeadId: "9506" }],
      ["60000000-0000-4000-8000-000000000009", { atomicCrmContactId: "9409", atomicCrmLeadId: undefined }]
    ]);
    expect(fields.filter(([, field]) => field.atomicCrmLeadId)).toHaveLength(6);
    expect(state.contactFieldsById["60000000-0000-4000-8000-000000000010"]).toEqual({
      atomicCrmContactId: undefined,
      atomicCrmLeadId: undefined
    });
    expect(state.integrationConfig).toEqual({
      workspaceId: "demo_workspace",
      provider: "vincula",
      mode: "real",
      status: "configured",
      settings: { label: "Vincula CRM local", fallbackEnabled: true }
    });
    expect(state.syncActions).toHaveLength(6);
    expect(
      state.syncActions.every((action) => {
        const link = state.linksByContactId[action.contactId];
        return action.mode === "real" && action.status === "completed" && link?.dealId === action.payload.vinculaDealId;
      })
    ).toBe(true);
  });

  it("rejects missing or extra map keys and orphan sync actions", () => {
    const seeds = Object.keys(DEMO_VINCULA_LINKS)
      .concat("60000000-0000-4000-8000-000000000010")
      .map((contactId) => ({ contactId }));
    const { "60000000-0000-4000-8000-000000000009": _removed, ...missingLinkMap } = DEMO_VINCULA_LINKS;

    expect(() =>
      buildDemoVinculaSeedState({ workspaceId: "demo_workspace", seeds, links: missingLinkMap })
    ).toThrow("missing links");
    expect(() =>
      buildDemoVinculaSeedState({
        workspaceId: "demo_workspace",
        seeds,
        links: { ...DEMO_VINCULA_LINKS, unexpected: DEMO_VINCULA_LINKS["60000000-0000-4000-8000-000000000001"] }
      })
    ).toThrow("unexpected links");
    expect(() =>
      buildDemoVinculaSeedState({
        workspaceId: "demo_workspace",
        seeds,
        buildActions: (workspaceId) => {
          const actions = buildDemoVinculaSyncActions(workspaceId);
          return [{ ...actions[0], contactId: "60000000-0000-4000-8000-000000000010" }, ...actions.slice(1)];
        }
      })
    ).toThrow("does not have a linked deal");
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
