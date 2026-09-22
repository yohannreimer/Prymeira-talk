import { canonicalizePhone } from "../contacts/phone-normalization.js";

export type WhatsappPhoneCandidates = {
  key: string;
  primary: string;
  alternate: string | null;
};

export function whatsappPhoneCandidates(value: string): WhatsappPhoneCandidates | null {
  const primary = value.replace(/\D/g, "");
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
