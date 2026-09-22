import { describe, expect, it } from "vitest";
import {
  leadCampaignDraftResultSchema,
  leadJobStatusSchema,
  leadPaginatedResultSchema,
  leadWhatsappVerificationRequestSchema,
  normalizedCnpjSchema,
  realtimeEventSchema
} from "@prymeira-talk/shared";
import {
  canTransitionLeadJob,
  MAX_LEAD_WHATSAPP_BATCH_SIZE,
  normalizeCnpj
} from "./leads.types.js";

describe("Leads domain contracts", () => {
  it("normalizes alphanumeric CNPJ values as text", () => {
    expect(normalizeCnpj("12.345.678/ABCD-90")).toBe("12345678ABCD90");
    expect(normalizedCnpjSchema.parse("12.345.678/abcd-90")).toBe("12345678ABCD90");
  });

  it.each([
    "12345678ABCD9",
    "12345678ABCD9X",
    "12345678ABC$90",
    "12345678ABCD-9O",
    ""
  ])("rejects structurally invalid CNPJ values: %s", (value) => {
    expect(() => normalizeCnpj(value)).toThrow();
    expect(() => normalizedCnpjSchema.parse(value)).toThrow();
  });

  it("enforces the WhatsApp verification batch boundary", () => {
    const leadIds = Array.from({ length: MAX_LEAD_WHATSAPP_BATCH_SIZE }, (_, index) => `lead-${index}`);

    expect(
      leadWhatsappVerificationRequestSchema.parse({
        listId: "list-1",
        leadIds
      }).leadIds
    ).toHaveLength(MAX_LEAD_WHATSAPP_BATCH_SIZE);

    expect(() =>
      leadWhatsappVerificationRequestSchema.parse({
        listId: "list-1",
        leadIds: [...leadIds, "lead-overflow"]
      })
    ).toThrow();
  });

  it("accepts only valid persisted job statuses and transitions", () => {
    expect(leadJobStatusSchema.parse("queued")).toBe("queued");
    expect(leadJobStatusSchema.parse("partial")).toBe("partial");
    expect(() => leadJobStatusSchema.parse("cancelled")).toThrow();

    expect(canTransitionLeadJob("queued", "running")).toBe(true);
    expect(canTransitionLeadJob("running", "completed")).toBe(true);
    expect(canTransitionLeadJob("running", "partial")).toBe(true);
    expect(canTransitionLeadJob("failed", "queued")).toBe(true);
    expect(canTransitionLeadJob("completed", "running")).toBe(false);
    expect(canTransitionLeadJob("queued", "completed")).toBe(false);
  });

  it("parses the public result and campaign-draft contracts", () => {
    const page = leadPaginatedResultSchema.parse({
      items: [
        {
          id: "lead-1",
          workspaceId: "workspace-1",
          listId: "list-1",
          source: "receita_federal",
          companyName: "Empresa Exemplo",
          tradeName: null,
          cnpj: "12.345.678/ABCD-90",
          cnaePrimary: null,
          cnaeSecondary: [],
          category: null,
          address: null,
          city: "São Paulo",
          state: "SP",
          postalCode: null,
          phones: [],
          normalizedPhone: null,
          email: null,
          website: null,
          rating: null,
          reviewCount: null,
          latitude: null,
          longitude: null,
          sourceUrl: null,
          whatsappStatus: "unverified",
          createdAt: "2026-09-22T00:00:00.000Z",
          updatedAt: "2026-09-22T00:00:00.000Z"
        }
      ],
      page: 1,
      pageSize: 25,
      total: 1
    });

    expect(page.items[0]?.cnpj).toBe("12345678ABCD90");
    expect(
      leadCampaignDraftResultSchema.parse({
        campaignId: "campaign-1",
        status: "draft",
        contactCount: 1
      })
    ).toEqual({ campaignId: "campaign-1", status: "draft", contactCount: 1 });
  });

  it("requires lead realtime payloads to remain in the event workspace", () => {
    expect(
      realtimeEventSchema.parse({
        type: "lead_job.updated",
        workspaceId: "workspace-1",
        payload: {
          id: "job-1",
          workspaceId: "workspace-1",
          listId: "list-1",
          operation: "receita_search",
          status: "running",
          attempts: 1,
          leaseUntil: null,
          startedAt: "2026-09-22T00:00:00.000Z",
          finishedAt: null,
          errorMessage: null,
          createdAt: "2026-09-22T00:00:00.000Z",
          updatedAt: "2026-09-22T00:00:00.000Z"
        }
      }).type
    ).toBe("lead_job.updated");

    expect(() =>
      realtimeEventSchema.parse({
        type: "lead_list.updated",
        workspaceId: "workspace-1",
        payload: {
          id: "list-1",
          workspaceId: "workspace-2",
          name: "Lista",
          source: "google_maps",
          criteria: {},
          totalCount: 0,
          processedCount: 0,
          failedCount: 0,
          startedAt: null,
          completedAt: null,
          createdAt: "2026-09-22T00:00:00.000Z",
          updatedAt: "2026-09-22T00:00:00.000Z"
        }
      })
    ).toThrow();
  });
});
