import type { MessageDto } from "@prymeira-talk/shared";

export type HandoffBrief = {
  customerContext: string | null;
  lastReply: string | null;
  reason: string;
  nextStep: string;
};

const knownReasons: Record<string, { reason: string; nextStep: string }> = {
  commercial_policy_risk: {
    reason: "A informação comercial solicitada precisa ser confirmada por uma pessoa antes de virar uma resposta ao cliente.",
    nextStep: "Confirme o pedido e as condições comerciais com a equipe responsável. Depois, responda ao cliente com os dados verificados."
  },
  plan_mismatch: {
    reason: "A resposta preparada pela IA não seguiu a etapa atual da conversa.",
    nextStep: "Revise o pedido e as respostas anteriores. Continue a conversa com a próxima informação correta."
  },
  possible_automation_loop: {
    reason: "O fluxo automático poderia repetir mensagens ou ações.",
    nextStep: "Confira as últimas mensagens e assuma a resposta para evitar repetição."
  }
};

function compactText(value: string | null, limit: number) {
  const normalized = value?.replace(/\s+/g, " ").trim() ?? "";
  if (!normalized) return null;
  return normalized.length > limit ? `${normalized.slice(0, limit - 1).trimEnd()}…` : normalized;
}

export function buildHandoffBrief(
  handoffReason: string | null | undefined,
  messages: Pick<MessageDto, "direction" | "body" | "type" | "sentByUserId">[]
): HandoffBrief {
  const reasonCode = handoffReason?.trim() ?? "";
  const known = knownReasons[reasonCode];
  const customerMessages = messages
    .filter((message) => message.direction === "inbound")
    .slice(-3)
    .map((message) => compactText(message.body, 280) ?? (message.type === "image" ? "Enviou uma imagem; confira o anexo na conversa." : "Enviou um anexo; confira-o na conversa."));
  const agentReply = [...messages].reverse().find((message) =>
    message.direction === "outbound" && message.sentByUserId == null && Boolean(message.body?.trim())
  );

  return {
    customerContext: customerMessages.length ? compactText(customerMessages.join(" · "), 700) : null,
    lastReply: compactText(agentReply?.body ?? null, 320),
    reason: known?.reason ?? (reasonCode && !/^[a-z_]+$/.test(reasonCode)
      ? reasonCode
      : "O agente solicitou que uma pessoa continue este atendimento."),
    nextStep: known?.nextStep ?? "Revise o pedido e responda ao cliente com as informações confirmadas."
  };
}
