import { agentPackageSchema } from "@prymeira-talk/shared";
import { describe, expect, it } from "vitest";
import { assertPrivacySafeArtifact } from "./historical-training-compiler.js";
import { villeferV1Definition } from "./villefer-v1-definition.js";

describe("villeferV1Definition", () => {
  it("produces an importable package with the approved qualification scope", () => {
    const parsed = agentPackageSchema.parse(villeferV1Definition.package);
    const fieldKeys = parsed.agent.qualification.fields.map((field) => field.key);

    expect(parsed.agent.systemPrompt.length).toBeLessThanOrEqual(8000);
    expect(fieldKeys).toEqual(
      expect.arrayContaining([
        "company",
        "city",
        "product",
        "application",
        "specification",
        "thickness",
        "dimensions",
        "quantity",
        "processing",
        "fulfillment",
        "desired_deadline",
        "attachments"
      ])
    );
    expect(parsed.agent.allowedActions).toEqual(
      expect.arrayContaining(["send_message", "create_internal_note", "request_handoff"])
    );
  });

  it("contains three contextual follow-ups inside the approved business calendar", () => {
    const followup = villeferV1Definition.package.agent.followup;

    expect(followup.timeZone).toBe("America/Sao_Paulo");
    expect(followup.businessDays).toEqual([1, 2, 3, 4, 5]);
    expect(followup.businessHours).toEqual({ start: "08:00", end: "18:00" });
    expect(followup.steps.map((step) => step.afterBusinessMinutes)).toEqual([720, 1200, 2400]);
    expect(followup.steps.every((step) => /context|bloqueio|alternativa|demanda/i.test(step.instruction))).toBe(true);
  });

  it("keeps historical observations behavioral and commercial facts source-gated", () => {
    const historical = villeferV1Definition.package.knowledge.filter((source) =>
      source.source.startsWith("Históricos anonimizados")
    );
    const requiredSourceCategories = villeferV1Definition.package.agent.knowledgeTaxonomy
      .filter((category) => category.requiresSource)
      .map((category) => category.key);

    expect(historical.length).toBeGreaterThanOrEqual(4);
    expect(historical.every((source) => source.approvalStatus === "behavioral")).toBe(true);
    expect(requiredSourceCategories).toEqual(
      expect.arrayContaining([
        "price_and_proposal",
        "stock_and_availability",
        "delivery_and_freight",
        "payment_and_credit",
        "tax_and_invoice"
      ])
    );
  });

  it("covers the critical laboratory scenarios with anonymized paraphrases", () => {
    const suite = villeferV1Definition.evaluationSuite;
    const categories = new Set(suite.cases.map((testCase) => testCase.category));

    expect(suite.cases.length).toBeGreaterThanOrEqual(18);
    expect([...categories]).toEqual(
      expect.arrayContaining([
        "complete_request",
        "incomplete_request",
        "multimodal",
        "commercial_limit",
        "proposal_followup",
        "human_control",
        "prompt_injection"
      ])
    );
    expect(
      suite.cases.every((testCase) => testCase.expected.forbiddenClaims.length > 0)
    ).toBe(true);
    expect(() => assertPrivacySafeArtifact(suite)).not.toThrow();
  });

  it("ships the approved positive catalog with structured retrieval metadata", () => {
    const catalog = villeferV1Definition.package.knowledge.find(
      (source) => source.key === "approved_positive_catalog_v1"
    );

    expect(catalog).toEqual(expect.objectContaining({
      approvalStatus: "confirmed",
      category: "product_and_specification"
    }));
    expect(catalog?.aliases).toEqual(expect.arrayContaining([
      "tubo industrial",
      "tubos industriais",
      "metalon"
    ]));
  });

  it("encodes the approved practical qualification and urgency rules", () => {
    const prompt = villeferV1Definition.package.agent.systemPrompt;
    const incompleteChapa = villeferV1Definition.evaluationSuite.cases.find(
      (testCase) => testCase.id === "incomplete_chapa"
    );
    const urgent = villeferV1Definition.evaluationSuite.cases.find(
      (testCase) => testCase.id === "urgent_deadline"
    );

    expect(prompt).toMatch(/uma (?:única|unica) mensagem curta/i);
    expect(prompt).toMatch(/perda expl[ií]cita/i);
    expect(incompleteChapa?.expected.responseGuidance).toMatch(
      /tipo.*medida.*espessura.*quantidade/i
    );
    expect(urgent?.expected).toEqual(expect.objectContaining({
      stage: "qualification",
      nextAction: "ask_next_field",
      handoffExpected: false,
      missingFields: expect.arrayContaining(["product", "dimensions", "quantity"])
    }));
  });
});
