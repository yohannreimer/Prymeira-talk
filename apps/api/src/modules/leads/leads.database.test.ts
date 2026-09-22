import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.LEADS_TEST_DATABASE_URL;

if (
  url &&
  !/^postgresql:\/\/[^@]+@127\.0\.0\.1:\d+\/leads_task2_test(?:\?|$)/.test(url)
) {
  throw new Error("Refusing a non-disposable Leads test database.");
}

describe.skipIf(!url)("Leads PostgreSQL constraints", () => {
  const db = new PrismaClient({
    datasources: { db: { url: url ?? "postgresql://invalid/unused" } }
  });
  const workspaceId = `leads-test-${randomUUID()}`;
  const foreignWorkspaceId = `leads-foreign-${randomUUID()}`;
  let contactId: string;
  let receitaListId: string;
  let googleListId: string;
  let receitaLeadId: string;

  beforeAll(async () => {
    contactId = (
      await db.contact.create({
        data: { workspaceId, phone: `55${Date.now()}${Math.floor(Math.random() * 1000)}` }
      })
    ).id;
    receitaListId = (
      await db.leadList.create({
        data: { workspaceId, name: "Receita", source: "receita_federal" }
      })
    ).id;
    googleListId = (
      await db.leadList.create({
        data: { workspaceId, name: "Google", source: "google_maps" }
      })
    ).id;
    receitaLeadId = (
      await db.lead.create({
        data: {
          workspaceId,
          listId: receitaListId,
          source: "receita_federal",
          sourceDedupeKey: `receita-${randomUUID()}`
        }
      })
    ).id;
    await db.leadContactProvenance.create({
      data: {
        workspaceId,
        contactId,
        leadId: receitaLeadId,
        listId: receitaListId,
        source: "receita_federal"
      }
    });
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it("rejects cross-workspace and contradictory source/list lineage", async () => {
    await expect(
      db.lead.create({
        data: {
          workspaceId: foreignWorkspaceId,
          listId: receitaListId,
          source: "receita_federal",
          sourceDedupeKey: `foreign-${randomUUID()}`
        }
      })
    ).rejects.toThrow();

    await expect(
      db.lead.create({
        data: {
          workspaceId,
          listId: receitaListId,
          source: "google_maps",
          sourceDedupeKey: `mismatch-${randomUUID()}`
        }
      })
    ).rejects.toThrow();

    await expect(
      db.leadContactProvenance.create({
        data: {
          workspaceId,
          contactId,
          leadId: receitaLeadId,
          listId: googleListId,
          source: "google_maps"
        }
      })
    ).rejects.toThrow();
  });

  it("retains provenance by rejecting parent deletion", async () => {
    await expect(db.contact.delete({ where: { id: contactId } })).rejects.toThrow();
    await expect(db.lead.delete({ where: { id: receitaLeadId } })).rejects.toThrow();
    await expect(db.leadList.delete({ where: { id: receitaListId } })).rejects.toThrow();
  });

  it("allows alphanumeric CNPJ identifiers and rejects invalid stored formats", async () => {
    const valid = await db.lead.create({
      data: {
        workspaceId,
        listId: receitaListId,
        source: "receita_federal",
        sourceDedupeKey: `cnpj-valid-${randomUUID()}`,
        cnpj: "12345678ABCD90"
      }
    });

    expect(valid.cnpj).toBe("12345678ABCD90");

    await expect(
      db.lead.create({
        data: {
          workspaceId,
          listId: receitaListId,
          source: "receita_federal",
          sourceDedupeKey: `cnpj-invalid-${randomUUID()}`,
          cnpj: "12345678ABCD9X"
        }
      })
    ).rejects.toThrow();
  });
});
