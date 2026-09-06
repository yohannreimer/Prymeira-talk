import { agentPackageSchema } from "@prymeira-talk/shared";
import { describe, expect, it } from "vitest";
import { assertPrivacySafeArtifact, historicalEvaluationSuiteSchema } from "./historical-training-compiler.js";
import { villeferV1Definition } from "./villefer-v1-definition.js";

describe("villeferV1Definition", () => {
  it("does not require an optional deadline or reconfirm supplied customer facts", () => {
    const fields = villeferV1Definition.package.agent.qualification.fields;

    expect(fields.find((field) => field.key === "desired_deadline")?.requiredFor).toEqual([]);
    expect(fields.filter((field) => field.confirmationRequired).map((field) => field.key)).toEqual([]);
    expect(fields.find((field) => field.key === "fulfillment")?.dependsOn).toEqual([]);
    expect(villeferV1Definition.evaluationSuite.cases.filter((testCase) =>
      testCase.expected.missingFields.includes("desired_deadline")
    )).toEqual([]);
  });

  it("expects complete requests to hand off without a final confirmation", () => {
    const complete = villeferV1Definition.evaluationSuite.cases.find((testCase) =>
      testCase.id === "complete_single_item"
    );

    expect(complete?.expected).toMatchObject({
      stage: "proposal_handoff", nextAction: "handoff", handoffExpected: true, missingFields: []
    });
  });

  it("ships replay cases for technical preservation, corrections and per-item gaps", () => {
    const suite = historicalEvaluationSuiteSchema.parse(villeferV1Definition.evaluationSuite);
    const expectations = [
      ["compact_chapa_dimensions", ["thickness", "dimensions", "quantity"], [], true],
      ["latest_quantity_correction", ["quantity", "dimensions"], [], true],
      ["pickup_missing_city", ["fulfillment", "thickness"], ["city"], false],
      ["technical_codes_missing_lengths", ["product", "specification", "quantity"], ["dimensions"], false],
      ["fractional_tube_measure", ["product", "dimensions"], ["thickness", "quantity"], false],
      ["ambiguous_profile_description", ["product", "quantity"], ["specification"], false],
      ["mixed_list_per_item_gaps", ["product", "quantity"], ["dimensions"], false],
      ["mixed_list_shared_material_and_clarified_unit", ["product", "specification", "dimensions", "quantity"], [], true]
    ] as const;

    for (const [id, capturedFields, missingFields, handoffExpected] of expectations) {
      const testCase = suite.cases.find((entry) => entry.id === id);
      expect(testCase, id).toBeDefined();
      expect(testCase?.expected.capturedFields, id).toEqual(expect.arrayContaining([...capturedFields]));
      expect(testCase?.expected.missingFields, id).toEqual(expect.arrayContaining([...missingFields]));
      expect(testCase?.expected.handoffExpected, id).toBe(handoffExpected);
    }
  });

  it("replays a shared material answer and explicit unit clarification before handoff", () => {
    const replay = historicalEvaluationSuiteSchema.parse(villeferV1Definition.evaluationSuite).cases.find(
      (entry) => entry.id === "mixed_list_shared_material_and_clarified_unit"
    );
    expect(replay?.conversation.map((turn) => turn.role)).toEqual(["user", "assistant", "user"]);
    expect(replay?.conversation[0].content).toContain("tudo redondo de 4'");
    expect(replay?.conversation[1].content).toContain("material das chapas, perfis, barras e tubos");
    expect(replay?.conversation[2].content).toContain("4 polegadas. Material aço carbono");
    expect(replay?.expected).toMatchObject({ missingFields: [], handoffExpected: true });
    expect(replay?.expected.responseGuidance).toMatch(/aço carbono aos quatro itens.*inclusive chapas/);
    expect(replay?.expected.responseGuidance).toMatch(/4'.*4 polegadas, sem pendência de unidade/);
    expect(replay?.expected.responseGuidance).toContain("tubo redondo sem criar dúvida técnica");
  });

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
    expect(prompt).toMatch(/aplica[cç][aã]o, norma, certificado, empresa e prazo desejado s[aã]o complementares/i);
    expect(prompt).toMatch(/n[aã]o os pergunte apenas para completar cadastro/i);
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
