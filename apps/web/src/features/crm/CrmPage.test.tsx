import { describe, expect, it } from "vitest";
import { crmContactOptionLabel, crmLeadTitle, readCrmContactId } from "./CrmPage";
import { buildModuleSearch } from "../shell/TalkSuiteShell";

const contact = {
  id: "60000000-0000-4000-8000-000000000010",
  workspaceId: "demo_workspace",
  name: "Carlos Mendes",
  phone: "5547999101010",
  email: "carlos@construtorahorizonte.com.br",
  company: "Construtora Horizonte",
  avatarUrl: null,
  customFields: {},
  atomicCrmContactId: null,
  atomicCrmLeadId: null,
  createdAt: "2026-07-22T10:00:00.000Z",
  updatedAt: "2026-07-22T10:00:00.000Z"
};

describe("CRM contact context helpers", () => {
  it("reads the contact selected by Atendimento", () => {
    expect(
      readCrmContactId("?module=atomic_crm&contact=60000000-0000-4000-8000-000000000010")
    ).toBe(contact.id);
  });

  it("formats a useful contact option", () => {
    expect(crmContactOptionLabel(contact)).toBe(
      "Carlos Mendes · Construtora Horizonte · +55 47 99910-1010"
    );
  });

  it("builds an opportunity title from company context", () => {
    expect(crmLeadTitle(contact)).toBe("Orçamento — Construtora Horizonte");
  });

  it("keeps contact context only while Vincula is active", () => {
    const current = `?module=atomic_crm&contact=${contact.id}&conversation=conversation_10`;
    expect(buildModuleSearch(current, "atomic_crm")).toContain(`contact=${contact.id}`);
    expect(buildModuleSearch(current, "atendimento")).toBe("?module=atendimento");
  });
});
