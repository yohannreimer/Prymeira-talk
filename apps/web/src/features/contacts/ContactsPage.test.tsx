import type { ContactDto } from "@prymeira-talk/shared";
import { describe, expect, it } from "vitest";
import { updateDrawerContactAfterSave } from "./ContactsPage";

const baseContact: ContactDto = {
  id: "contact-1",
  workspaceId: "workspace-1",
  name: "Ana",
  phone: "5547999910101",
  email: "ana@example.com",
  company: "Clínica Aurora",
  atomicCrmContactId: null,
  atomicCrmLeadId: null,
  createdAt: "2026-05-21T00:00:00.000Z",
  updatedAt: "2026-05-21T00:00:00.000Z"
};

describe("updateDrawerContactAfterSave", () => {
  it("refreshes the open drawer when the saved contact is the drawer contact", () => {
    const savedContact: ContactDto = {
      ...baseContact,
      name: "Ana Beatriz",
      company: "Clínica Aurora VIP",
      updatedAt: "2026-05-21T01:00:00.000Z"
    };

    expect(updateDrawerContactAfterSave(baseContact, savedContact)).toBe(savedContact);
  });

  it("keeps another open drawer unchanged", () => {
    const otherContact: ContactDto = {
      ...baseContact,
      id: "contact-2",
      name: "João"
    };

    expect(updateDrawerContactAfterSave(otherContact, baseContact)).toBe(otherContact);
  });
});
