const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;
const NAME_KEYS = new Set(["nome", "name"]);

export type RenderContact = { phone: string; fields: Record<string, string> };

export function tidyRenderedText(text: string) {
  return text
    .replace(/,\s*([!?.])/g, "$1")
    .replace(/[ \t]+([,.!?:;])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/^[ \t]+|[ \t]+$/gm, "")
    .replace(/^[,;:]\s*(\S)/gm, (_, first: string) => first.toUpperCase())
    .trim();
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
}) {
  const name = input.firstName?.trim() || implicitOrBlank(input.explicitFallbackName);
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
    if (NAME_KEYS.has(key) && !value) blankedName = true;
    return value;
  });
  return blankedName ? tidyRenderedText(rendered) : rendered;
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
