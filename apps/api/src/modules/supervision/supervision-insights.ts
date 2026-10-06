import { Prisma, type PrismaClient } from "@prisma/client";
import type { SupervisionGrant } from "@prymeira-talk/shared";

type Raw = Pick<PrismaClient, "$queryRaw">;

/** A message a customer or seller actually wrote: no system/internal notes, reactions, deletions, failed sends or
 * private follow-up drafts. Reactions and receipts must never count as "answered". */
function written(alias: string) {
  const m = Prisma.raw(alias);
  return Prisma.sql`${m}.type NOT IN ('system', 'internal_note') AND ${m}.status <> 'failed'
    AND NOT (${m}.metadata ? 'reaction') AND NOT (${m}.metadata ? 'deletedAt')
    AND NOT (${m}.status = 'pending' AND ${m}.metadata->>'source' = 'followup_review')`;
}

/** Timestamps are stored as UTC without zone. */
const utc = (date: Date) => date.toISOString().replace("Z", "");

/** The start of "today" for the team, in Brazil (UTC−3, no daylight saving since 2019). */
export function saoPauloDayStart(now: Date) {
  const local = new Date(now.getTime() - 3 * 3_600_000);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 3));
}

function scope(grants: SupervisionGrant[]) {
  return Prisma.sql`SELECT * FROM unnest(${grants.map(g => g.workspace_id)}::text[], ${grants.map(g => g.channel_id)}::uuid[],
    ${grants.map(g => g.seller_customer_id)}::text[]) AS s(workspace_id, channel_id, seller_id)`;
}

export type WaitingRow = { conversation_id: string; workspace_id: string; seller_id: string; waiting_since: Date };

/**
 * Conversations whose customer is waiting for an answer: active, one-to-one, the last written message is the
 * customer's, and it arrived in the last 7 days (older silence is a lost lead, not a queue). `waiting_since` is the
 * first unanswered customer message, so a customer who wrote three times is waiting since the first one.
 * Messages a supervisor marked as "não precisa responder" (a greeting, an automatic welcome) no longer count; the
 * customer waits again only from their next message.
 */
export async function waitingConversations(prisma: Raw, grants: SupervisionGrant[], now: Date, conversationIds?: string[]) {
  if (!grants.length) return [];
  const since = new Date(now.getTime() - 7 * 86_400_000);
  return prisma.$queryRaw<WaitingRow[]>`
    WITH s AS (${scope(grants)}),
    conv AS (
      SELECT c.id, c.workspace_id, s.seller_id, c.waiting_dismissed_at FROM conversations c
      JOIN s ON s.workspace_id = c.workspace_id AND s.channel_id = c.channel_id
      JOIN contacts ct ON ct.id = c.contact_id
      WHERE c.status IN ('open', 'pending') AND c.hidden_until_reply = false AND c.retired_into_conversation_id IS NULL
        AND NOT ct.is_group AND c.last_message_at >= ${utc(since)}::timestamp
        ${conversationIds ? Prisma.sql`AND c.id = ANY(${conversationIds}::uuid[])` : Prisma.empty}
    )
    SELECT conv.id::text AS conversation_id, conv.workspace_id, conv.seller_id, w.waiting_since
    FROM conv
    CROSS JOIN LATERAL (
      SELECT m.direction FROM messages m WHERE m.workspace_id = conv.workspace_id AND m.conversation_id = conv.id AND ${written("m")}
      ORDER BY m.created_at DESC, m.id DESC LIMIT 1
    ) last
    CROSS JOIN LATERAL (
      SELECT min(m.created_at) AS waiting_since FROM messages m
      WHERE m.workspace_id = conv.workspace_id AND m.conversation_id = conv.id AND m.direction = 'inbound' AND ${written("m")}
        AND m.created_at > greatest(coalesce((SELECT max(o.created_at) FROM messages o WHERE o.workspace_id = conv.workspace_id
          AND o.conversation_id = conv.id AND o.direction = 'outbound' AND ${written("o")}), '-infinity'::timestamp),
          coalesce(conv.waiting_dismissed_at, '-infinity'::timestamp))
    ) w
    WHERE last.direction = 'inbound' AND w.waiting_since IS NOT NULL
    ORDER BY w.waiting_since ASC
    LIMIT 200`;
}

export type TodayRow = { seller_id: string; received: number; sent: number; conversations: number; median_response_seconds: number | null };

/** Today's work per seller (one-to-one chats only): messages in and out, conversations touched, and the median time
 * between a customer starting to write and the first answer (by the seller or the agent). */
export async function todayActivity(prisma: Raw, grants: SupervisionGrant[], now: Date) {
  if (!grants.length) return [];
  const dayStart = utc(saoPauloDayStart(now));
  return prisma.$queryRaw<TodayRow[]>`
    WITH s AS (${scope(grants)}),
    today AS (
      SELECT m.id, m.workspace_id, m.conversation_id, m.direction, m.created_at, s.seller_id FROM messages m
      JOIN conversations c ON c.id = m.conversation_id AND c.workspace_id = m.workspace_id
      JOIN s ON s.workspace_id = c.workspace_id AND s.channel_id = c.channel_id
      JOIN contacts ct ON ct.id = c.contact_id
      WHERE m.created_at >= ${dayStart}::timestamp AND NOT ct.is_group AND ${written("m")}
    ),
    volume AS (
      SELECT seller_id, count(*) FILTER (WHERE direction = 'inbound')::int AS received,
        count(*) FILTER (WHERE direction = 'outbound')::int AS sent, count(DISTINCT conversation_id)::int AS conversations
      FROM today GROUP BY seller_id
    ),
    response AS (
      SELECT t.seller_id, percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (r.answered_at - t.created_at))) AS median_response_seconds
      FROM today t
      LEFT JOIN LATERAL (
        SELECT p.direction FROM messages p WHERE p.workspace_id = t.workspace_id AND p.conversation_id = t.conversation_id AND ${written("p")}
          AND (p.created_at, p.id) < (t.created_at, t.id) ORDER BY p.created_at DESC, p.id DESC LIMIT 1
      ) previous ON true
      CROSS JOIN LATERAL (
        SELECT min(o.created_at) AS answered_at FROM messages o WHERE o.workspace_id = t.workspace_id AND o.conversation_id = t.conversation_id
          AND o.direction = 'outbound' AND ${written("o")} AND o.created_at > t.created_at
      ) r
      WHERE t.direction = 'inbound' AND (previous.direction IS NULL OR previous.direction = 'outbound') AND r.answered_at IS NOT NULL
      GROUP BY t.seller_id
    )
    SELECT v.seller_id, v.received, v.sent, v.conversations, r.median_response_seconds::float8 AS median_response_seconds
    FROM volume v LEFT JOIN response r ON r.seller_id = v.seller_id`;
}

/** What the seller has to do next, as the handoff brief wrote it ("Verifique se trabalhamos com o material…"), or the
 * agent's own handoff reason when no brief is ready. */
export function nextActionText(session: { handoffReason?: string | null; metadata?: unknown } | null | undefined) {
  const brief = session?.metadata && typeof session.metadata === "object" ? (session.metadata as Record<string, unknown>).handoffBrief : null;
  const fromBrief = brief && typeof brief === "object" && (brief as Record<string, unknown>).status === "ready"
    ? (brief as Record<string, unknown>).nextAction : null;
  const text = typeof fromBrief === "string" && fromBrief.trim() ? fromBrief.trim() : session?.handoffReason?.trim();
  return text && text !== "Agent requested human handoff." && text !== "possible_automation_loop" ? text.slice(0, 280) : null;
}
