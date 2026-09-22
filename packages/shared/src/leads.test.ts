import { describe, expect, it } from "vitest";
import {
  leadCampaignDraftRequestSchema,
  leadContactImportResultSchema,
  leadContactImportRequestSchema,
  leadGoogleSearchRequestSchema
} from "./leads.js";

describe("Google lead search contracts", () => {
  it("normalizes Brazil state and applies bounded max-time without exposing scraper controls", () => {
    const parsed = leadGoogleSearchRequestSchema.parse({
      name: "Padarias",
      niche: "padarias artesanais",
      city: "Campinas",
      state: "sp",
      idempotencyKey: "request-1",
      depth: 99,
      concurrency: 99
    });

    expect(parsed).toEqual({
      name: "Padarias",
      niche: "padarias artesanais",
      city: "Campinas",
      state: "SP",
      idempotencyKey: "request-1",
      maxTimeSeconds: 600
    });
    expect(() => leadGoogleSearchRequestSchema.parse({ ...parsed, maxTimeSeconds: 179 })).toThrow();
    expect(() => leadGoogleSearchRequestSchema.parse({ ...parsed, maxTimeSeconds: 901 })).toThrow();
  });
});

describe("Lead conversion contracts", () => {
  const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;

  it("requires an explicit non-empty unique lead selection", () => {
    expect(() => leadContactImportRequestSchema.parse({ selectedLeadIds: [] })).toThrow();
    expect(() => leadContactImportRequestSchema.parse({ selectedLeadIds: [id(1), id(1)] })).toThrow();
    expect(leadContactImportRequestSchema.parse({ selectedLeadIds: [id(1)] })).toEqual({
      selectedLeadIds: [id(1)]
    });
  });

  it("makes a common campaign body selection unambiguous", () => {
    expect(() =>
      leadCampaignDraftRequestSchema.parse({
        selectedLeadIds: [id(1)],
        messageBody: "Mensagem comum",
        quickReplyId: id(2)
      })
    ).toThrow();
  });

  it("exposes only localized source-tag and provenance summaries", () => {
    const result = leadContactImportResultSchema.parse({
      requestedCount: 1,
      importedCount: 1,
      createdCount: 1,
      reconciledCount: 0,
      skippedCount: 0,
      contacts: [{
        leadId: id(1),
        contactId: id(2),
        provenanceId: id(3),
        phone: "5511999999999",
        status: "created",
        reason: null,
        sourceTag: { name: "Origem: Lead Google", color: "#1c6653", workspaceId: "must-strip" },
        provenance: {
          id: id(3),
          source: "google_maps",
          listId: id(4),
          importedAt: "2026-09-22T12:00:00.000Z",
          whatsappStatus: "available",
          suggestedMessage: "Olá",
          workspaceId: "must-strip"
        }
      }]
    });

    expect(result.contacts[0]?.sourceTag).toEqual({ name: "Origem: Lead Google", color: "#1c6653" });
    expect(result.contacts[0]?.provenance).toEqual({
      id: id(3),
      source: "google_maps",
      listId: id(4),
      importedAt: "2026-09-22T12:00:00.000Z",
      whatsappStatus: "available",
      suggestedMessage: "Olá"
    });
  });
});
