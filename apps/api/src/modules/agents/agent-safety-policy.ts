import type { SelectedKnowledgeSource } from "./knowledge-retrieval.js";
import type { AgentOutput } from "./provider-gateway.js";

export type ProtectedFact =
  | "price"
  | "stock"
  | "deadline"
  | "technical_specification";

export type AgentSafetyDecision = {
  handoffRequired: boolean;
  protectedFact: ProtectedFact | null;
  reason: string | null;
};

const HUMAN_REQUEST =
  /\b(falar|conversar|atendimento|passar|transferir|chamar)\b.{0,40}\b(pessoa|humano|atendente|comercial|especialista|vendedor)\b|\b(quero|preciso|prefiro)\b.{0,30}\b(pessoa|humano|atendente|comercial|especialista|vendedor)\b/i;

const PROTECTED_RULES: Array<{
  type: ProtectedFact;
  question: RegExp;
  evidence: RegExp;
}> = [
  {
    type: "stock",
    question: /\b(estoque|dispon[ií]vel|disponibilidade|unidades hoje|pronta entrega)\b/i,
    evidence:
      /\b(estoque|disponibilidade|pronta entrega)\b.{0,80}\b(confirm|consult|verific|\d+)|\bsob encomenda\b/i
  },
  {
    type: "price",
    question: /\b(pre[cç]o|valor|custa|custo|desconto|or[cç]amento)\b/i,
    evidence:
      /\br\$\s*\d|\b(pre[cç]o|valor|desconto|or[cç]amento)\b.{0,80}\b(confirm|consult|verific)/i
  },
  {
    type: "deadline",
    question: /\b(prazo|entrega|at[eé] quando|sexta|dias [uú]teis|previs[aã]o)\b/i,
    evidence:
      /\b\d+\s*dias?\b|\b(prazo|entrega|previs[aã]o)\b.{0,80}\b(confirm|consult|verific)/i
  },
  {
    type: "technical_specification",
    question:
      /\b(aguenta|suporta|dimension|carga|peso|qual viga|espessura exata|capacidade|resist[eê]ncia)\b/i,
    evidence:
      /\b(projeto|memorial|carga|dimensionamento|capacidade|respons[aá]vel t[eé]cnico)\b/i
  }
];

export function evaluateAgentSafety(input: {
  message: string;
  selectedKnowledge: Array<Pick<SelectedKnowledgeSource, "content">>;
}): AgentSafetyDecision {
  if (HUMAN_REQUEST.test(input.message)) {
    return {
      handoffRequired: true,
      protectedFact: null,
      reason: "Customer requested human service."
    };
  }

  const rule = PROTECTED_RULES.find((candidate) => candidate.question.test(input.message));
  if (!rule) {
    return { handoffRequired: false, protectedFact: null, reason: null };
  }

  const hasEvidence = input.selectedKnowledge.some((chunk) => rule.evidence.test(chunk.content));
  return hasEvidence
    ? { handoffRequired: false, protectedFact: rule.type, reason: null }
    : {
        handoffRequired: true,
        protectedFact: rule.type,
        reason: `Missing ${rule.type} evidence.`
      };
}

export function createSafetyHandoffOutput(reason: string): AgentOutput {
  return {
    confidence: 0.2,
    reply:
      "Não quero te passar uma informação errada. Vou encaminhar para o comercial confirmar com segurança.",
    actions: [{ type: "request_handoff", reason }],
    handoff: { required: true, reason }
  };
}
