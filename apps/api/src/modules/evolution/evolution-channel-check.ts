import type { EvolutionConnectionState } from "./evolution.client.js";

export interface InstanceSummary {
  name: string;
  owner: string | null;
  listState: string | null;
}

export interface WebhookConfig {
  url: string | null;
  enabled: boolean | null;
  events: string[];
}

export interface RequestFailure {
  step: string;
  status: number | null;
}

export interface ChannelCheckRow {
  name: string;
  owner: string | null;
  clientState: EvolutionConnectionState | null;
  listState: string | null;
  /** null when the webhook endpoint returned nothing usable. */
  webhook: WebhookConfig | null;
  failures: RequestFailure[];
}

export interface ChannelReport {
  text: string;
  warnings: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstString(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return null;
}

function toInstance(item: unknown): InstanceSummary | null {
  if (!isRecord(item)) return null;
  const source = isRecord(item.instance) ? item.instance : item;
  const name = firstString(source, ["instanceName", "name"]);
  if (!name) return null;
  const ownerRaw = firstString(source, ["ownerJid", "owner", "number"]);
  return {
    name,
    owner: ownerRaw ? ownerRaw.split("@")[0]!.replace(/\D/g, "") || null : null,
    listState: firstString(source, ["connectionStatus", "state", "status"])
  };
}

/** Tolerant: array of instances, array of `{ instance }`, or an object wrapping either. */
export function parseInstanceList(body: unknown): InstanceSummary[] {
  let items: unknown[] = [];
  if (Array.isArray(body)) items = body;
  else if (isRecord(body)) {
    const wrapped = ["data", "instances", "response", "result"].map((k) => body[k]).find(Array.isArray);
    if (wrapped) items = wrapped as unknown[];
  }
  return items.flatMap((item) => {
    const parsed = toInstance(item);
    return parsed ? [parsed] : [];
  });
}

export function reduceUrlToHostAndPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    const path = url.pathname === "/" ? "" : url.pathname;
    return `${url.host}${path}`;
  } catch {
    return null;
  }
}

function hostOf(value: unknown): string | null {
  const reduced = reduceUrlToHostAndPath(value);
  return reduced ? reduced.split("/")[0]! : null;
}

export function maskNumber(value: string | null | undefined): string | null {
  const digits = (value ?? "").split("@")[0]!.replace(/\D/g, "");
  return digits.length >= 4 ? `…${digits.slice(-4)}` : null;
}

export function parseWebhookConfig(body: unknown): WebhookConfig | null {
  if (!isRecord(body)) return null;
  const source = isRecord(body.webhook) ? body.webhook : body;
  const url = typeof source.url === "string" && source.url.trim() !== "" ? source.url.trim() : null;
  const enabled = typeof source.enabled === "boolean" ? source.enabled : null;
  const events = Array.isArray(source.events)
    ? source.events.filter((e): e is string => typeof e === "string")
    : [];
  if (url === null && enabled === null && events.length === 0) return null;
  return { url, enabled, events };
}

function pad(value: string, width: number) {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function mostCommonHost(rows: ChannelCheckRow[]): string | null {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const host = hostOf(row.webhook?.url);
    if (host) counts.set(host, (counts.get(host) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [host, count] of counts) {
    if (count > bestCount) {
      best = host;
      bestCount = count;
    }
  }
  return best;
}

function stateLabel(state: string | null) {
  return state ?? "desconhecido";
}

function failureText(failure: RequestFailure) {
  return `${failure.step} (status ${failure.status ?? "sem resposta"})`;
}

export function buildChannelReport(rows: ChannelCheckRow[], globalFailures: RequestFailure[] = []): ChannelReport {
  const header = ["Instância", "Número", "Estado (cliente)", "Estado (lista)", "Webhook ativo", "Webhook"];
  const body = rows.map((row) => {
    const listDiffers = row.listState !== null && row.listState !== row.clientState;
    const hook = row.webhook;
    return [
      row.name,
      maskNumber(row.owner) ?? "-",
      stateLabel(row.clientState),
      listDiffers ? row.listState! : "-",
      hook?.enabled === true ? "sim" : hook?.enabled === false ? "não" : "-",
      reduceUrlToHostAndPath(hook?.url) ?? "-"
    ];
  });
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((r) => r[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => pad(c, widths[i]!)).join("  ").trimEnd();

  const counts = new Map<string, number>();
  for (const row of rows) counts.set(stateLabel(row.clientState), (counts.get(stateLabel(row.clientState)) ?? 0) + 1);
  const summary = `Resumo: ${rows.length} instância(s) — ${
    [...counts].map(([state, count]) => `${state}: ${count}`).join(", ") || "nenhuma"
  }`;

  const commonHost = mostCommonHost(rows);
  const warnings: string[] = [];
  for (const failure of globalFailures) warnings.push(`Falha na requisição: ${failureText(failure)}`);
  for (const row of rows) {
    if (row.clientState !== "open") {
      warnings.push(`Instância "${row.name}" não está open (estado: ${stateLabel(row.clientState)}).`);
    }
    if (!row.webhook || !row.webhook.url) {
      warnings.push(`Instância "${row.name}" está sem webhook configurado.`);
    } else if (row.webhook.enabled === false) {
      warnings.push(`Instância "${row.name}" tem webhook desativado.`);
    } else if (commonHost && hostOf(row.webhook.url) !== commonHost) {
      warnings.push(
        `Instância "${row.name}" aponta o webhook para outro host (${hostOf(row.webhook.url) ?? "inválido"}; mais comum: ${commonHost}).`
      );
    }
    for (const failure of row.failures) {
      warnings.push(`Falha na requisição da instância "${row.name}": ${failureText(failure)}`);
    }
  }

  const text = [line(header), ...body.map(line), "", summary].join("\n");
  return { text, warnings };
}
