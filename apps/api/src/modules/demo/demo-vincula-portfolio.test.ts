import { describe, expect, it } from "vitest";
import { DEMO_VINCULA_LINKS, buildDemoVinculaSyncActions } from "./demo-vincula-portfolio.js";

describe("Demo Vincula portfolio", () => {
  it("defines the fixed Talk-to-Vincula links", () => {
    expect(DEMO_VINCULA_LINKS).toEqual({
      "60000000-0000-4000-8000-000000000001": {
        companyId: "9301",
        contactId: "9401",
        dealId: "9502",
        noteId: "9602",
        title: "Nova unidade Clínica Aurora"
      },
      "60000000-0000-4000-8000-000000000002": { companyId: "9302", contactId: "9402" },
      "60000000-0000-4000-8000-000000000003": {
        companyId: "9303",
        contactId: "9403",
        dealId: "9504",
        noteId: "9604",
        title: "Contrato recorrente Studio Rocha"
      },
      "60000000-0000-4000-8000-000000000004": { companyId: "9304", contactId: "9404" },
      "60000000-0000-4000-8000-000000000005": {
        companyId: "9305",
        contactId: "9405",
        dealId: "9503",
        noteId: "9603",
        title: "Renovação Gomes Moda"
      },
      "60000000-0000-4000-8000-000000000006": {
        companyId: "9306",
        contactId: "9406",
        dealId: "9501",
        noteId: "9601",
        title: "Fornecimento regional Souza"
      },
      "60000000-0000-4000-8000-000000000007": {
        companyId: "9307",
        contactId: "9407",
        dealId: "9505",
        noteId: "9605",
        title: "Fornecimento Vieira Engenharia"
      },
      "60000000-0000-4000-8000-000000000008": {
        companyId: "9308",
        contactId: "9408",
        dealId: "9506",
        noteId: "9606",
        title: "Projeto Tavares Obras"
      },
      "60000000-0000-4000-8000-000000000009": { companyId: "9309", contactId: "9409" }
    });
  });

  it("builds completed real sync actions for the six linked deals", () => {
    const actions = buildDemoVinculaSyncActions("demo_workspace");

    expect(actions).toHaveLength(6);
    expect(actions).toEqual([
      expectedAction("60000000-0000-4000-8000-000000000001", "Nova unidade Clínica Aurora", "9301", "9401", "9502", "9602"),
      expectedAction("60000000-0000-4000-8000-000000000003", "Contrato recorrente Studio Rocha", "9303", "9403", "9504", "9604"),
      expectedAction("60000000-0000-4000-8000-000000000005", "Renovação Gomes Moda", "9305", "9405", "9503", "9603"),
      expectedAction("60000000-0000-4000-8000-000000000006", "Fornecimento regional Souza", "9306", "9406", "9501", "9601"),
      expectedAction("60000000-0000-4000-8000-000000000007", "Fornecimento Vieira Engenharia", "9307", "9407", "9505", "9605"),
      expectedAction("60000000-0000-4000-8000-000000000008", "Projeto Tavares Obras", "9308", "9408", "9506", "9606")
    ]);
  });
});

function expectedAction(
  contactId: string,
  title: string,
  vinculaCompanyId: string,
  vinculaContactId: string,
  vinculaDealId: string,
  vinculaNoteId: string
) {
  return {
    workspaceId: "demo_workspace",
    contactId,
    actionType: "create_lead",
    mode: "real",
    status: "completed",
    payload: {
      title,
      provider: "vincula",
      contactId,
      vinculaDealId,
      vinculaCompanyId,
      vinculaContactId
    },
    result: {
      mode: "real",
      dealCreated: true,
      dealUpdated: false,
      environment: "local-demo",
      vinculaDealId,
      vinculaNoteId,
      vinculaCompanyId,
      vinculaContactId,
      vinculaRecordUrl: `http://localhost:5174/#/deals/${vinculaDealId}/show`
    }
  };
}
