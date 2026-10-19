import { describe, expect, it } from "vitest";
import {
  buildExpansionKeywords,
  primarySearchKeyword,
  remoteKeywordLine,
  similarNicheTerms
} from "./google-search-expansion.js";

describe("Google search expansion", () => {
  it("combines Google categories from the original results with related niche terms", () => {
    expect(similarNicheTerms("Caldeirarias", ["Caldeiraria", "Metalúrgica", "Metalúrgica", "Usinagem"]))
      .toEqual(["metalúrgica", "usinagem", "estruturas metálicas"]);
  });

  it("returns no similar terms for an unknown niche without categories", () => {
    expect(similarNicheTerms("loja de pipas")).toEqual([]);
  });

  it("builds region, nearby city and similar-term keywords tagged with stable ids", () => {
    const keywords = buildExpansionKeywords({
      niche: "caldeiraria",
      city: "Guaramirim",
      state: "SC",
      nearbyCities: ["Jaraguá do Sul", "guaramirim", "Corupá", "Jaraguá do Sul", "Schroeder", "Massaranduba", "A", "B"],
      similarTerms: ["metalúrgica", "usinagem"]
    });

    expect(keywords).toEqual([
      { id: "x-r", keyword: "caldeiraria", term: "caldeiraria", city: null },
      { id: "x-c0", keyword: "caldeiraria em Jaraguá do Sul, SC", term: "caldeiraria", city: "Jaraguá do Sul" },
      { id: "x-c1", keyword: "caldeiraria em Corupá, SC", term: "caldeiraria", city: "Corupá" },
      { id: "x-c2", keyword: "caldeiraria em Schroeder, SC", term: "caldeiraria", city: "Schroeder" },
      { id: "x-c3", keyword: "caldeiraria em Massaranduba, SC", term: "caldeiraria", city: "Massaranduba" },
      { id: "x-c4", keyword: "caldeiraria em A, SC", term: "caldeiraria", city: "A" },
      { id: "x-t0", keyword: "metalúrgica em Guaramirim, SC", term: "metalúrgica", city: "Guaramirim" },
      { id: "x-t1", keyword: "usinagem em Guaramirim, SC", term: "usinagem", city: "Guaramirim" }
    ]);
    expect(remoteKeywordLine(keywords[1]!)).toBe("caldeiraria em Jaraguá do Sul, SC #!#x-c0");
    expect(remoteKeywordLine({ id: "x-r", keyword: "a #!# b", term: "a", city: null })).toBe("a   b #!#x-r");
    expect(primarySearchKeyword({ niche: "caldeiraria", city: "Guaramirim", state: "SC" }).keyword)
      .toBe("caldeiraria em Guaramirim, SC");
  });
});

describe("Lead search origin", () => {
  it("exposes the search term and city stored in the Maps snapshot", async () => {
    const { toLeadResultDto } = await import("./leads.repository.js");
    const base = {
      id: "00000000-0000-4000-8000-000000000002", workspaceId: "w", listId: "00000000-0000-4000-8000-000000000001",
      source: "google_maps", companyName: "Alfa", tradeName: null, cnpj: null, cnaePrimary: null, cnaeSecondary: [],
      category: null, address: null, city: null, state: null, postalCode: null, phones: [], normalizedPhone: null,
      email: null, website: null, rating: null, reviewCount: null, latitude: null, longitude: null, sourceUrl: null,
      createdAt: new Date("2026-10-19T00:00:00.000Z"), updatedAt: new Date("2026-10-19T00:00:00.000Z")
    };
    expect(toLeadResultDto({ ...base, sourceSnapshot: { searchTerm: "usinagem", searchCity: "Corupá", searchExpanded: true } } as never).searchOrigin)
      .toEqual({ term: "usinagem", city: "Corupá", expanded: true });
    expect(toLeadResultDto({ ...base, sourceSnapshot: { searchTerm: "usinagem", searchCity: null } } as never).searchOrigin)
      .toEqual({ term: "usinagem", city: null, expanded: false });
    expect(toLeadResultDto({ ...base, sourceSnapshot: { queryCity: "Campinas" } } as never).searchOrigin).toBeNull();
  });
});
