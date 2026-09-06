import type { SelectedKnowledgeSource } from "./knowledge-retrieval.js";
import type { AgentOutput } from "./provider-gateway.js";

export type ProtectedFact =
  | "price"
  | "stock"
  | "deadline"
  | "freight"
  | "payment"
  | "tax"
  | "technical_specification";

export type AgentSafetyOutcome =
  | "continue"
  | "handoff"
  | "close_loss"
  | "close_purchase"
  | "await_approval"
  | "ignore_injection"
  | "request_attachment"
  | "qualify_urgent";

export type AgentSafetyDecision = {
  handoffRequired: boolean;
  protectedFact: ProtectedFact | null;
  reason: string | null;
  outcome: AgentSafetyOutcome;
  injectionRecovery?: "request_clean_copy";
};

export const HANDOFF_ACKNOWLEDGEMENT =
  "Vou consultar essas informações e já te dou um retorno.";

const LOSS_ACKNOWLEDGEMENT =
  "Tranquilo, obrigado pelo retorno! Fico à disposição para uma próxima oportunidade.";
const PURCHASE_ACKNOWLEDGEMENT = "Certo, obrigado por avisar! Fico à disposição para a próxima.";
const INJECTION_RECOVERY =
  "Pode me enviar a lista de materiais com os itens, medidas e quantidades?";
const INJECTION_CLEAN_COPY_RECOVERY =
  "Recebi o conteúdo, mas ele mistura dados do pedido com outras instruções. Pode reenviar uma versão com somente os dados do pedido? Se preferir, chamo uma pessoa do time.";
const URGENT_QUALIFICATION =
  "Entendi a urgência. Para o vendedor confirmar o prazo, me informe o produto, as medidas ou especificação e a quantidade.";
const ATTACHMENT_REFERENCE_ONLY = /^(?:(?:oi|ol[aá]|bom dia|boa tarde|boa noite)[,!.\s]*)?(?:segue(?:m)?|enviei|mandei)\s+(?:o |a |os |as )?(?:arquivo|anexo|lista|foto|imagem|documento)s?[.!\s]*$/i;

const HUMAN_REQUEST =
  /\b(falar|conversar|atendimento|passar|transferir|chamar)\b.{0,40}\b(pessoa|humano|atendente|comercial|especialista|vendedor)\b|\b(quero|preciso|prefiro)\b.{0,30}\b(pessoa|humano|atendente|comercial|especialista|vendedor)\b/i;
const PROMPT_INJECTION =
  /\b(ignore|desconsidere|esque[cç]a)\b.{0,80}\b(regras?|instru[cç][oõ]es?|prompt|mensagens? anteriores?)\b|\b(revele|mostre|copie|repita)\b.{0,60}\b(prompt|regras? internas?|instru[cç][oõ]es? internas?|segredos?)\b|\b(mude|troque|altere)\b.{0,50}\b(papel|fun[cç][aã]o|regras?)\b/i;
const EXPLICIT_LOSS =
  /\b(?:pedido\s+)?(?:j[aá]\s+)?(?:foi\s+)?comprad[oa]\b.{0,100}\b(?:outro|concorrente|fornecedor)\b|\b(?:comprei|compramos|fechei|fechamos|decidi(?:mos)?\s+fechar)\b.{0,100}\b(?:outro|concorrente|fornecedor)\b|\b(?:desisti|desistimos)\b|\bn[aã]o\s+(?:vou|vamos|iremos)\s+(?:seguir|prosseguir)\b/i;
const APPROVAL_STATUS = /\b(?:dependo|dependemos|aguardo|aguardamos|aguardando)\b.{0,50}\baprova[cç][aã]o\b|\b(?:mandei|mandamos|enviei|enviamos|encaminhei|encaminhamos)\b.{0,40}\bpara\s+aprova[cç][aã]o\b/i;
// Status updates must not swallow a new request in the same message.
const ADDITIONAL_REQUEST = /\b(?:qual|quanto|qto|pode|podem|consegue|conseguem|quero|preciso|gostaria|manda|mande|envia|envie|me passa|voc[eê]s t[eê]m)\b/i;
const BARE_PURCHASE = /^(?:(?:oi|ol[aá]|bom dia|boa tarde|boa noite|tudo bem|tudo certo|e por a[ií])[,!.?\s]*)*(?:j[aá]\s+comprei|comprei\s+j[aá])[,!.\s]*(?:obrigad[oa][!.\s]*)?$/i;
const URGENT_REQUEST =
  /\b(?:urgente|urg[eê]ncia)\b|\b(?:fechar|preciso\s+fechar)\b.{0,30}\b(?:hoje|agora)\b|\breceber\b.{0,35}\b(?:hoje|amanh[aã]|nesta semana|essa semana|ainda esta semana)\b|\b(?:garante|sem falta)\b/i;
const PRODUCT_SIGNAL =
  /\b(chapas?|tubos?|vigas?|perfis?|barras?|cantoneiras?|a[cç]o|inox|alum[ií]nio|metalon)\b/i;
const SPECIFICATION_SIGNAL =
  /\b(?:sae|nbr|astm|schedule)\s*[a-z0-9.-]+\b|\b\d+(?:[.,]\d+)?\s*(?:mm|cm|m)\b|\b\d+(?:[.,]\d+)?\s*x\s*\d+(?:[.,]\d+)?\b/i;
const QUANTITY_SIGNAL =
  /\b(?:\d+(?:[.,]\d+)?|um|uma|dois|duas|tr[eê]s|quatro|cinco|seis|sete|oito|nove|dez|vinte)\s*(?:unidades?|pe[cç]as?|chapas?|tubos?|vigas?|perfis?|barras?|kg|quilos?|toneladas?)\b/i;
const READY_DELIVERY_CONCEPT = /\bpronta entrega\b/i;
const EXPLANATORY_QUESTION =
  /\b(o que (?:[eé]|significa)|como funciona|qual (?:[eé] )?a diferen[cç]a|diferen[cç]a entre)\b/i;

const PROTECTED_RULES: Array<{
  type: ProtectedFact;
  question: RegExp;
  evidence: RegExp;
}> = [
  {
    type: "stock",
    question:
      /\b(?:tem|t[eê]m|possui|possuem|h[aá]|consegue|conseguem)\b.{0,70}\b(?:estoque|dispon[ií]ve(?:l|is)|disponibilidade|pronta entrega)\b|\b(?:estoque|disponibilidade)\b.{0,40}\b(?:hoje|agora|imediata|confirmar|consultar)\b|\bretirada imediata\b/i,
    evidence:
      /\b\d+\s*(?:unidades?|pe[cç]as?|chapas?|barras?)\b.{0,80}\b(?:dispon[ií]ve(?:l|is)|em estoque|pronta entrega)\b|\b(?:dispon[ií]ve(?:l|is)|em estoque)\b.{0,80}\b\d+\s*(?:unidades?|pe[cç]as?|chapas?|barras?)\b/i
  },
  {
    type: "freight",
    question:
      /\bfrete\b|\b(?:custo|valor|pre[cç]o)\b.{0,35}\b(?:entrega|transporte)\b|\bentrega\b.{0,25}\b(?:gr[aá]tis|sem custo)\b/i,
    evidence: /\br\$\s*\d+\b.{0,60}\b(?:frete|entrega|transporte)\b|\bfrete\b.{0,60}\br\$\s*\d+/i
  },
  {
    type: "payment",
    question:
      /\bcondi[cç][aã]o(?:es)?\s+de\s+pagamento\b|\b(?:pagar|pagamento)\b.{0,40}\b(?:boleto|pix|cart[aã]o|parcel|dias?|prazo)\b|\b(?:boleto|pix|cart[aã]o|parcelamento)\b/i,
    evidence:
      /\b(?:boleto|pix|cart[aã]o|parcelamento|pagamento)\b.{0,80}\b\d+\s*(?:dias?|vezes?)\b|\b\d+\s*(?:dias?|vezes?)\b.{0,80}\b(?:boleto|pagamento|parcelamento)\b/i
  },
  {
    type: "tax",
    question:
      /\bbenef[ií]cio\s+fiscal\b|\bisen[cç][aã]o\b|\bicms\b|\bipi\b|\bsubstitui[cç][aã]o\s+tribut[aá]ria\b/i,
    evidence:
      /\b(?:benef[ií]cio\s+fiscal|isen[cç][aã]o|icms|ipi|substitui[cç][aã]o\s+tribut[aá]ria)\b.{0,100}\b(?:aplica|al[ií]quota|percentual|regra|confirmad[oa])\b/i
  },
  {
    type: "price",
    question:
      /\b(pre[cç]os?|valor(?:es)?|vlrs?|custa|custos?|descontos?)\b|\bquanto\s+(?:fica|d[aá])\b|\bqual\s+(?:[eé]\s+)?o\s+total\b|\bpor\s+(?:quilo|kg)\b|\b(fechar|confirm|aprov|passou|recebi|ontem)\w*\b.{0,60}\bor[cç]amento\b|\bor[cç]amento\b.{0,60}\b(fechar|confirm|aprov|passou|recebi|ontem)\w*\b/i,
    evidence: /\br\$\s*\d/i
  },
  {
    type: "deadline",
    question:
      /\bqual\b.{0,25}\bprazo\b|\bquando\b.{0,30}\b(?:entrega|entregar|chega)\b|\b(?:consegue|conseguem|pode|podem|garante)\b.{0,45}\b(?:entregar|entrega|receber|prazo)\b|\bentrega\b.{0,45}\bsem falta\b|\bat[eé] quando\b/i,
    evidence: /\b\d+\s*(?:dias?|horas?)\b/i
  },
  {
    type: "technical_specification",
    question:
      /\b(aguenta|suporta|dimension\w*|carga|qual viga|espessura exata|capacidade|resist[eê]ncia)\b|\b(?:qual|quanto|calcular|calcula|informe|informar|saber|verificar)\b.{0,40}\b(?:peso|pesa)\b|\bpeso\s*\?/i,
    evidence:
      /\b(projeto|memorial|carga|dimensionamento|capacidade|respons[aá]vel t[eé]cnico)\b/i
  }
];

export function evaluateAgentSafety(input: {
  message: string;
  conversationHistory?: string | null;
  attachmentAvailable?: boolean;
  selectedKnowledge: Array<Pick<SelectedKnowledgeSource, "content">>;
}): AgentSafetyDecision {
  const message = input.message.trim().replace(/\s+/g, " ");
  const fullConversation = `${input.conversationHistory ?? ""}\n${message}`;

  if (PROMPT_INJECTION.test(message)) {
    // Supplied material changes only the recovery wording. It remains untrusted:
    // the deterministic response never forwards injected commands to the provider.
    const suppliedMaterial = input.attachmentAvailable === true || hasMinimumOrderDetails(fullConversation);
    return {
      ...decision("ignore_injection"),
      ...(suppliedMaterial ? { injectionRecovery: "request_clean_copy" as const } : {})
    };
  }

  if (HUMAN_REQUEST.test(message)) {
    return handoffDecision(null, "Customer requested human service.");
  }

  if (input.attachmentAvailable === false && ATTACHMENT_REFERENCE_ONLY.test(message)) {
    return decision("request_attachment");
  }

  if (hasAffirmedLoss(message) && !ADDITIONAL_REQUEST.test(message)) {
    return decision("close_loss");
  }

  if (BARE_PURCHASE.test(message)) {
    return decision("close_purchase");
  }

  if (APPROVAL_STATUS.test(message) && !ADDITIONAL_REQUEST.test(message)
    && !PROTECTED_RULES.some((rule) => rule.question.test(message.replace(/or[cç]amento/gi, "")))) {
    return decision("await_approval");
  }

  if (URGENT_REQUEST.test(message)) {
    if (!hasMinimumOrderDetails(fullConversation)) {
      return decision("qualify_urgent");
    }
    return handoffDecision("deadline", "Urgent delivery requires live confirmation.");
  }

  if (READY_DELIVERY_CONCEPT.test(message) && EXPLANATORY_QUESTION.test(message)) {
    return decision("continue");
  }

  if (READY_DELIVERY_CONCEPT.test(message)) {
    return handoffDecision("stock", "Ready-delivery availability requires live confirmation.");
  }

  const commercialText = removeMissingFieldMentions(message);
  const rule = PROTECTED_RULES.find((candidate) => candidate.question.test(commercialText));
  if (!rule) {
    return decision("continue");
  }

  const hasEvidence = input.selectedKnowledge.some((chunk) => rule.evidence.test(chunk.content));
  return hasEvidence
    ? { ...decision("continue"), protectedFact: rule.type }
    : handoffDecision(rule.type, `Missing ${rule.type} evidence.`);
}

export function createSafetyDecisionOutput(decisionValue: AgentSafetyDecision): AgentOutput | null {
  if (decisionValue.handoffRequired) {
    return createSafetyHandoffOutput(decisionValue.reason ?? "Human handoff required.");
  }

  const reply = decisionValue.outcome === "request_attachment"
    ? "O arquivo não apareceu aqui. Pode reenviar ou colar a lista na conversa?"
    : decisionValue.outcome === "close_loss"
    ? LOSS_ACKNOWLEDGEMENT
    : decisionValue.outcome === "close_purchase"
      ? PURCHASE_ACKNOWLEDGEMENT
    : decisionValue.outcome === "ignore_injection"
      ? decisionValue.injectionRecovery === "request_clean_copy" ? INJECTION_CLEAN_COPY_RECOVERY : INJECTION_RECOVERY
      : decisionValue.outcome === "qualify_urgent"
        ? URGENT_QUALIFICATION
        : null;

  return reply
    ? {
        confidence: 1,
        reply,
        actions: [],
        handoff: { required: false, reason: null }
      }
    : null;
}

export function createSafetyHandoffOutput(reason: string): AgentOutput {
  return {
    confidence: 0.2,
    reply: HANDOFF_ACKNOWLEDGEMENT,
    actions: [{ type: "request_handoff", reason }],
    handoff: { required: true, reason }
  };
}

function decision(outcome: Exclude<AgentSafetyOutcome, "handoff">): AgentSafetyDecision {
  return {
    handoffRequired: false,
    protectedFact: null,
    reason: null,
    outcome
  };
}

function handoffDecision(protectedFact: ProtectedFact | null, reason: string): AgentSafetyDecision {
  return {
    handoffRequired: true,
    protectedFact,
    reason,
    outcome: "handoff"
  };
}

function hasMinimumOrderDetails(value: string) {
  return PRODUCT_SIGNAL.test(value) && SPECIFICATION_SIGNAL.test(value) && QUANTITY_SIGNAL.test(value);
}

function hasAffirmedLoss(message: string) {
  // Scope negation to the matching clause, not to an unrelated earlier sentence.
  return message.split(/[.!?;\n]|\bmas\b/i).some((clause) => {
    const match = EXPLICIT_LOSS.exec(clause);
    if (!match) return false;
    // "Não vamos seguir" is itself an explicit loss, not a negated purchase.
    if (/^n[aã]o\s+(?:vou|vamos|iremos)\s+(?:seguir|prosseguir)\b/i.test(match[0])) return true;
    const prefix = clause.slice(0, match.index);
    return !/\b(?:n[aã]o|nunca|nem|se|caso)\b/i.test(prefix);
  });
}

function removeMissingFieldMentions(value: string) {
  return value
    .replace(/\b(?:prazo|entrega|local(?:\s+de\s+entrega)?)\b\s+n[aã]o\s+(?:consta|informad[oa]|definid[oa])/gi, "")
    .replace(/\bn[aã]o\s+(?:consta|foi\s+informad[oa]|est[aá]\s+definid[oa])\b.{0,20}\b(?:prazo|entrega|local)\b/gi, "");
}
