/** The fields a quick reply can carry, written as {primeiro_nome}. Older templates used {{company}}: still understood. */
export const TEMPLATE_FIELDS = [
  { key: "saudacao", label: "Saudação", example: "Boa tarde" },
  { key: "primeiro_nome", label: "Primeiro nome", example: "Jackson" },
  { key: "nome", label: "Nome completo", example: "Jackson Cappelli" },
  { key: "empresa", label: "Empresa", example: "Construtora Alfa" },
  { key: "vendedor", label: "Seu nome", example: "Junior" }
] as const;
export type TemplateFieldKey = typeof TEMPLATE_FIELDS[number]["key"];
export type TemplateValues = Partial<Record<TemplateFieldKey, string | null>>;

const ALIASES: Record<string, TemplateFieldKey> = {
  saudacao: "saudacao", primeironome: "primeiro_nome", primeiro_nome: "primeiro_nome", firstname: "primeiro_nome", first_name: "primeiro_nome",
  nome: "nome", name: "nome", nomecompleto: "nome", empresa: "empresa", company: "empresa", vendedor: "vendedor", seunome: "vendedor", seller: "vendedor"
};
const TOKEN = /\{\{?\s*([\p{L}_ ]{2,30}?)\s*\}?\}/gu;
const fold = (value: string) => value.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase().replace(/\s+/g, "_");
function fieldOf(raw: string): TemplateFieldKey | null {
  const key = fold(raw);
  return ALIASES[key] ?? ALIASES[key.replace(/_/g, "")] ?? null;
}

/** "{primeiro_nome}" → "Primeiro nome" (unknown braces keep their text). */
export function fieldLabel(token: string) {
  const field = fieldOf(token.replace(/[{}]/g, ""));
  return field ? TEMPLATE_FIELDS.find(item => item.key === field)!.label : token.replace(/[{}]/g, "");
}

/** The fields a body uses, so the composer only asks for the contact's name when it is needed. */
export function templateFields(body: string): TemplateFieldKey[] {
  const fields = new Set<TemplateFieldKey>();
  for (const match of body.matchAll(TOKEN)) { const field = fieldOf(match[1]!); if (field) fields.add(field); }
  return [...fields];
}
export const usesContactFields = (body: string) => templateFields(body).some(field => field === "primeiro_nome" || field === "nome" || field === "empresa");

export function greeting(date = new Date()) {
  const hour = date.getHours();
  return hour < 12 ? "Bom dia" : hour < 18 ? "Boa tarde" : "Boa noite";
}

/**
 * Fills the fields. One that has no value disappears and the sentence stays clean: "Olá, {primeiro_nome}!" becomes
 * "Olá!", never "Olá, !". Returns which fields were missing so the composer can point them out.
 */
export function renderTemplate(body: string, values: TemplateValues) {
  const missing = new Set<TemplateFieldKey>();
  let text = body.replace(TOKEN, (whole, raw: string) => {
    const field = fieldOf(raw);
    if (!field) return whole;
    const value = values[field]?.trim();
    if (value) return value;
    missing.add(field);
    return "\u0000";
  });
  if (missing.size) {
    text = text
      .replace(/(^|\n)[ \t]*\u0000[ \t]*,?[ \t]*/g, "$1")       // "X, tudo bem?" at a line start → "tudo bem?"
      .replace(/[ \t]*,?[ \t]*\u0000[ \t]*(?=[,.!?;:])/g, "")   // "Olá, X!" → "Olá!"
      .replace(/[ \t]*\u0000[ \t]*/g, " ")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/ +([,.!?;:])/g, "$1")
      .replace(/,\s*,/g, ",")
      .replace(/(^|\n)([a-zà-ú])/g, (_all, start: string, letter: string) => start + letter.toLocaleUpperCase("pt-BR"))
      .trim();
  }
  return { text, missing: [...missing] };
}
