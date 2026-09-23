import { createHash } from "node:crypto";
import { whatsappPhoneCandidates } from "../leads/lead-whatsapp-numbers.js";

export type PreviewContact = {
  audienceKey: string;
  contactId: string | null;
  name: string | null;
  phone: string;
  fields: Record<string, string>;
};

export type PreviewReason = "eligible" | "missing_phone" | "no_whatsapp" |
  "unverified" | "verification_error" | "duplicate";

export type Availability = { phone: string; available: boolean };

export function classifyRecipient(input: {
  phone: string;
  verification: { phone: string; status: "available" | "unavailable" | "error" } | null;
}): PreviewReason {
  const current = whatsappPhoneCandidates(input.phone);
  if (!current) return "missing_phone";
  if (!input.verification) return "unverified";
  const checked = whatsappPhoneCandidates(input.verification.phone);
  if (!checked || checked.key !== current.key) return "unverified";
  if (input.verification.status === "error") return "verification_error";
  return input.verification.status === "available" ? "eligible" : "no_whatsapp";
}

export type AudiencePreview = {
  selectedCount: number | null;
  eligible: Array<PreviewContact & { normalizedPhone: string; message: string }>;
  excluded: Array<PreviewContact & { reason: Exclude<PreviewReason, "eligible"> }>;
  checkedAt: string;
  audienceHash: string;
  revision: string;
  unresolvedVariables: string[];
};

export async function previewCampaignAudience(input: {
  campaign: {
    id: string;
    updatedAt: Date | string;
    audience: unknown;
    messageBody: string;
    templates?: unknown;
    fallbackName?: string;
  };
  channelId: string;
  contacts: PreviewContact[];
  verify: (numbers: string[]) => Promise<Availability[]>;
  now?: () => Date;
}): Promise<AudiencePreview> {
  const grouped = new Map<string, { candidate: ReturnType<typeof whatsappPhoneCandidates>; contact: PreviewContact }>();
  const excluded: AudiencePreview["excluded"] = [];
  for (const contact of input.contacts) {
    const candidate = whatsappPhoneCandidates(contact.phone);
    if (!candidate) {
      excluded.push({ ...contact, reason: "missing_phone" });
    } else if (grouped.has(candidate.key)) {
      excluded.push({ ...contact, reason: "duplicate" });
    } else {
      grouped.set(candidate.key, { candidate, contact });
    }
  }

  const entries = [...grouped.values()];
  const byPhone = new Map<string, Availability>();
  const failedKeys = new Set<string>();
  const record = (results: Availability[]) => {
    for (const item of results) {
      const candidate = whatsappPhoneCandidates(item.phone);
      if (!candidate) continue;
      const previous = byPhone.get(candidate.key);
      if (!previous?.available || item.available) byPhone.set(candidate.key, item);
    }
  };
  // Evolution checks the current phone each time; old lead-verification snapshots are not authority.
  for (let index = 0; index < entries.length; index += 100) {
    const batch = entries.slice(index, index + 100);
    try { record(await input.verify(batch.map(({ candidate }) => candidate!.primary))); }
    catch { batch.forEach(({ candidate }) => failedKeys.add(candidate!.key)); }
  }
  const alternates = entries.filter(({ candidate }) => candidate!.alternate &&
    !byPhone.get(candidate!.key)?.available && !failedKeys.has(candidate!.key));
  for (let index = 0; index < alternates.length; index += 100) {
    const batch = alternates.slice(index, index + 100);
    try { record(await input.verify(batch.map(({ candidate }) => candidate!.alternate!))); }
    catch { batch.forEach(({ candidate }) => failedKeys.add(candidate!.key)); }
  }
  const eligible: AudiencePreview["eligible"] = [];
  const unresolvedVariables = new Set<string>();
  const templates = Array.isArray(input.campaign.templates)
    ? input.campaign.templates.filter((value): value is string => typeof value === "string" && !!value.trim())
    : [];
  const fallback = input.campaign.fallbackName?.trim() || "cliente";
  for (const [index, { candidate, contact }] of entries.entries()) {
    const found = byPhone.get(candidate!.key);
    const reason = failedKeys.has(candidate!.key) || !found ? "verification_error" :
      classifyRecipient({ phone: contact.phone, verification: {
        phone: found.phone, status: found.available ? "available" : "unavailable"
      } });
    if (reason !== "eligible") {
      excluded.push({ ...contact, reason });
      continue;
    }
    const template = templates[index % templates.length] ?? input.campaign.messageBody;
    const name = contact.name?.trim() || fallback;
    const values: Record<string, string> = { ...contact.fields, name, nome: name,
      phone: contact.phone, telefone: contact.phone };
    for (const match of template.matchAll(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g)) {
      if (!values[match[1]!]?.trim()) unresolvedVariables.add(match[1]!);
    }
    const message = template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g,
      (_, key: string) => values[key] ?? "");
    eligible.push({ ...contact, normalizedPhone: candidate!.primary, message });
  }

  const audience = input.campaign.audience;
  const isBoard = typeof audience === "object" && audience !== null &&
    "type" in audience && (audience as { type?: unknown }).type === "board";
  const storedCount = typeof audience === "object" && audience !== null &&
    "selectedCount" in audience ? (audience as { selectedCount?: unknown }).selectedCount : null;
  const selectedCount = typeof storedCount === "number" && Number.isInteger(storedCount) &&
    storedCount >= input.contacts.length ? storedCount : isBoard ? input.contacts.length : null;
  const revision = new Date(input.campaign.updatedAt).toISOString();
  const audienceHash = createHash("sha256").update(JSON.stringify({
    campaignId: input.campaign.id,
    revision,
    channelId: input.channelId,
    eligible: eligible.map((item) => [item.normalizedPhone, item.message]).sort((a, b) => a[0]!.localeCompare(b[0]!))
  })).digest("hex");
  return { selectedCount, eligible, excluded, checkedAt: (input.now?.() ?? new Date()).toISOString(),
    audienceHash, revision, unresolvedVariables: [...unresolvedVariables].sort() };
}
