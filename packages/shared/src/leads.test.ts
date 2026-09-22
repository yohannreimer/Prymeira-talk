import { describe, expect, it } from "vitest";
import { leadGoogleSearchRequestSchema } from "./leads.js";

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
