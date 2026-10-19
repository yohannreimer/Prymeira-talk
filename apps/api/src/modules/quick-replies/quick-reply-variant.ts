import { createHash } from "node:crypto";
import type { AgentProvider } from "../agents/provider-gateway.js";

/** The contact fields a quick reply may lack (the greeting and the seller's name are always known). */
export const CONTACT_FIELDS = ["primeiro_nome", "nome", "empresa"] as const;
export type ContactField = typeof CONTACT_FIELDS[number];

const ALIASES: Record<string, string> = {
  saudacao: "saudacao", primeironome: "primeiro_nome", primeiro_nome: "primeiro_nome", firstname: "primeiro_nome", first_name: "primeiro_nome",
  nome: "nome", name: "nome", nomecompleto: "nome", empresa: "empresa", company: "empresa", vendedor: "vendedor", seunome: "vendedor", seller: "vendedor"
};
const TOKEN = /\{\{?\s*([\p{L}_ ]{2,30}?)\s*\}?\}/gu;
const fold = (value: string) => value.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase().replace(/\s+/g, "_");
const fieldOf = (raw: string) => { const key = fold(raw); return ALIASES[key] ?? ALIASES[key.replace(/_/g, "")] ?? null; };
/** The known fields a body uses, as the same keys the composer fills. */
export function bodyFields(body: string) {
  return new Set([...body.matchAll(TOKEN)].map(match => fieldOf(match[1]!)).filter((field): field is string => Boolean(field)));
}

export const variantKey = (missing: readonly string[]) => [...new Set(missing)].sort().join("+");
export const bodyHash = (body: string) => createHash("sha256").update(body).digest("hex").slice(0, 16);

const SYSTEM_PROMPT = [
  "Você ajusta um modelo de mensagem de WhatsApp de um vendedor para quando faltam dados do cliente.",
  "O modelo usa campos entre chaves, como {saudacao}, {primeiro_nome}, {nome}, {empresa} e {vendedor}.",
  "Reescreva o modelo SEM os campos indicados como ausentes, de modo que a frase continue natural, educada e bem escrita em português do Brasil.",
  "Mantenha exatamente como estão os outros campos entre chaves, o sentido, o tom, a formatação (*negrito*, quebras de linha, emojis) e um tamanho parecido.",
  "Não invente nome, empresa nem nenhum dado. Não acrescente informações novas.",
  "Responda APENAS com JSON no campo reply: {\"body\":\"...\"}."
].join("\n");

/** Accepts the AI's rewrite only if it drops the missing fields, keeps no field the original did not have and is not empty. */
export function acceptVariant(original: string, missing: readonly string[], output: unknown): string | null {
  const body = output && typeof output === "object" && typeof (output as { body?: unknown }).body === "string" ? (output as { body: string }).body.trim() : "";
  if (!body || body.length > 4000) return null;
  const allowed = bodyFields(original);
  for (const field of bodyFields(body)) if (missing.includes(field) || !allowed.has(field)) return null;
  // A rewrite that lost every word of the original is not the same message.
  const words = (text: string) => new Set(fold(text.replace(TOKEN, " ")).split(/[^\p{L}\p{N}]+/u).filter(word => word.length > 3));
  const before = words(original); const after = words(body);
  if (before.size >= 3 && [...before].filter(word => after.has(word)).length < Math.ceil(before.size / 3)) return null;
  return body;
}

export async function generateVariant(original: string, missing: readonly string[], ai: { provider: Pick<AgentProvider, "generate">; model: string }, timeoutMs = 12_000) {
  const result = await Promise.race([
    ai.provider.generate({ model: ai.model, systemPrompt: SYSTEM_PROMPT, userPrompt: "Reescreva o modelo sem os campos ausentes.",
      context: { modelo: original, camposAusentes: missing.map(field => `{${field}}`) }, reasoningEffort: "none" }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("VARIANT_TIMEOUT")), timeoutMs))
  ]);
  let output: unknown = null;
  try { output = JSON.parse(result.reply ?? "null"); } catch { return null; }
  return acceptVariant(original, missing, output);
}
