import { describe, expect, it } from "vitest";
import { DEMO_VINCULA_LINKS, buildDemoVinculaSyncActions } from "./demo-vincula-portfolio.js";

describe("Demo Vincula portfolio", () => {
  it("defines the fixed Talk-to-Vincula links and completed real sync history", () => {
    expect(Object.keys(DEMO_VINCULA_LINKS)).toHaveLength(9);
    expect(DEMO_VINCULA_LINKS).not.toHaveProperty("60000000-0000-4000-8000-000000000010");
    expect(DEMO_VINCULA_LINKS["60000000-0000-4000-8000-000000000001"]).toMatchObject({
      companyId: 9301,
      contactId: 9401,
      dealId: 9502,
      noteId: 9602
    });

    const actions = buildDemoVinculaSyncActions("demo_workspace");

    expect(actions).toHaveLength(6);
    expect(actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workspaceId: "demo_workspace",
          contactId: "60000000-0000-4000-8000-000000000001",
          actionType: "create_lead",
          mode: "real",
          status: "completed"
        })
      ])
    );
    expect(actions.every((action) => action.mode === "real" && action.status === "completed")).toBe(true);
    expect(actions.every((action) => action.result.vinculaRecordUrl.includes("/#/deals/"))).toBe(true);
  });
});
