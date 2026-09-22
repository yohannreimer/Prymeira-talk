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
  handoff_active: "O atendimento passou para uma pessoa da equipe.",
  manual_cancelled: "Cancelado pela equipe.",
  not_interested: "O cliente informou que não tem interesse.",
  wrong_contact: "O contato não corresponde ao atendimento.",
  duplicate: "Este acompanhamento estava duplicado.",
  other: "Cancelado pela equipe.",
  no_followup: "Marcado para não acompanhar novamente.",
  manual_postponed: "Adiado pela equipe.",
  manual_send_failed: "O envio não foi concluído. Revise antes de tentar novamente.",
  manual_delivery_uncertain: "O provedor pode ter recebido a mensagem; o reenvio foi bloqueado por segurança.",
  delivery_completion_failed: "A entrega foi confirmada, mas houve falha ao concluir o registro.",
  history_requires_review: "O histórico precisa de revisão humana.",
  max_steps_reached: "A sequência de três acompanhamentos foi concluída.",
  followup_not_needed: "O contexto não pede um novo contato.",
  jev_skip: "A análise indicou que não é necessário acompanhar agora."
};

export function followupKindLabel(kind: ConversationFollowupKind) {
  return kind === "qualification" ? "Qualificação" : "Comercial humano";
}
export function followupStatusLabel(status: ConversationFollowupStatus) {
  const labels: Record<ConversationFollowupStatus, string> = {
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
  if (followup.kind === "human_commercial") {
    return followup.stepIndex <= 0
      ? "Retomar proposta ou negociação"
      : "Confirmar continuidade comercial";
  }

  if (followup.stepIndex <= 0) return "Retomar dados da qualificação";
  if (followup.stepIndex === 1) return "Confirmar se o atendimento continua ativo";
  return "Última tentativa de qualificação";
}

export function followupStepLabel(stepIndex: number) {
  return `Etapa ${Math.max(0, stepIndex) + 1} de 3`;
}

export function followupReasonLabel(reason: string | null | undefined) {
  if (!reason) return null;
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
  if (filter === "cancelled") return terminalCancelledStatuses.has(followup.status);
  return followup.status === filter;
}
