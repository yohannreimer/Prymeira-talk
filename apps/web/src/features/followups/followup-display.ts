import type {
  ConversationFollowupDto,
  ConversationFollowupKind,
  ConversationFollowupStatus
} from "@prymeira-talk/shared";
import type { FollowupListStatus } from "../../app/api";

const terminalCancelledStatuses = new Set<ConversationFollowupStatus>([
  "cancelled",
  "failed",
  "skipped",
  "expired"
]);

const reasonLabels: Record<string, string> = {
  customer_replied: "O cliente respondeu antes do acompanhamento.",
  outbound_replaced: "A equipe retomou a conversa por outro caminho.",
  conversation_closed: "A conversa foi encerrada.",
  channel_paused: "Os follow-ups deste número foram pausados.",
  handoff_active: "O atendimento passou para uma pessoa da equipe.",
  manual_cancelled: "Cancelado pela equipe.",
  not_interested: "O cliente informou que não tem interesse.",
  wrong_contact: "O contato não corresponde ao atendimento.",
  duplicate: "Este acompanhamento estava duplicado.",
  other: "Cancelado pela equipe.",
  no_followup: "Marcado para não acompanhar novamente.",
  manual_postponed: "Adiado pela equipe.",
  manual_delivery_uncertain: "O provedor pode ter recebido a mensagem; o reenvio foi bloqueado por segurança.",
  delivery_completion_failed: "A entrega foi confirmada, mas houve falha ao concluir o registro.",
  max_steps_reached: "A sequência de acompanhamentos configurada foi concluída.",
  followup_not_needed: "O contexto não pede um novo contato.",
  jev_skip: "A análise indicou que não é necessário acompanhar agora.",
  jev_human_review: "A análise indicou revisão humana antes do contato.",
  automatic_delivery_not_allowed: "Este acompanhamento exige confirmação humana antes do envio.",
  history_requires_review: "O histórico precisa de revisão humana antes de continuar.",
  conversation_context_limit: "O histórico precisa de revisão humana antes de continuar.",
  manual_send_failed: "O envio não foi concluído. Revise a mensagem antes de tentar novamente.",
  jev_followup_decision_unavailable: "A análise do acompanhamento está temporariamente indisponível.",
  reply_preflight_unavailable: "A validação da resposta está temporariamente indisponível.",
  reply_audit_unavailable: "A auditoria da resposta está temporariamente indisponível.",
  outbound_delivery_unconfirmed: "A entrega da mensagem ainda não foi confirmada.",
  agent_unavailable: "O agente responsável não está disponível; revisão humana necessária.",
  context_unavailable: "O contexto da conversa não está disponível; revisão humana necessária.",
  handoff_required: "A resposta gerada exige atendimento humano.",
  provider_reply_missing: "O provedor não gerou uma resposta para revisão.",
  audit_blocked: "A auditoria de segurança bloqueou o envio automático."
};

export function followupKindLabel(kind: ConversationFollowupKind) {
  return kind === "qualification" ? "Qualificação" : "Comercial humano";
}
export function followupStatusLabel(status: ConversationFollowupStatus) {
  const labels: Record<ConversationFollowupStatus, string> = {
    evaluating: "Em análise",
    scheduled: "Agendado",
    processing: "Processando",
    review: "Para revisar",
    sent: "Enviado",
    cancelled: "Cancelado",
    skipped: "Dispensado",
    expired: "Concluído",
    failed: "Requer atenção"
  };
  return labels[status];
}

export function followupPurposeLabel(followup: ConversationFollowupDto) {
  const labels = {
    missing_qualification: "Completar dados da qualificação",
    proposal_checkin: "Retomar proposta enviada",
    objection_help: "Ajudar com uma objeção",
    confirm_active: "Retomar próximo passo do cliente"
  } as const;

  if (!followup.purpose || followup.purpose === "none") return "Continuidade da conversa";
  return labels[followup.purpose];
}

export function followupStepLabel(stepIndex: number) {
  return `Etapa ${Math.max(1, stepIndex)}`;
}

export function followupReasonLabel(
  reason: string | null | undefined,
  status?: ConversationFollowupStatus
) {
  if (!reason) {
    if (status === "review") return "Revisão humana necessária antes de continuar.";
    if (status === "scheduled") return "Aguardando o horário previsto para o próximo acompanhamento.";
    if (status === "processing") return "Acompanhamento em processamento.";
    return null;
  }
  return reasonLabels[reason] ?? "O acompanhamento foi encerrado após uma mudança no contexto.";
}

export function followupMoment(followup: ConversationFollowupDto) {
  if (followup.status === "sent") return followup.sentAt;
  if (followup.status === "cancelled") return followup.cancelledAt;
  if (terminalCancelledStatuses.has(followup.status)) return followup.updatedAt;
  return followup.scheduledAt;
}

export function formatFollowupDate(
  value: string,
  options: { locale?: string; timeZone?: string; now?: Date } = {}
) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Data indisponível";

  const locale = options.locale ?? "pt-BR";
  const timeZone = options.timeZone ?? "America/Sao_Paulo";
  const now = options.now ?? new Date();
  const day = new Intl.DateTimeFormat(locale, {
    timeZone,
    day: "2-digit",
    month: "short"
  }).format(date);
  const time = new Intl.DateTimeFormat(locale, {
    timeZone,
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
  const year = new Intl.DateTimeFormat(locale, { timeZone, year: "numeric" }).format(date);
  const currentYear = new Intl.DateTimeFormat(locale, { timeZone, year: "numeric" }).format(now);

  return `${day}${year === currentYear ? "" : ` de ${year}`} às ${time}`;
}

export function matchesFollowupFilter(
  followup: ConversationFollowupDto,
  filter: FollowupListStatus
) {
  if (filter === "cancelled") {
    return terminalCancelledStatuses.has(followup.status) &&
      !("reason" in followup && followup.reason.startsWith("eligibility_"));
  }
  return followup.status === filter;
}
