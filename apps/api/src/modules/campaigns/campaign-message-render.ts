const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;
const NAME_KEYS = new Set(["nome", "name"]);

export type RenderContact = { phone: string; fields: Record<string, string> };

// Private marker for a name placeholder that resolved to empty. Cleanup only
// ever happens around this marker, so the rest of the template is untouched.
const BLANK = "\u0000";

function capitalizeFirst(text: string) {
  return text.replace(/^\p{Ll}/u, (letter) => letter.toUpperCase());
}

function resolveBlankNames(text: string) {
  let result = text;
  for (let pass = 0; pass < 3 && result.includes(BLANK); pass += 1) {
    result = result
      // (1) "Olá, {{nome}}, tudo bem?" -> "Olá, tudo bem?"
      .replace(/(\S)[ \t]*,[ \t]*\u0000[ \t]*,/g, "$1,")
      // (2) "Oi {{nome}}!" / "Olá, {{nome}}!" -> "Oi!" / "Olá!"
      .replace(/(\S)[ \t]*(?:,[ \t]*)?\u0000[ \t]*([!?.])/g, "$1$2")
      // (3) "Olá {{nome}}, tudo bem?" -> "Olá, tudo bem?"
      .replace(/(\S)[ \t]*\u0000[ \t]*,/g, "$1,")
      // (4) "{{nome}}, tudo bem?" at the start of a line -> "Tudo bem?"
      .replace(/^([ \t]*)\u0000[ \t]*[,!]?[ \t]*([^\n]*)/gm, (_, indent: string, rest: string) => indent + capitalizeFirst(rest))
      // (5) "Oi {{nome}}" / "Olá, {{nome}}" at the end of a line -> "Oi" / "Olá"
      .replace(/(?:[ \t]*,)?[ \t]*\u0000[ \t]*$/gm, "")
      // (6) between words -> a single space
      .replace(/[ \t]*\u0000[ \t]*/g, " ");
  }
  return result.split(BLANK).join("");
}

function implicitOrBlank(value: string | undefined) {
  const trimmed = value?.trim() ?? "";
  return !trimmed || trimmed.toLowerCase() === "cliente" ? "" : trimmed;
}

export function renderCampaignMessage(input: {
  template: string;
  contact: RenderContact;
  firstName: string | null;
  explicitFallbackName?: string;
  /** Meta template parameters can never be empty: fall back to the explicit name or "cliente". */
  keepDefaultFallback?: boolean;
}) {
  const name = input.firstName?.trim() || (input.keepDefaultFallback
    ? input.explicitFallbackName?.trim() || "cliente"
    : implicitOrBlank(input.explicitFallbackName));
  const values: Record<string, string> = {
    ...input.contact.fields,
    name,
    nome: name,
    phone: input.contact.phone,
    telefone: input.contact.phone
  };
  let blankedName = false;
  const rendered = input.template.replace(PLACEHOLDER, (_, key: string) => {
    const value = values[key] ?? "";
    if (NAME_KEYS.has(key) && !value) {
      blankedName = true;
      return BLANK;
    }
    return value;
  });
  return blankedName ? resolveBlankNames(rendered) : rendered;
}

export function findUnresolvedVariables(template: string, contact: RenderContact) {
  const values: Record<string, string> = {
    ...contact.fields,
    phone: contact.phone,
    telefone: contact.phone
  };
  const missing = new Set<string>();
  for (const match of template.matchAll(PLACEHOLDER)) {
    const key = match[1]!;
    if (NAME_KEYS.has(key)) continue;
    if (!values[key]?.trim()) missing.add(key);
  }
  return [...missing].sort();
}
