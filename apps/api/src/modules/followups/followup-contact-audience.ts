import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * AI-only marker on a contact: "internal_personal" means colleague, family, friend, supplier or
 * carrier, so the follow-up never analyzes or suggests anything for them. It lives in
 * contacts.custom_fields.followupAudience and is not shown as a tag. A team member's choice
 * (source "manual") is never overwritten by the AI.
 */
export type FollowupAudience = {
  kind: "customer" | "internal_personal";
  source: "ai" | "manual";
  reason: string | null;
  at: string;
};

/** The AI only marks a contact as internal when it is this sure. */
export const FOLLOWUP_AUDIENCE_MIN_CONFIDENCE = 0.8;

type Db = Pick<PrismaClient, "contact">;

const record = (value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function readFollowupAudience(customFields: unknown): FollowupAudience | null {
  const value = record(customFields).followupAudience;
  const stored = record(value);
  if ((stored.kind !== "customer" && stored.kind !== "internal_personal") || (stored.source !== "ai" && stored.source !== "manual")) return null;
  return { kind: stored.kind, source: stored.source, reason: typeof stored.reason === "string" ? stored.reason : null, at: String(stored.at ?? "") };
}

export function isInternalPersonal(customFields: unknown) {
  return readFollowupAudience(customFields)?.kind === "internal_personal";
}

/** Saves what the AI concluded about a contact, unless a person already decided. Returns whether it wrote. */
export async function saveAiFollowupAudience(
  prisma: Db,
  input: { workspaceId: string; contactId: string; kind: FollowupAudience["kind"]; confidence: number; reason: string | null; now?: Date }
) {
  const contact = await prisma.contact.findFirst({ where: { workspaceId: input.workspaceId, id: input.contactId }, select: { customFields: true } });
  if (!contact) return false;
  const current = readFollowupAudience(contact.customFields);
  if (current?.source === "manual") return false;
  if (input.kind === "internal_personal" && input.confidence < FOLLOWUP_AUDIENCE_MIN_CONFIDENCE) return false;
  // A customer verdict only clears an earlier AI "internal" mark; it is not worth a write otherwise.
  if (input.kind === "customer" && current?.kind !== "internal_personal") return false;
  const followupAudience: FollowupAudience = {
    kind: input.kind,
    source: "ai",
    reason: input.reason?.slice(0, 300) ?? null,
    at: (input.now ?? new Date()).toISOString()
  };
  await prisma.contact.updateMany({
    where: { workspaceId: input.workspaceId, id: input.contactId },
    data: { customFields: { ...record(contact.customFields), followupAudience } as Prisma.InputJsonValue }
  });
  return true;
}
