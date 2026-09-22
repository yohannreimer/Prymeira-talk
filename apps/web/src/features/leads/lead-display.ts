import type { LeadJobStatus, LeadListDto, LeadWhatsappStatus, SimilarCompanyResult } from "@prymeira-talk/shared";

export function formatCnpj(value: string | null | undefined) {
  if (!value) return "CNPJ não informado";
  const clean = value.replace(/[^0-9A-Z]/gi, "").toUpperCase();
  return clean.length === 14 ? `${clean.slice(0, 2)}.${clean.slice(2, 5)}.${clean.slice(5, 8)}/${clean.slice(8, 12)}-${clean.slice(12)}` : value;
}

export const jobLabels: Record<LeadJobStatus, string> = {
  queued: "Na fila", running: "Em andamento", completed: "Concluído", partial: "Parcial", failed: "Falhou"
};

export const whatsappLabels: Record<LeadWhatsappStatus, string> = {
  unverified: "Não verificado", checking: "Verificando", available: "Disponível", unavailable: "Indisponível", failed: "Falha na verificação"
};

export function scoreReasons(item: Pick<SimilarCompanyResult, "reasons">) {
  return item.reasons.map(reason => `${reason.label} (+${reason.points})`);
}

export function listProgressLabel(list: Pick<LeadListDto, "startedAt" | "completedAt" | "failedCount">) {
  if (list.completedAt) return list.failedCount ? "Parcial" : "Concluída";
  return list.startedAt ? "Em andamento" : "Na fila";
}
