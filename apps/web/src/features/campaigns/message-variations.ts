export function placeholdersOf(text: string) {
  return [...new Set([...text.matchAll(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g)].map((m) => m[1]!))].sort();
}

export function missingPlaceholders(original: string, variation: string) {
  const present = new Set(placeholdersOf(variation));
  return placeholdersOf(original).filter((key) => !present.has(key));
}

export function buildTemplates(message: string, variations: string[]) {
  return [message.trim(), ...variations.map((text) => text.trim()).filter(Boolean)]
    .filter(Boolean).slice(0, 6);
}
