import { Prisma, type PrismaClient } from "@prisma/client";
import {
  MAX_LEAD_BULK_SELECTION_SIZE, type LeadRegionDto, type OwnBaseFilter, type OwnBaseImportResult, type OwnBaseLeadPage,
  type OwnBaseOverview, type OwnBaseRow
} from "@prymeira-talk/shared";
import { whatsappPhoneCandidates } from "./lead-whatsapp-numbers.js";
import { LeadsDomainError } from "./leads.repository.js";

/**
 * Base própria: companies from the workspace's own spreadsheets, grouped by region. Everyone in the workspace sees
 * every region; only the workspace's own region ("Sua região") can become a dispatch list. Whether a company already
 * got a dispatch is read from the campaigns themselves, by phone number, whatever list it came from.
 */

/** Same number whatever its spelling: DDD + last 8 digits (a mobile with and without the 9th digit match). */
export function phoneKey(value: string | null | undefined) {
  const digits = (value ?? "").replace(/\D/g, "");
  if (/^55\d{10,11}$/.test(digits)) return digits.slice(2, 4) + digits.slice(-8);
  if (/^\d{10,11}$/.test(digits)) return digits.slice(0, 2) + digits.slice(-8);
  return digits;
}
const keySql = (column: string) => Prisma.raw(`(CASE WHEN regexp_replace(coalesce(${column}, ''), '\\D', '', 'g') ~ '^55[0-9]{10,11}$'
  THEN substr(regexp_replace(${column}, '\\D', '', 'g'), 3, 2) || right(regexp_replace(${column}, '\\D', '', 'g'), 8)
  WHEN regexp_replace(coalesce(${column}, ''), '\\D', '', 'g') ~ '^[0-9]{10,11}$'
  THEN left(regexp_replace(${column}, '\\D', '', 'g'), 2) || right(regexp_replace(${column}, '\\D', '', 'g'), 8)
  ELSE regexp_replace(coalesce(${column}, ''), '\\D', '', 'g') END)`);

/** "São Francisco do Sul", "SAO FRANCISCO DO SUL" and "sao francisco do sul" are the same city. */
export function cityKey(value: string | null | undefined) {
  return (value ?? "").normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
function titleCase(value: string) {
  const small = new Set(["da", "de", "do", "das", "dos", "e"]);
  return value.toLowerCase().split(/\s+/).filter(Boolean)
    .map((word, index) => index > 0 && small.has(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}
const clean = (value: string | undefined) => value?.trim() ? value.trim() : null;

/** The phones of a row: valid WhatsApp-style numbers first (with 55), the rest kept for review. */
export function splitPhones(values: string[]) {
  const valid: string[] = [], review: string[] = [];
  for (const raw of values.flatMap(value => value.split(/[|;,/]+/)).map(value => value.trim()).filter(Boolean)) {
    const candidate = whatsappPhoneCandidates(raw);
    const primary = candidate && /^55\d{10,11}$/.test(candidate.primary) ? candidate.primary : null;
    if (primary) { if (!valid.some(phone => phoneKey(phone) === phoneKey(primary))) valid.push(primary); }
    else if (!review.includes(raw)) review.push(raw);
  }
  return { valid, review };
}

type Db = Pick<PrismaClient, "leadList" | "lead" | "leadRegion" | "$queryRaw" | "$transaction">;

export function createOwnBaseService(prisma: Db) {
  async function regions(workspaceId: string) {
    return prisma.leadRegion.findMany({ where: { workspaceId }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] });
  }
  async function ownList(workspaceId: string, listId?: string) {
    const list = await prisma.leadList.findFirst({ where: { workspaceId, source: "own_base", ...(listId ? { id: listId } : {}) }, orderBy: { createdAt: "desc" } });
    if (listId && !list) throw new LeadsDomainError("LEAD_NOT_FOUND", "Base não encontrada.");
    return list;
  }
  /** null when every region may be used (no region marked as the workspace's own yet). */
  async function myRegion(workspaceId: string) {
    return (await prisma.leadRegion.findFirst({ where: { workspaceId, isMine: true } }))?.name ?? null;
  }
  function regionWhere(region: string | null | undefined) {
    return region === undefined ? Prisma.empty : region === null ? Prisma.sql`AND l.region IS NULL` : Prisma.sql`AND l.region = ${region}`;
  }
  function searchWhere(q: string | undefined) {
    const text = q?.trim();
    if (!text) return Prisma.empty;
    const digits = text.replace(/\D/g, "");
    return digits.length >= 4
      ? Prisma.sql`AND (coalesce(l.trade_name, l.company_name) ILIKE ${`%${text}%`} OR regexp_replace(coalesce(l.normalized_phone, ''), '\\D', '', 'g') LIKE ${`%${digits}%`})`
      : Prisma.sql`AND coalesce(l.trade_name, l.company_name) ILIKE ${`%${text}%`}`;
  }
  /** Each company of the base with its latest dispatch (any campaign, by number) and the first answer after it. */
  function enriched(workspaceId: string, listId: string, region: string | null | undefined, q?: string) {
    return Prisma.sql`
      WITH base AS (
        SELECT l.id, coalesce(nullif(l.trade_name, ''), l.company_name, '') AS company, l.normalized_phone, l.phones, l.city, l.region,
          ${keySql("l.normalized_phone")} AS k
        FROM leads l WHERE l.workspace_id = ${workspaceId} AND l.list_id = ${listId}::uuid ${regionWhere(region)} ${searchWhere(q)}
      ), sent AS (
        SELECT DISTINCT ON (r.k) r.k, r.sent_at, cp.name AS campaign, r.contact_id
        FROM (SELECT rr.workspace_id, rr.campaign_id, rr.contact_id, rr.sent_at, ${keySql("rr.phone_snapshot")} AS k
              FROM campaign_recipients rr WHERE rr.workspace_id = ${workspaceId} AND rr.sent_at IS NOT NULL) r
        JOIN campaigns cp ON cp.workspace_id = r.workspace_id AND cp.id = r.campaign_id
        WHERE r.k IN (SELECT k FROM base WHERE k <> '')
        ORDER BY r.k, r.sent_at DESC
      ), rows AS (
        SELECT b.*, s.sent_at, s.campaign,
          (SELECT min(m.created_at) FROM messages m JOIN conversations cv ON cv.workspace_id = m.workspace_id AND cv.id = m.conversation_id
            WHERE s.contact_id IS NOT NULL AND cv.workspace_id = ${workspaceId} AND cv.contact_id = s.contact_id
              AND m.direction = 'inbound' AND m.created_at > s.sent_at) AS replied_at
        FROM base b LEFT JOIN sent s ON s.k = b.k AND b.k <> ''
      )`;
  }
  const filterWhere = (filter: OwnBaseFilter) => filter === "never" ? Prisma.sql`WHERE sent_at IS NULL`
    : filter === "sent" ? Prisma.sql`WHERE sent_at IS NOT NULL` : filter === "replied" ? Prisma.sql`WHERE replied_at IS NOT NULL` : Prisma.empty;

  return {
    async importRows(input: { workspaceId: string; listId?: string; name: string; fileName: string; rows: OwnBaseRow[]; done: boolean }): Promise<OwnBaseImportResult> {
      const list = input.listId ? await ownList(input.workspaceId, input.listId)
        : await prisma.leadList.create({ data: { workspaceId: input.workspaceId, name: input.name, source: "own_base", criteria: { fileName: input.fileName }, startedAt: new Date() } });
      const configured = await regions(input.workspaceId);
      const byCity = new Map<string, string>();
      for (const region of configured) for (const city of Array.isArray(region.cities) ? region.cities : []) if (typeof city === "string") byCity.set(cityKey(city), region.name);
      const byName = new Map(configured.map(region => [cityKey(region.name), region.name]));
      const seen = new Map<string, Set<string>>();
      let withoutPhone = 0;
      const data = input.rows.map((row, index) => {
        const { valid, review } = splitPhones(row.phones);
        if (!valid.length) withoutPhone++;
        const city = clean(row.city) ? titleCase(row.city!) : null;
        // A configured city map wins; otherwise the spreadsheet's own region column (a new region is created for it).
        const named = clean(row.region);
        const region = (city && byCity.get(cityKey(city))) ?? (named ? byName.get(cityKey(named)) ?? named : null);
        if (region && named && !byName.has(cityKey(named)) && region === named) {
          const cities = seen.get(region) ?? new Set<string>(); if (city) cities.add(city); seen.set(region, cities);
        }
        const cnpj = (row.cnpj ?? "").replace(/\D/g, "");
        const dedupe = cnpj.length === 14 ? `cnpj:${cnpj}` : valid[0] ? `phone:${phoneKey(valid[0])}` : `name:${cityKey(row.company)}:${index}`;
        return { workspaceId: input.workspaceId, listId: list!.id, source: "own_base" as const, sourceDedupeKey: dedupe,
          companyName: row.company.trim(), cnpj: cnpj.length === 14 ? cnpj : null, city, state: clean(row.state)?.toUpperCase() ?? null,
          category: clean(row.activity), email: clean(row.email), phones: valid, normalizedPhone: valid[0] ?? null, region,
          sourceSnapshot: { contact: clean(row.contact), notes: clean(row.notes), originList: clean(row.originList), phonesToReview: review, fileName: input.fileName } };
      });
      await prisma.$transaction(async tx => {
        for (const lead of data) {
          await tx.lead.upsert({ where: { workspaceId_listId_sourceDedupeKey: { workspaceId: lead.workspaceId, listId: lead.listId, sourceDedupeKey: lead.sourceDedupeKey } },
            create: lead, update: { companyName: lead.companyName, cnpj: lead.cnpj, city: lead.city, state: lead.state, category: lead.category, email: lead.email,
              phones: lead.phones, normalizedPhone: lead.normalizedPhone, region: lead.region, sourceSnapshot: lead.sourceSnapshot } });
        }
        // Regions named by the spreadsheet become regions of the workspace, with the cities seen in them.
        const count = await tx.leadRegion.count({ where: { workspaceId: input.workspaceId } });
        let order = count;
        for (const [name, cities] of seen) {
          const existing = await tx.leadRegion.findUnique({ where: { workspaceId_name: { workspaceId: input.workspaceId, name } } });
          const merged = [...new Set([...(Array.isArray(existing?.cities) ? existing!.cities as string[] : []), ...cities])].sort((a, b) => a.localeCompare(b, "pt-BR"));
          if (existing) await tx.leadRegion.update({ where: { id: existing.id }, data: { cities: merged } });
          else await tx.leadRegion.create({ data: { workspaceId: input.workspaceId, name, cities: merged, sortOrder: order++ } });
        }
      }, { timeout: 120_000 });
      const total = await prisma.lead.count({ where: { workspaceId: input.workspaceId, listId: list!.id } });
      await prisma.leadList.update({ where: { workspaceId_id: { workspaceId: input.workspaceId, id: list!.id } },
        data: { totalCount: total, processedCount: total, ...(input.done ? { completedAt: new Date() } : {}) } });
      return { listId: list!.id, saved: data.length, withoutPhone, total };
    },

    async overview(workspaceId: string, listId?: string): Promise<OwnBaseOverview> {
      const list = await ownList(workspaceId, listId);
      const configured = await regions(workspaceId);
      if (!list) return { list: null, regions: [], hasMyRegion: configured.some(region => region.isMine) };
      const counts = await prisma.$queryRaw<Array<{ region: string | null; total: bigint; dispatched: bigint }>>(Prisma.sql`
        ${enriched(workspaceId, list.id, undefined)}
        SELECT region, count(*) AS total, count(*) FILTER (WHERE sent_at IS NOT NULL) AS dispatched FROM rows GROUP BY region`);
      const byRegion = new Map(counts.map(row => [row.region, row]));
      const summaries: OwnBaseOverview["regions"] = configured.map(region => ({ region: region.name, seller: region.seller, isMine: region.isMine,
        total: Number(byRegion.get(region.name)?.total ?? 0), dispatched: Number(byRegion.get(region.name)?.dispatched ?? 0) }));
      // A region written in the base but not configured (should not happen) still shows, after the configured ones.
      for (const row of counts) if (row.region && !configured.some(region => region.name === row.region)) summaries.push({ region: row.region, seller: null, isMine: false, total: Number(row.total), dispatched: Number(row.dispatched) });
      const none = byRegion.get(null);
      if (none) summaries.push({ region: null, seller: null, isMine: false, total: Number(none.total), dispatched: Number(none.dispatched) });
      return { list: { id: list.id, name: list.name, total: list.totalCount, createdAt: list.createdAt.toISOString() }, regions: summaries, hasMyRegion: configured.some(region => region.isMine) };
    },

    async page(input: { workspaceId: string; listId: string; region?: string | null; filter: OwnBaseFilter; q?: string; page: number; pageSize: number }): Promise<OwnBaseLeadPage> {
      await ownList(input.workspaceId, input.listId);
      const mine = await myRegion(input.workspaceId);
      const base = enriched(input.workspaceId, input.listId, input.region, input.q);
      const [rows, totals] = await Promise.all([
        prisma.$queryRaw<Array<{ id: string; company: string; normalized_phone: string | null; phones: unknown; city: string | null; region: string | null;
          sent_at: Date | null; campaign: string | null; replied_at: Date | null }>>(Prisma.sql`
          ${base} SELECT * FROM rows ${filterWhere(input.filter)}
          ORDER BY company, id LIMIT ${input.pageSize} OFFSET ${(input.page - 1) * input.pageSize}`),
        prisma.$queryRaw<Array<{ never: bigint; sent: bigint; replied: bigint; all: bigint }>>(Prisma.sql`
          ${base} SELECT count(*) FILTER (WHERE sent_at IS NULL) AS never, count(*) FILTER (WHERE sent_at IS NOT NULL) AS sent,
            count(*) FILTER (WHERE replied_at IS NOT NULL) AS replied, count(*) AS "all" FROM rows`)
      ]);
      const counts = totals[0] ?? { never: 0n, sent: 0n, replied: 0n, all: 0n };
      return {
        items: rows.map(row => ({ id: row.id, company: row.company, phone: row.normalized_phone,
          otherPhones: Math.max(0, (Array.isArray(row.phones) ? row.phones.length : 0) - 1), city: row.city, region: row.region,
          lastDispatch: row.sent_at ? { at: row.sent_at.toISOString(), campaign: row.campaign ?? "Disparo" } : null,
          repliedAt: row.replied_at ? row.replied_at.toISOString() : null })),
        total: Number(counts[input.filter]), page: input.page, pageSize: input.pageSize,
        counts: { never: Number(counts.never), sent: Number(counts.sent), replied: Number(counts.replied), all: Number(counts.all) },
        selectable: mine === null || input.region === mine
      };
    },

    /** Every id the current view shows, to select them all; only in the workspace's own region. */
    async selection(input: { workspaceId: string; listId: string; region?: string | null; filter: OwnBaseFilter; q?: string }) {
      await ownList(input.workspaceId, input.listId);
      const mine = await myRegion(input.workspaceId);
      if (mine !== null && input.region !== mine) throw new LeadsDomainError("LEAD_INVALID_TRANSITION", "Você só pode criar listas na sua região.");
      const rows = await prisma.$queryRaw<Array<{ id: string; k: string }>>(Prisma.sql`
        ${enriched(input.workspaceId, input.listId, input.region, input.q)}
        SELECT id, k FROM rows ${filterWhere(input.filter)} ORDER BY company, id LIMIT ${MAX_LEAD_BULK_SELECTION_SIZE + 1}`);
      if (rows.length > MAX_LEAD_BULK_SELECTION_SIZE) throw new LeadsDomainError("LEAD_LIMIT_EXCEEDED", `Selecione até ${MAX_LEAD_BULK_SELECTION_SIZE} empresas por lista.`);
      return { ids: rows.map(row => row.id), verifiableIds: rows.filter(row => row.k).map(row => row.id) };
    },

    /** A base's leads may only become a dispatch list from the workspace's own region. */
    async assertSelectable(workspaceId: string, listId: string, leadIds: string[]) {
      const list = await prisma.leadList.findFirst({ where: { workspaceId, id: listId } });
      if (list?.source !== "own_base") return;
      const mine = await myRegion(workspaceId);
      if (mine === null) return;
      const outside = await prisma.lead.count({ where: { workspaceId, listId, id: { in: leadIds }, NOT: { region: mine } } })
        + await prisma.lead.count({ where: { workspaceId, listId, id: { in: leadIds }, region: null } });
      if (outside) throw new LeadsDomainError("LEAD_INVALID_TRANSITION", "Você só pode criar listas na sua região.");
    },

    async listRegions(workspaceId: string): Promise<LeadRegionDto[]> {
      return (await regions(workspaceId)).map(region => ({ name: region.name, cities: Array.isArray(region.cities) ? region.cities as string[] : [], seller: region.seller, isMine: region.isMine }));
    },

    /** Replaces the regions (names, cities, seller, "Sua região") and re-files every company of the bases by city. */
    async saveRegions(workspaceId: string, next: LeadRegionDto[]) {
      await prisma.$transaction(async tx => {
        const current = await tx.leadRegion.findMany({ where: { workspaceId } });
        const keep = new Set(next.map(region => region.name));
        await tx.leadRegion.deleteMany({ where: { workspaceId, name: { notIn: [...keep] } } });
        for (const [index, region] of next.entries()) {
          const cities = [...new Set(region.cities.map(city => titleCase(city.trim())).filter(Boolean))];
          const existing = current.find(row => row.name === region.name);
          const data = { cities, seller: region.seller?.trim() || null, isMine: region.isMine, sortOrder: index };
          if (existing) await tx.leadRegion.update({ where: { id: existing.id }, data });
          else await tx.leadRegion.create({ data: { workspaceId, name: region.name, ...data } });
        }
      }, { timeout: 120_000 });
      // Companies follow the city map; a company whose city is in no region keeps its region while that still exists.
      const leads = await prisma.lead.findMany({ where: { workspaceId, source: "own_base" }, select: { id: true, city: true, region: true } });
      const byCity = new Map<string, string>();
      for (const region of next) for (const city of region.cities) byCity.set(cityKey(city), region.name);
      const names = new Set(next.map(region => region.name));
      const moves = new Map<string | null, string[]>();
      for (const lead of leads) {
        const target = (lead.city && byCity.get(cityKey(lead.city))) ?? (lead.region && names.has(lead.region) ? lead.region : null);
        if (target !== lead.region) moves.set(target, [...(moves.get(target) ?? []), lead.id]);
      }
      for (const [region, ids] of moves) for (let at = 0; at < ids.length; at += 1000) {
        await prisma.lead.updateMany({ where: { workspaceId, id: { in: ids.slice(at, at + 1000) } }, data: { region } });
      }
      return this.listRegions(workspaceId);
    }
  };
}
export type OwnBaseService = ReturnType<typeof createOwnBaseService>;
