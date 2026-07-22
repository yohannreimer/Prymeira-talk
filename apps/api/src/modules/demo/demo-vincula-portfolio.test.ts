import { describe, expect, it } from "vitest";
import { DEMO_VINCULA_LINKS, buildDemoVinculaSyncActions } from "./demo-vincula-portfolio.js";

describe("Demo Vincula portfolio", () => {
  it("defines the fixed Talk-to-Vincula links", () => {
    expect(Object.keys(DEMO_VINCULA_LINKS)).toHaveLength(9);
    expect(DEMO_VINCULA_LINKS).not.toHaveProperty("60000000-0000-4000-8000-000000000010");
    expect(DEMO_VINCULA_LINKS["60000000-0000-4000-8000-000000000001"]).toMatchObject({
      companyId: "9301",
      contactId: "9401",
      dealId: "9502",
      noteId: "9602",
      title: "Nova unidade Clínica Aurora"
    });
  });

  it("builds completed real sync actions for the six linked deals", () => {
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
    expect(actions.map((action) => action.result.vinculaRecordUrl).sort()).toEqual([
      "http://localhost:5174/#/deals/9501/show",
      "http://localhost:5174/#/deals/9502/show",
      "http://localhost:5174/#/deals/9503/show",
      "http://localhost:5174/#/deals/9504/show",
      "http://localhost:5174/#/deals/9505/show",
      "http://localhost:5174/#/deals/9506/show"
    ]);
  });
});
