export function normalizePhoneForStorage(value: string) {
  return canonicalizePhone(value);
}

export function canonicalizePhone(value: string) {
  const digits = value.replace(/\D/g, "");

  if (digits.startsWith("55") && digits.length === 13 && digits[4] === "9") {
    return `${digits.slice(0, 4)}${digits.slice(5)}`;
  }

  return digits;
}

export function buildPhoneLookupCandidates(value: string) {
  const digits = value.replace(/\D/g, "");
  const canonical = canonicalizePhone(value);
  const candidates = new Set<string>([canonical]);

  if (digits.length > 0) {
    candidates.add(digits);
  }

  if (canonical.startsWith("55") && canonical.length === 12) {
    candidates.add(`${canonical.slice(0, 4)}9${canonical.slice(4)}`);
  }

  return Array.from(candidates);
}
