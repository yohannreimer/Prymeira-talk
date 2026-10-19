import { canonicalizePhone } from "../contacts/phone-normalization.js";

export type WhatsappPhoneCandidates = {
  key: string;
  primary: string;
  alternate: string | null;
};

export function whatsappPhoneCandidates(value: string): WhatsappPhoneCandidates | null {
  const digits = value.replace(/\D/g, "");
  const brazilianAreaCode = /^[1-9]\d$/.test(digits.slice(0, 2));
  const localBrazilianMobile = digits.length === 11 && brazilianAreaCode && digits[2] === "9";
  const localBrazilianEightDigit = digits.length === 10 && brazilianAreaCode && /^[2-9]$/.test(digits[2] ?? "");
  const primary = !value.trim().startsWith("+") && (localBrazilianMobile || localBrazilianEightDigit)
    ? `55${digits}`
    : digits;
  if (!/^\d{8,15}$/.test(primary)) return null;

  const key = canonicalizePhone(primary);
  const fullBrazilianMobile = primary.startsWith("55") && primary.length === 13 && primary[4] === "9";
  const reducedBrazilianMobile = primary.startsWith("55") && primary.length === 12 && primary[4] === "9";
  const alternate = fullBrazilianMobile
    ? key
    : reducedBrazilianMobile
      ? `${primary.slice(0, 4)}9${primary.slice(4)}`
      : null;

  return { key, primary, alternate };
}
