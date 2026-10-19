import type { PurchaseInviteStatus, PurchaseRequestStatus, PurchaseRequestSummaryDto } from "@prymeira-talk/shared";

export function money(cents: number | null | undefined, options: { compact?: boolean } = {}) {
  if (cents === null || cents === undefined) return "—";
  const value = cents / 100;
  return value.toLocaleString("pt-BR", {
    style: "currency", currency: "BRL",
    minimumFractionDigits: options.compact && Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2
  });
}

/** "845", "845,5", "1.234,56", "R$ 1234.56" → cents. Null when it is not a number. */
export function parseMoney(input: string): number | null {
  let text = input.replace(/[R$\s]/g, "");
  if (!text) return null;
  if (text.includes(",")) text = text.replace(/\./g, "").replace(",", ".");
  else if (/^\d{1,3}(\.\d{3})+$/.test(text)) text = text.replace(/\./g, "");
  const value = Number(text);
  return Number.isFinite(value) && value >= 0 ? Math.round(value * 100) : null;
}

export function moneyInputValue(cents: number | null | undefined) {
  if (cents === null || cents === undefined) return "";
  return (cents / 100).toLocaleString("pt-BR", { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 });
}

export function shortDate(iso: string | null | undefined) {
  if (!iso) return "—";
  const [year, month, day] = iso.slice(0, 10).split("-");
  return `${day}/${month}${year && year !== String(new Date().getFullYear()) ? `/${year.slice(2)}` : ""}`;
}

export function todayIso() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

export function addDaysIso(iso: string, days: number) {
  const date = new Date(`${iso}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function daysUntil(iso: string, from = todayIso()) {
  return Math.round((Date.parse(`${iso.slice(0, 10)}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
}

/** "vence hoje", "vence amanhã", "vence em 3 dias", "venceu há 2 dias". */
export function deadlineLabel(iso: string, verb = "vence") {
  const days = daysUntil(iso);
  if (days === 0) return `${verb} hoje`;
  if (days === 1) return `${verb} amanhã`;
  if (days > 1) return `${verb} em ${days} dias`;
  return `${verb === "vence" ? "venceu" : verb} há ${-days} ${days === -1 ? "dia" : "dias"}`;
}

export function relativeTime(iso: string) {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "agora";
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `há ${hours} h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `há ${days} ${days === 1 ? "dia" : "dias"}`;
  return shortDate(iso);
}

export type Tone = "green" | "amber" | "violet" | "gray" | "red" | "blue";

export function requestStage(request: Pick<PurchaseRequestSummaryDto, "status" | "needsDecision">): { label: string; tone: Tone } {
  if (request.needsDecision) return { label: "Aguardando você", tone: "amber" };
  const map: Record<PurchaseRequestStatus, { label: string; tone: Tone }> = {
    draft: { label: "Rascunho", tone: "gray" },
    quoting: { label: "Cotando", tone: "green" },
    awaiting_approval: { label: "Aguardando você", tone: "amber" },
    approved: { label: "Aprovado", tone: "blue" },
    completed: { label: "Concluído", tone: "gray" },
    canceled: { label: "Cancelado", tone: "red" }
  };
  return map[request.status];
}

export const inviteStage: Record<PurchaseInviteStatus, { label: string; tone: Tone }> = {
  queued: { label: "Na fila", tone: "gray" },
  sent: { label: "Mensagem enviada", tone: "blue" },
  replied: { label: "Respondeu", tone: "green" },
  no_response: { label: "Sem resposta", tone: "gray" },
  declined: { label: "Não vai cotar", tone: "red" },
  quote_received: { label: "Proposta recebida", tone: "green" },
  negotiating: { label: "Choradinha", tone: "violet" },
  winner: { label: "Vencedor", tone: "blue" },
  lost: { label: "Não ganhou", tone: "gray" }
};

export function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

export function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts.at(-1)![0] : parts[0]?.[1] ?? "")).toUpperCase();
}

export function formatPhone(phone: string) {
  const digits = phone.replace(/\D/g, "").replace(/^55(?=\d{10,11}$)/, "");
  if (digits.length === 11) return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
  if (digits.length === 10) return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
  return phone;
}

export function formatCep(cep: string) {
  const digits = cep.replace(/\D/g, "");
  return digits.length === 8 ? `${digits.slice(0, 5)}-${digits.slice(5)}` : cep;
}

export function quantity(value: number) {
  return value.toLocaleString("pt-BR", { maximumFractionDigits: 3 });
}
