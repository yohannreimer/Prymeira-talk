import type { AgentProvider } from "../agents/provider-gateway.js";
import { bodyHash, CONTACT_FIELDS, generateVariant, variantKey } from "./quick-reply-variant.js";

type DateLike = Date | string;

interface QuickReplyRecord {
  id: string;
  workspaceId: string;
  title: string;
  body: string;
  category: string | null;
  ownerUserId?: string | null;
  shortcut?: string | null;
  variants?: unknown;
  createdAt: DateLike;
  updatedAt: DateLike;
}

export interface QuickReplyDto {
  id: string;
  workspaceId: string;
  title: string;
  body: string;
  category: string | null;
  /** What follows "/" in the composer. */
  shortcut: string | null;
  /** The team's (no owner): visible to everyone. Otherwise only its owner sees it. */
  shared: boolean;
  createdAt: string;
  updatedAt: string;
}

type Where = { workspaceId: string; id?: string; OR?: Array<{ ownerUserId: string | null }> };
export interface PrismaLike {
  quickReply: {
    findMany(args: { where: Where; orderBy: Array<{ updatedAt: "desc" }> }): Promise<QuickReplyRecord[]>;
    findFirst(args: { where: Where }): Promise<QuickReplyRecord | null>;
    create(args: { data: { workspaceId: string; title: string; body: string; category?: string | null; ownerUserId?: string | null; shortcut?: string | null } }): Promise<QuickReplyRecord>;
    update(args: {
      where: { workspaceId_id: { workspaceId: string; id: string } };
      data: Partial<{ title: string; body: string; category: string | null; shortcut: string | null; variants: Record<string, unknown> }>;
    }): Promise<QuickReplyRecord>;
    delete(args: { where: { workspaceId_id: { workspaceId: string; id: string } } }): Promise<QuickReplyRecord>;
  };
}

export class QuickReplyNotFoundError extends Error {}

function toIsoString(value: DateLike) {
  return value instanceof Date ? value.toISOString() : value;
}

/** "Bem-vindo!" → "bemvindo": lowercase letters and digits, no accents, so "/bem" finds it. */
export function normalizeShortcut(value: string | null | undefined) {
  const shortcut = value?.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 40);
  return shortcut || null;
}

function toDto(record: QuickReplyRecord): QuickReplyDto {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    title: record.title,
    body: record.body,
    category: record.category ?? null,
    shortcut: record.shortcut ?? null,
    shared: !record.ownerUserId,
    createdAt: toIsoString(record.createdAt),
    updatedAt: toIsoString(record.updatedAt)
  };
}

/** Personal quick replies: each person sees their own plus the team's shared ones (owner null). Without a known user
 * (local development), everything is shared, as before. */
export function createQuickRepliesService(prisma: PrismaLike) {
  const visible = (workspaceId: string, ownerUserId: string | null | undefined): Where =>
    ownerUserId ? { workspaceId, OR: [{ ownerUserId: null }, { ownerUserId }] } : { workspaceId };
  async function owned(workspaceId: string, id: string, ownerUserId: string | null | undefined) {
    const record = await prisma.quickReply.findFirst({ where: { ...visible(workspaceId, ownerUserId), id } });
    if (!record) throw new QuickReplyNotFoundError();
    return record;
  }
  return {
    async list(input: { workspaceId: string; ownerUserId?: string | null }) {
      const records = await prisma.quickReply.findMany({ where: visible(input.workspaceId, input.ownerUserId), orderBy: [{ updatedAt: "desc" }] });
      return records.map(toDto);
    },

    async create(input: { workspaceId: string; ownerUserId?: string | null; title: string; body: string; category?: string | null; shortcut?: string | null }) {
      const record = await prisma.quickReply.create({
        data: {
          workspaceId: input.workspaceId,
          ownerUserId: input.ownerUserId ?? null,
          title: input.title.trim(),
          body: input.body.trim(),
          category: input.category?.trim() || null,
          shortcut: normalizeShortcut(input.shortcut ?? input.title)
        }
      });
      return toDto(record);
    },

    async update(input: { workspaceId: string; ownerUserId?: string | null; id: string; data: Partial<{ title: string; body: string; category: string | null; shortcut: string | null }> }) {
      await owned(input.workspaceId, input.id, input.ownerUserId);
      const data = Object.fromEntries(Object.entries(input.data).map(([key, value]) => [key,
        key === "shortcut" ? normalizeShortcut(value as string | null)
          : typeof value === "string" ? value.trim() || (key === "category" ? null : value.trim()) : value]));
      const record = await prisma.quickReply.update({ where: { workspaceId_id: { workspaceId: input.workspaceId, id: input.id } }, data });
      return toDto(record);
    },

    async delete(input: { workspaceId: string; ownerUserId?: string | null; id: string }) {
      await owned(input.workspaceId, input.id, input.ownerUserId);
      await prisma.quickReply.delete({ where: { workspaceId_id: { workspaceId: input.workspaceId, id: input.id } } });
    },

    /**
     * The message for a contact without some fields (no name, no company…): rewritten once by the AI and saved on the
     * quick reply, so every later use is instant and identical. Editing the body makes the saved rewrite stale.
     * Returns null when there is no AI or it gave nothing usable: the composer then just drops the field.
     */
    async variant(input: { workspaceId: string; ownerUserId?: string | null; id: string; missing: string[];
      ai: { provider: Pick<AgentProvider, "generate">; model: string } | null }) {
      const record = await owned(input.workspaceId, input.id, input.ownerUserId);
      const missing = input.missing.filter(field => (CONTACT_FIELDS as readonly string[]).includes(field));
      if (!missing.length) return { body: record.body, source: "original" as const };
      const key = variantKey(missing); const hash = bodyHash(record.body);
      const variants = record.variants && typeof record.variants === "object" && !Array.isArray(record.variants) ? record.variants as Record<string, unknown> : {};
      const saved = variants[key] as { body?: unknown; hash?: unknown } | undefined;
      if (saved && saved.hash === hash && typeof saved.body === "string") return { body: saved.body, source: "saved" as const };
      if (!input.ai) return { body: null, source: "none" as const };
      const body = await generateVariant(record.body, missing, input.ai).catch(() => null);
      if (!body) return { body: null, source: "none" as const };
      // Rewrites of an older body are dropped as the new one is saved.
      const fresh = Object.fromEntries(Object.entries(variants).filter(([, value]) => (value as { hash?: unknown })?.hash === hash));
      await prisma.quickReply.update({ where: { workspaceId_id: { workspaceId: input.workspaceId, id: input.id } },
        data: { variants: { ...fresh, [key]: { body, hash, at: new Date().toISOString() } } } });
      return { body, source: "ai" as const };
    },

    /** A pack exported by someone (or another account) becomes the importer's own copies; ones already there are skipped. */
    async importPack(input: { workspaceId: string; ownerUserId?: string | null; replies: Array<{ title: string; body: string; category?: string | null; shortcut?: string | null }> }) {
      const existing = await this.list(input);
      const seen = new Set(existing.map(reply => `${reply.title.trim()}\u0000${reply.body.trim()}`));
      let created = 0;
      for (const reply of input.replies) {
        const key = `${reply.title.trim()}\u0000${reply.body.trim()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        await this.create({ ...input, ...reply });
        created++;
      }
      return { created, skipped: input.replies.length - created };
    }
  };
}
