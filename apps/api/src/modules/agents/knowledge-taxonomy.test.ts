import { describe, expect, it } from "vitest";
import { readKnowledgeTaxonomy } from "./knowledge-taxonomy.js";

describe("readKnowledgeTaxonomy", () => {
  it("reads custom categories from agent behavior config", () => {
    const taxonomy = readKnowledgeTaxonomy({
      knowledgeTaxonomy: [
        {
          key: "materials",
          label: "Materiais",
          aliases: ["chapa", "aço"],
          requiresSource: true
        }
      ]
    });

    expect(taxonomy).toEqual([
      {
        key: "materials",
        label: "Materiais",
        aliases: ["chapa", "aço"],
        requiresSource: true
      }
    ]);
  });

  it("falls back to the legacy taxonomy for existing agents", () => {
    expect(readKnowledgeTaxonomy({}).map((item) => item.key)).toContain("precos");
  });

  it("falls back safely when a saved taxonomy is invalid", () => {
    expect(
      readKnowledgeTaxonomy({ knowledgeTaxonomy: [{ key: "Invalid key" }] }).map(
        (item) => item.key
      )
    ).toContain("precos");
  });
});
