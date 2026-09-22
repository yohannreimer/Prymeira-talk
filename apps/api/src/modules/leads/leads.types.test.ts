import { describe, expect, it } from "vitest";
import {
  leadCampaignDraftResultSchema,
  leadJobIdempotencyScopeSchema,
  leadJobStatusSchema,
  leadPaginatedResultSchema,
  similarCompanySearchResultSchema,
  leadWhatsappVerificationRequestSchema,
  normalizedCnpjSchema,
  realtimeEventSchema
} from "@prymeira-talk/shared";
import {
  canTransitionLeadJob,
  hasLeadJobIdempotencyConflict,
  MAX_LEAD_WHATSAPP_BATCH_SIZE,
  normalizeCnpj
} from "./leads.types.js";

const testUuid = (value: number) =>
  `00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;

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
    const leadIds = Array.from({ length: MAX_LEAD_WHATSAPP_BATCH_SIZE }, (_, index) =>
      testUuid(index + 100)
    );

    expect(
      leadWhatsappVerificationRequestSchema.parse({
        listId: testUuid(1),
        leadIds
      }).leadIds
    ).toHaveLength(MAX_LEAD_WHATSAPP_BATCH_SIZE);

    expect(() =>
      leadWhatsappVerificationRequestSchema.parse({
        listId: testUuid(1),
        leadIds: [...leadIds, testUuid(126)]
      })
    ).toThrow();
  });

  it("rejects invalid and duplicate WhatsApp verification request IDs", () => {
    expect(() =>
      leadWhatsappVerificationRequestSchema.parse({
        listId: "not-a-uuid",
        leadIds: [testUuid(101)]
      })
    ).toThrow();

    expect(() =>
      leadWhatsappVerificationRequestSchema.parse({
        listId: testUuid(1),
        leadIds: [testUuid(101), testUuid(101)]
      })
    ).toThrow();

    expect(() =>
      leadWhatsappVerificationRequestSchema.parse({
        listId: testUuid(1),
        leadIds: [testUuid(101), testUuid(101).toUpperCase()]
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

  it("scopes idempotency by workspace, operation, and key", () => {
    const receitaSearch = leadJobIdempotencyScopeSchema.parse({
      workspaceId: "workspace-1",
      operation: "receita_search",
      idempotencyKey: "request-1"
    });
    const csvImport = leadJobIdempotencyScopeSchema.parse({
      workspaceId: "workspace-1",
      operation: "csv_import",
      idempotencyKey: "request-1"
    });

    expect(hasLeadJobIdempotencyConflict(receitaSearch, csvImport)).toBe(false);
    expect(hasLeadJobIdempotencyConflict(receitaSearch, { ...receitaSearch })).toBe(true);
  });

  it("parses the public result and campaign-draft contracts", () => {
    const page = leadPaginatedResultSchema.parse({
      items: [
        {
          id: testUuid(2),
          workspaceId: "workspace-1",
          listId: testUuid(1),
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
        campaignId: testUuid(3),
        status: "draft",
        contactCount: 1
      })
    ).toEqual({ campaignId: testUuid(3), status: "draft", contactCount: 1 });
  });

  it("parses typed similar-company scores, rule reasons, and results", () => {
    const parsed = similarCompanySearchResultSchema.parse({
      scoringVersion: "cnpj-similarity-v1",
      seed: {
        cnpj: "12.345.678/ABCD-90",
        companyName: "Empresa Semente",
        tradeName: null
      },
      items: [{
        cnpj: "87654321WXYZ10",
        companyName: "Empresa Parecida",
        tradeName: null,
        cnaePrimary: "6201500",
        cnaeSecondary: [],
        address: "Rua Um, 10",
        city: "São Paulo",
        state: "SP",
        postalCode: "01001000",
        phone: "11999999999",
        email: "contato@example.com",
        score: 20,
        components: [{
          key: "activity",
          weight: 35,
          score: 20,
          reasons: [{ key: "activity_primary_cnae_exact", label: "Mesmo CNAE principal", points: 20 }]
        }, {
          key: "location",
          weight: 25,
          score: 0,
          reasons: []
        }, {
          key: "profile",
          weight: 20,
          score: 0,
          reasons: []
        }, {
          key: "commercial_readiness",
          weight: 20,
          score: 0,
          reasons: []
        }],
        reasons: [{ key: "activity_primary_cnae_exact", label: "Mesmo CNAE principal", points: 20 }]
      }]
    });

    expect(parsed.seed.cnpj).toBe("12345678ABCD90");
    expect(parsed.items[0]?.components.map((component) => component.weight)).toEqual([35, 25, 20, 20]);
    expect(parsed.items[0]?.reasons[0]?.key).toBe("activity_primary_cnae_exact");
  });

  it("requires lead realtime payloads to remain in the event workspace", () => {
    expect(
      realtimeEventSchema.parse({
        type: "lead_job.updated",
        workspaceId: "workspace-1",
        payload: {
          id: testUuid(4),
          workspaceId: "workspace-1",
          listId: testUuid(1),
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
          id: testUuid(1),
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
