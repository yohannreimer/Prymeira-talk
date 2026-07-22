export interface DemoVinculaLink {
  companyId: string;
  contactId: string;
  dealId?: string;
  noteId?: string;
  title?: string;
}

interface CompleteDemoVinculaLink extends DemoVinculaLink {
  dealId: string;
  noteId: string;
  title: string;
}

export const DEMO_VINCULA_LINKS: Readonly<Record<string, DemoVinculaLink>> = {
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
};

function isCompleteLink(link: DemoVinculaLink): link is CompleteDemoVinculaLink {
  return link.dealId !== undefined && link.noteId !== undefined && link.title !== undefined;
}

export function buildDemoVinculaSyncActions(workspaceId: string) {
  return Object.entries(DEMO_VINCULA_LINKS)
    .filter((entry): entry is [string, CompleteDemoVinculaLink] => isCompleteLink(entry[1]))
    .map(([contactId, link]) => ({
      workspaceId,
      contactId,
      actionType: "create_lead" as const,
      mode: "real" as const,
      status: "completed" as const,
      payload: {
        title: link.title,
        provider: "vincula" as const,
        contactId,
        vinculaDealId: link.dealId,
        vinculaCompanyId: link.companyId,
        vinculaContactId: link.contactId
      },
      result: {
        mode: "real" as const,
        dealCreated: true,
        dealUpdated: false,
        environment: "local-demo" as const,
        vinculaDealId: link.dealId,
        vinculaNoteId: link.noteId,
        vinculaCompanyId: link.companyId,
        vinculaContactId: link.contactId,
        vinculaRecordUrl: `http://localhost:5174/#/deals/${link.dealId}/show`
      }
    }));
}
