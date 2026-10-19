import { normalizeSearchText } from "./google-search-expansion.js";

export interface NearbyCitiesLookup {
  nearby(city: string, state: string): Promise<string[]>;
}

export interface NearbyCitiesOptions {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  endpoint?: string;
  cacheTtlMs?: number;
  requestTimeoutMs?: number;
}

interface Municipality {
  name: string;
  groupId: string;
}

const MAX_IBGE_RESPONSE_BYTES = 8 * 1024 * 1024;

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : typeof value === "number" ? String(value) : null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

// Aceita o formato "nivelado" e o formato aninhado da API de localidades do IBGE.
export function parseIbgeMunicipalities(payload: unknown): Municipality[] {
  if (!Array.isArray(payload)) return [];
  const result: Municipality[] = [];
  for (const entry of payload) {
    const row = record(entry);
    const name = text(row["municipio-nome"]) ?? text(row.nome);
    const groupId = text(row["regiao-imediata-id"]) ??
      text(record(row["regiao-imediata"]).id) ??
      text(row["microrregiao-id"]) ??
      text(record(row.microrregiao).id);
    if (name && groupId) result.push({ name, groupId });
  }
  return result;
}

// Cidades da mesma região geográfica imediata do IBGE (as vizinhas que formam o mesmo polo).
export function createNearbyCitiesLookup(options: NearbyCitiesOptions = {}): NearbyCitiesLookup {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const endpoint = options.endpoint ?? "https://servicodados.ibge.gov.br/api/v1/localidades/estados";
  const cacheTtlMs = options.cacheTtlMs ?? 24 * 60 * 60 * 1_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  const cache = new Map<string, { expiresAt: number; value: Municipality[] }>();

  async function municipalities(state: string) {
    const cached = cache.get(state);
    if (cached && cached.expiresAt > now()) return cached.value;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    timeout.unref?.();
    try {
      const url = new URL(`${endpoint.replace(/\/+$/, "")}/${encodeURIComponent(state)}/municipios`);
      url.searchParams.set("view", "nivelado");
      const response = await fetchImpl(url, { headers: { accept: "application/json" }, signal: controller.signal });
      if (!response.ok) throw new Error(`IBGE returned HTTP ${response.status}.`);
      const body = await response.text();
      if (body.length > MAX_IBGE_RESPONSE_BYTES) throw new Error("IBGE response exceeded the safe size limit.");
      const value = parseIbgeMunicipalities(JSON.parse(body) as unknown);
      if (value.length === 0) throw new Error("IBGE returned no municipalities.");
      cache.set(state, { expiresAt: now() + cacheTtlMs, value });
      return value;
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    async nearby(cityInput: string, stateInput: string) {
      const state = stateInput.trim().toUpperCase();
      if (!/^[A-Z]{2}$/.test(state)) return [];
      const city = normalizeSearchText(cityInput);
      const all = await municipalities(state);
      const own = all.find((entry) => normalizeSearchText(entry.name) === city);
      if (!own) return [];
      return all
        .filter((entry) => entry.groupId === own.groupId && normalizeSearchText(entry.name) !== city)
        .map((entry) => entry.name);
    }
  };
}
