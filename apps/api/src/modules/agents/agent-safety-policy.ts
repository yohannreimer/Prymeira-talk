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

export const HANDOFF_ACKNOWLEDGEMENT =
  "Vou consultar essas informações e já te dou um retorno.";

const HUMAN_REQUEST =
  /\b(falar|conversar|atendimento|passar|transferir|chamar)\b.{0,40}\b(pessoa|humano|atendente|comercial|especialista|vendedor)\b|\b(quero|preciso|prefiro)\b.{0,30}\b(pessoa|humano|atendente|comercial|especialista|vendedor)\b/i;

const PROTECTED_RULES: Array<{
  type: ProtectedFact;
  question: RegExp;
  evidence: RegExp;
}> = [
  {
    type: "stock",
    question: /\b(estoque|dispon[ií]ve(?:l|is)|disponibilidade|unidades hoje|pronta entrega)\b/i,
    evidence:
      /\b\d+\s*(?:unidades?|pe[cç]as?|chapas?|barras?)\b.{0,80}\b(?:dispon[ií]ve(?:l|is)|em estoque|pronta entrega)\b|\b(?:dispon[ií]ve(?:l|is)|em estoque)\b.{0,80}\b\d+\s*(?:unidades?|pe[cç]as?|chapas?|barras?)\b/i
  },
  {
    type: "price",
    question:
      /\b(pre[cç]o|valor|vlr|custa|custo|desconto)\b|\b(quanto|qual|confirm|fechar|aprov|passou|recebi|ontem)\w*\b.{0,50}\bor[cç]amento\b|\bor[cç]amento\b.{0,50}\b(quanto|valor|confirm|fechar|aprov|passou|recebi|ontem)\w*\b/i,
    evidence: /\br\$\s*\d/i
  },
  {
    type: "deadline",
    question: /\b(prazo|entrega|at[eé] quando|sexta|dias [uú]teis|previs[aã]o)\b/i,
    evidence: /\b\d+\s*(?:dias?|horas?)\b/i
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
    reply: HANDOFF_ACKNOWLEDGEMENT,
    actions: [{ type: "request_handoff", reason }],
    handoff: { required: true, reason }
  };
}
