import { describe, expect, it } from "vitest";
import { agentPackageSchema } from "./agent-package.js";

const validPackage = {
  schemaVersion: 1,
  kind: "prymeira.agent-package",
  metadata: {
    key: "example-sales-qualifier",
    name: "Example Sales Qualifier",
    companyName: "Example Company",
    industry: "b2b-sales",
    language: "pt-BR",
    description: "Qualifies inbound sales requests."
  },
  variables: [{ key: "seller_name", label: "Nome do vendedor", required: true }],
  agent: {
    name: "Agente comercial",
    description: "Qualifica e encaminha oportunidades.",
    systemPrompt: "Qualifique o contato e encaminhe para {{seller_name}}.",
    qualification: {
      completionStage: "proposal_handoff",
      fields: [
        {
          key: "city",
          label: "Cidade",
          question: "Qual é a cidade de atendimento?",
          valueType: "text",
          requiredFor: ["proposal_handoff"],
          acceptedInputs: ["text", "audio"],
          dependsOn: [],
          condition: null,
          confirmationRequired: true
        }
      ]
    },
    knowledgeTaxonomy: [
      {
        key: "service_area",
        label: "Área de atendimento",
        aliases: ["cidade", "região", "atende"],
        requiresSource: true
      }
    ],
    behavior: { tone: "consultivo", maxQuestionsPerMessage: 1 },
    handoff: { confidenceThreshold: 0.6, requiredFields: ["city"] },
    limits: { maxMessagesPerSession: 12 },
    followup: {
      timeZone: "America/Sao_Paulo",
      businessDays: [1, 2, 3, 4, 5],
      businessHours: { start: "08:00", end: "18:00" },
      steps: [],
      closeAfterBusinessMinutes: 0
    },
    allowedActions: ["send_message", "create_internal_note", "request_handoff"]
  },
  knowledge: [
    {
      key: "service_area",
      type: "faq",
      title: "Área de atendimento",
      category: "service_area",
      content: "Atendimento definido pela equipe comercial.",
      approvalStatus: "confirmed",
      source: "Manual comercial",
      approvedBy: "Responsável comercial",
      approvedAt: "2026-09-05T12:00:00.000Z",
      validUntil: null,
      aliases: ["região atendida"]
    }
  ]
} as const;

describe("agentPackageSchema", () => {
  it("accepts a portable package with custom fields and taxonomy", () => {
    const parsed = agentPackageSchema.parse(validPackage);

    expect(parsed.agent.qualification.fields[0]?.key).toBe("city");
    expect(parsed.agent.knowledgeTaxonomy[0]?.key).toBe("service_area");
  });

  it("rejects duplicate qualification keys", () => {
    expect(() =>
      agentPackageSchema.parse({
        ...validPackage,
        agent: {
          ...validPackage.agent,
          qualification: {
            ...validPackage.agent.qualification,
            fields: [
              validPackage.agent.qualification.fields[0],
              validPackage.agent.qualification.fields[0]
            ]
          }
        }
      })
    ).toThrow(/qualification field keys/i);
  });

  it("rejects knowledge categories absent from the package taxonomy", () => {
    expect(() =>
      agentPackageSchema.parse({
        ...validPackage,
        knowledge: [{ ...validPackage.knowledge[0], category: "unknown_category" }]
      })
    ).toThrow(/knowledge category/i);
  });

  it("rejects unknown qualification dependencies", () => {
    expect(() =>
      agentPackageSchema.parse({
        ...validPackage,
        agent: {
          ...validPackage.agent,
          qualification: {
            ...validPackage.agent.qualification,
            fields: [
              { ...validPackage.agent.qualification.fields[0], dependsOn: ["missing_field"] }
            ]
          }
        }
      })
    ).toThrow(/qualification dependency/i);
  });
});
