import type { AgentPackage } from "@prymeira-talk/shared";
import { describe, expect, it } from "vitest";
import {
  assertPrivacySafeArtifact,
  compileHistoricalTraining,
  type HistoricalTrainingDefinition
} from "./historical-training-compiler.js";

const packageFixture: AgentPackage = {
  schemaVersion: 1,
  kind: "prymeira.agent-package",
  metadata: {
    key: "example-training-package",
    name: "Example training package",
    companyName: "Example Company",
    industry: "b2b-sales",
    language: "pt-BR",
    description: "A safe historical training package."
  },
  variables: [{ key: "seller_name", label: "Vendedor", required: true }],
  agent: {
    name: "Agente de {{seller_name}}",
    description: "Qualifica pedidos.",
    systemPrompt: "Qualifique o pedido e entregue para {{seller_name}}.",
    qualification: { completionStage: "proposal_handoff", fields: [] },
    knowledgeTaxonomy: [
      { key: "produto", label: "Produto", aliases: ["material"], requiresSource: false }
    ],
    behavior: {},
    handoff: {},
    limits: {},
    followup: {
      timeZone: "America/Sao_Paulo",
      businessDays: [1, 2, 3, 4, 5],
      businessHours: { start: "08:00", end: "18:00" },
      steps: [],
      closeAfterBusinessMinutes: 0
    },
    allowedActions: ["send_message"]
  },
  knowledge: []
};

function history(instance: string, index: number) {
  return {
    instance,
    window: {
      start: "2026-06-04T03:00:00.000Z",
      endExclusive: "2026-09-04T15:28:16.996Z"
    },
    messages: [
      {
        id: `message-private-${index}`,
        chatId: `554799999000${index}@s.whatsapp.net`,
        participant: null,
        fromMe: false,
        timestamp: "2026-06-05T12:00:00.000Z",
        timestampMs: 1780660800000,
        messageType: "conversation",
        text: "Meu e-mail é cliente@example.com e preciso de preço.",
        pushName: `Cliente Privado ${index}`,
        source: "database",
        hasMedia: false,
        raw: {}
      },
      {
        id: `message-media-${index}`,
        chatId: `554799999000${index}@s.whatsapp.net`,
        participant: null,
        fromMe: true,
        timestamp: "2026-06-05T12:01:00.000Z",
        timestampMs: 1780660860000,
        messageType: "documentMessage",
        text: "Segue a proposta.",
        pushName: "Você",
        source: "database",
        hasMedia: true,
        raw: {}
      }
    ]
  };
}

function baseline(instance: string, index: number) {
  return {
    instance,
    sourceMessages: 2,
    individualChats: 1,
    conversationSegments: 1,
    classificationCounts: { sales: 1 },
    questionCategories: { preco: 1, entrega_frete: index % 2 },
    conversations: [
      {
        id: `conversation-private-${index}`,
        chatId: `554799999000${index}@s.whatsapp.net`,
        contactName: `Cliente Privado ${index}`,
        classification: "sales"
      }
    ]
  };
}

const definition: HistoricalTrainingDefinition = {
  compilerVersion: "1.0.0",
  generatedAt: "2026-09-05T12:00:00.000Z",
  minimumInstances: 4,
  package: packageFixture,
  evaluationSuite: {
    schemaVersion: 1,
    packageKey: packageFixture.metadata.key,
    generatedAt: "2026-09-05T12:00:00.000Z",
    methodology: "Anonymized paraphrases.",
    cases: []
  },
  approvedDecisions: ["Qualificar antes do handoff."],
  needsValidation: ["Confirmar catálogo e políticas atuais."],
  behavioralFindings: ["Pedidos frequentemente começam incompletos."]
};

describe("compileHistoricalTraining", () => {
  it("aggregates four histories without copying raw conversations", () => {
    const inputs = ["Henry", "Diogo", "Villefer Geral", "Junior Villefer"].map(
      (instance, index) => ({
        history: history(instance, index),
        baseline: baseline(instance, index)
      })
    );

    const result = compileHistoricalTraining({ inputs, definition });

    expect(result.evidence.overall).toMatchObject({
      instances: 4,
      sourceMessages: 8,
      commercialJourneys: 4,
      commercialContacts: 4,
      inboundMessages: 4,
      outboundMessages: 4
    });
    expect(result.evidence.overall.demandSignals).toEqual({
      entrega_frete: 2,
      preco: 4
    });
    expect(result.evidence.overall.media).toEqual({ documentMessage: 4 });
    expect(JSON.stringify(result)).not.toContain("cliente@example.com");
    expect(JSON.stringify(result)).not.toContain("554799999000");
    expect(result.reviewMarkdown).toContain("Confirmar catálogo e políticas atuais.");
  });

  it("is deterministic for the same inputs", () => {
    const inputs = ["Henry", "Diogo", "Villefer Geral", "Junior Villefer"].map(
      (instance, index) => ({ history: history(instance, index), baseline: baseline(instance, index) })
    );

    expect(compileHistoricalTraining({ inputs, definition })).toEqual(
      compileHistoricalTraining({ inputs, definition })
    );
  });

  it("rejects incomplete source sets and unknown package placeholders", () => {
    expect(() =>
      compileHistoricalTraining({
        inputs: [{ history: history("Henry", 0), baseline: baseline("Henry", 0) }],
        definition
      })
    ).toThrow(/four source instances/i);

    expect(() =>
      compileHistoricalTraining({
        inputs: ["Henry", "Diogo", "Villefer Geral", "Junior Villefer"].map(
          (instance, index) => ({ history: history(instance, index), baseline: baseline(instance, index) })
        ),
        definition: {
          ...definition,
          package: {
            ...packageFixture,
            agent: {
              ...packageFixture.agent,
              systemPrompt: "Qualifique e entregue para {{unknown_variable}}."
            }
          }
        }
      })
    ).toThrow(/unknown package variable/i);
  });
});

describe("assertPrivacySafeArtifact", () => {
  it("rejects direct identifiers in generated strings", () => {
    expect(() => assertPrivacySafeArtifact({ leaked: "5547999990000@s.whatsapp.net" })).toThrow(
      /private identifier/i
    );
    expect(() => assertPrivacySafeArtifact({ leaked: "cliente@example.com" })).toThrow(
      /private identifier/i
    );
    expect(() => assertPrivacySafeArtifact({ leaked: "https://private.example/quote/123" })).toThrow(
      /private identifier/i
    );
  });
});
