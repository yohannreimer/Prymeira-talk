import type { CnpjQueryClient } from "../../plugins/cnpj-database.js";
import { normalizeCnpj } from "./leads.types.js";

const MAX_PAGE_SIZE = 100;
const MAX_PAGE = 10_000;
const MAX_SIMILAR_CANDIDATES = 1_000;
const SIMILAR_BUCKET_LIMITS = {
  exactPrimary: 300,
  exactSecondary: 300,
  cnaeGroup: 200,
  location: 100,
  profile: 100
} as const;
const MAX_EXACT_BATCH_SIZE = 100;
const ACCENTED_LOWERCASE = "áàâãäåæçéèêëíìîïñóòôõöøœúùûüýÿ";
const ASCII_EQUIVALENTS = "aaaaaaaceeeeiiiinooooooouuuuyy";
const PHONE_1 = "CASE WHEN NULLIF(btrim(e.telefone_1), '') IS NULL THEN NULL ELSE concat_ws('', NULLIF(btrim(e.ddd_1), ''), NULLIF(btrim(e.telefone_1), '')) END";
const PHONE_2 = "CASE WHEN NULLIF(btrim(e.telefone_2), '') IS NULL THEN NULL ELSE concat_ws('', NULLIF(btrim(e.ddd_2), ''), NULLIF(btrim(e.telefone_2), '')) END";

export class LeadSourceUnavailableError extends Error {
  readonly code = "LEAD_SOURCE_UNAVAILABLE" as const;

  constructor() {
    super("CNPJ lead source is unavailable.");
    this.name = "LeadSourceUnavailableError";
  }
}

export class CnpjBatchLimitError extends Error {
  readonly code = "LEAD_LIMIT_EXCEEDED" as const;

  constructor() {
    super(`CNPJ lookup batches are limited to ${MAX_EXACT_BATCH_SIZE} identifiers.`);
    this.name = "CnpjBatchLimitError";
  }
}

export interface CnpjSearchFilters {
  cnpj?: string;
  companyName?: string;
  tradeName?: string;
  city?: string;
  state?: string;
  cnaePrimary?: string;
  cnaeSecondary?: string;
  porte?: string;
  openedFrom?: string;
  openedTo?: string;
  capitalMin?: number;
  capitalMax?: number;
  phone?: string;
  email?: string;
  hasPhone?: boolean;
  hasEmail?: boolean;
  activeOnly?: boolean;
  page?: number;
  pageSize?: number;
  sortBy?: string;
  sortDirection?: string;
}

export interface CnpjSimilarCandidatesInput {
  seedCnpj?: string;
  cnaePrimary?: string;
  cnaeSecondary?: readonly string[];
  city?: string;
  state?: string;
  porte?: string;
  legalNature?: string;
  limit?: number;
}

export interface CnpjCompanyRecord {
  cnpj: string;
  cnpjBasico: string;
  companyName: string | null;
  tradeName: string | null;
  legalNature: string | null;
  legalNatureDescription: string | null;
  porte: string | null;
  capitalSocial: number | null;
  establishmentType: number | null;
  status: string | null;
  openedAt: string | null;
  cnaePrimary: string | null;
  cnaePrimaryDescription: string | null;
  cnaeSecondary: string[];
  address: string | null;
  neighborhood: string | null;
  postalCode: string | null;
  city: string | null;
  state: string | null;
  phone1: string | null;
  phone2: string | null;
  email: string | null;
  simples: boolean | null;
  mei: boolean | null;
  /** Coordinates are optional enrichment; Receita tables do not invent them. */
  latitude: number | null;
  longitude: number | null;
}

export interface CnpjSearchResult {
  items: CnpjCompanyRecord[];
  page: number;
  pageSize: number;
  total: number;
}

export interface CnpjScanCursor {
  cnpjBasico: string;
  cnpjOrdem: string;
  cnpjDv: string;
}

export interface CnpjScanResult {
  items: CnpjCompanyRecord[];
  nextCursor: CnpjScanCursor | null;
}

type DatabaseRow = Record<string, unknown>;

const SELECT_FIELDS = `
  e.cnpj_basico || e.cnpj_ordem || e.cnpj_dv AS cnpj,
  e.cnpj_basico AS cnpj_basico,
  em.razao_social AS company_name,
  e.nome_fantasia AS trade_name,
  em.natureza_juridica AS legal_nature,
  nj.descricao AS legal_nature_description,
  em.porte AS porte,
  em.capital_social AS capital_social,
  e.identificador_matriz_filial AS establishment_type,
  e.situacao_cadastral AS status,
  e.data_inicio_atividade::text AS opened_at,
  e.cnae_fiscal_principal AS cnae_primary,
  primary_cnae.descricao AS cnae_primary_description,
  COALESCE(string_to_array(NULLIF(e.cnae_fiscal_secundaria, ''), ','), ARRAY[]::text[]) AS cnae_secondary,
  NULLIF(btrim(concat_ws(', ', NULLIF(btrim(concat_ws(' ', NULLIF(btrim(e.tipo_logradouro), ''), NULLIF(btrim(e.logradouro), ''))), ''), NULLIF(btrim(e.numero), ''), NULLIF(btrim(e.complemento), ''))), '') AS address,
  e.bairro AS neighborhood,
  e.cep AS postal_code,
  m.descricao AS city,
  e.uf AS state,
  ${PHONE_1} AS phone_1,
  ${PHONE_2} AS phone_2,
  e.correio_eletronico AS email,
  CASE WHEN simples.opcao_pelo_simples = 'S' THEN true WHEN simples.opcao_pelo_simples IS NULL THEN NULL ELSE false END AS simples,
  CASE WHEN simples.opcao_pelo_mei = 'S' THEN true WHEN simples.opcao_pelo_mei IS NULL THEN NULL ELSE false END AS mei`;

const FROM_CNPJ = `
  FROM cnpj.estabelecimentos e
  INNER JOIN cnpj.empresas em ON em.cnpj_basico = e.cnpj_basico
  LEFT JOIN cnpj.cnaes primary_cnae ON primary_cnae.codigo = e.cnae_fiscal_principal
  LEFT JOIN cnpj.municipios m ON m.codigo = e.municipio
  LEFT JOIN cnpj.naturezas_juridicas nj ON nj.codigo = em.natureza_juridica
  LEFT JOIN cnpj.dados_simples simples ON simples.cnpj_basico = e.cnpj_basico`;

const SEARCH_KEY_FROM = `
  FROM cnpj.estabelecimentos e
  INNER JOIN cnpj.empresas em ON em.cnpj_basico = e.cnpj_basico
  LEFT JOIN cnpj.municipios m ON m.codigo = e.municipio`;

const SEARCH_DETAIL_JOINS = `
  LEFT JOIN cnpj.estabelecimentos e
    ON e.cnpj_basico = paged_keys.cnpj_basico
    AND e.cnpj_ordem = paged_keys.cnpj_ordem
    AND e.cnpj_dv = paged_keys.cnpj_dv
  LEFT JOIN cnpj.empresas em ON em.cnpj_basico = e.cnpj_basico
  LEFT JOIN cnpj.cnaes primary_cnae ON primary_cnae.codigo = e.cnae_fiscal_principal
  LEFT JOIN cnpj.municipios m ON m.codigo = e.municipio
  LEFT JOIN cnpj.naturezas_juridicas nj ON nj.codigo = em.natureza_juridica
  LEFT JOIN cnpj.dados_simples simples ON simples.cnpj_basico = e.cnpj_basico`;

const SORT_COLUMNS: Readonly<Record<string, string>> = {
  cnpj: "cnpj",
  companyName: "company_name",
  tradeName: "trade_name",
  city: "city",
  openedAt: "opened_at",
  capital: "capital_social"
};

function escapeLike(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function accentFold(expression: string) {
  return `translate(lower(${expression}), '${ACCENTED_LOWERCASE}', '${ASCII_EQUIVALENTS}')`;
}

function splitCnpj(cnpj: string) {
  return [cnpj.slice(0, 8), cnpj.slice(8, 12), cnpj.slice(12, 14)] as const;
}

function boundedInteger(value: unknown, fallback: number, max: number) {
  const number = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(Math.max(number, 1), max);
}

function nullableString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function nullableNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function nullableBoolean(value: unknown) {
  return typeof value === "boolean" ? value : null;
}

function toRecord(row: DatabaseRow): CnpjCompanyRecord {
  return {
    cnpj: String(row.cnpj ?? ""),
    cnpjBasico: String(row.cnpj_basico ?? ""),
    companyName: nullableString(row.company_name),
    tradeName: nullableString(row.trade_name),
    legalNature: nullableString(row.legal_nature),
    legalNatureDescription: nullableString(row.legal_nature_description),
    porte: nullableString(row.porte),
    capitalSocial: nullableNumber(row.capital_social),
    establishmentType: nullableNumber(row.establishment_type),
    status: nullableString(row.status),
    openedAt: nullableString(row.opened_at),
    cnaePrimary: nullableString(row.cnae_primary),
    cnaePrimaryDescription: nullableString(row.cnae_primary_description),
    cnaeSecondary: Array.isArray(row.cnae_secondary)
      ? row.cnae_secondary.filter((value): value is string => typeof value === "string").map((value) => value.trim()).filter(Boolean)
      : [],
    address: nullableString(row.address),
    neighborhood: nullableString(row.neighborhood),
    postalCode: nullableString(row.postal_code),
    city: nullableString(row.city),
    state: nullableString(row.state),
    phone1: nullableString(row.phone_1),
    phone2: nullableString(row.phone_2),
    email: nullableString(row.email),
    simples: nullableBoolean(row.simples),
    mei: nullableBoolean(row.mei),
    latitude: nullableNumber(row.latitude),
    longitude: nullableNumber(row.longitude)
  };
}

export class CnpjRepository {
  constructor(private readonly client?: CnpjQueryClient | null) {}

  async findByCnpj(cnpj: string): Promise<CnpjCompanyRecord | null> {
    const [cnpjBasico, cnpjOrdem, cnpjDv] = splitCnpj(normalizeCnpj(cnpj));
    const rows = await this.query(`SELECT ${SELECT_FIELDS} ${FROM_CNPJ}
      WHERE e.cnpj_basico = $1 AND e.cnpj_ordem = $2 AND e.cnpj_dv = $3`, [
      cnpjBasico,
      cnpjOrdem,
      cnpjDv
    ]);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async findByCnpjs(cnpjs: readonly string[]): Promise<CnpjCompanyRecord[]> {
    const normalized = [...new Set(cnpjs.map((cnpj) => normalizeCnpj(cnpj)))];
    if (normalized.length === 0) return [];
    if (normalized.length > MAX_EXACT_BATCH_SIZE) throw new CnpjBatchLimitError();
    const values: string[] = [];
    const tuples = normalized.map((cnpj) => {
      const [cnpjBasico, cnpjOrdem, cnpjDv] = splitCnpj(cnpj);
      values.push(cnpjBasico, cnpjOrdem, cnpjDv);
      return `($${values.length - 2}, $${values.length - 1}, $${values.length})`;
    });
    const rows = await this.query(`WITH requested(cnpj_basico, cnpj_ordem, cnpj_dv) AS (
      VALUES ${tuples.join(", ")}
    )
    SELECT ${SELECT_FIELDS}
    FROM requested
    INNER JOIN cnpj.estabelecimentos e
      ON e.cnpj_basico = requested.cnpj_basico
      AND e.cnpj_ordem = requested.cnpj_ordem
      AND e.cnpj_dv = requested.cnpj_dv
    INNER JOIN cnpj.empresas em ON em.cnpj_basico = e.cnpj_basico
    LEFT JOIN cnpj.cnaes primary_cnae ON primary_cnae.codigo = e.cnae_fiscal_principal
    LEFT JOIN cnpj.municipios m ON m.codigo = e.municipio
    LEFT JOIN cnpj.naturezas_juridicas nj ON nj.codigo = em.natureza_juridica
    LEFT JOIN cnpj.dados_simples simples ON simples.cnpj_basico = e.cnpj_basico
    ORDER BY e.cnpj_basico, e.cnpj_ordem, e.cnpj_dv`, values);
    return rows.map(toRecord);
  }

  async getCompanyProfile(cnpj: string): Promise<CnpjCompanyRecord | null> {
    return this.findByCnpj(cnpj);
  }

  async searchCompanies(filters: CnpjSearchFilters = {}): Promise<CnpjSearchResult> {
    return this.search(filters, "e.identificador_matriz_filial = 1");
  }

  async searchEstablishments(filters: CnpjSearchFilters = {}): Promise<CnpjSearchResult> {
    return this.search(filters);
  }

  async findSimilarCandidates(input: CnpjSimilarCandidatesInput = {}): Promise<CnpjCompanyRecord[]> {
    const values: unknown[] = [];
    const sharedWhere: string[] = ["e.situacao_cadastral = '02'"];
    if (input.seedCnpj) {
      const [cnpjBasico, cnpjOrdem, cnpjDv] = splitCnpj(normalizeCnpj(input.seedCnpj));
      values.push(cnpjBasico, cnpjOrdem, cnpjDv);
      sharedWhere.push(`NOT (e.cnpj_basico = $${values.length - 2} AND e.cnpj_ordem = $${values.length - 1} AND e.cnpj_dv = $${values.length})`);
      values.push(cnpjBasico);
      sharedWhere.push(`e.cnpj_basico <> $${values.length}`);
    }

    const seedCnaes = [...new Set([
      input.cnaePrimary,
      ...(input.cnaeSecondary ?? [])
    ].map((value) => value?.trim()).filter((value): value is string => Boolean(value)))].slice(0, 50);
    const seedPrefixes = [...new Set(seedCnaes.map((value) => value.replace(/[^0-9A-Za-z]/g, "").slice(0, 3)).filter((value) => value.length === 3))];
    const buckets: Array<{ rank: number; condition: string; limit: number; orderPrefix?: string }> = [];
    if (seedCnaes.length > 0) {
      values.push(seedCnaes);
      const cnaes = `$${values.length}::text[]`;
      const primaryCnae = input.cnaePrimary?.trim();
      let primaryOrder: string | undefined;
      if (primaryCnae) {
        values.push(primaryCnae);
        primaryOrder = `CASE WHEN e.cnae_fiscal_principal = $${values.length} THEN 0 ELSE 1 END,`;
      }
      buckets.push({
        rank: 0,
        condition: `e.cnae_fiscal_principal = ANY(${cnaes})`,
        limit: SIMILAR_BUCKET_LIMITS.exactPrimary,
        ...(primaryOrder ? { orderPrefix: primaryOrder } : {})
      });
      buckets.push({
        rank: 1,
        condition: `string_to_array(e.cnae_fiscal_secundaria, ',') && ${cnaes}`,
        limit: SIMILAR_BUCKET_LIMITS.exactSecondary
      });
    }
    if (seedPrefixes.length > 0) {
      values.push(seedPrefixes);
      const prefixes = `$${values.length}::text[]`;
      buckets.push({
        rank: 2,
        condition: `left(e.cnae_fiscal_principal, 3) = ANY(${prefixes})`,
        limit: SIMILAR_BUCKET_LIMITS.cnaeGroup
      });
    }
    const state = input.state?.trim().toUpperCase();
    const cityText = input.city?.trim();
    let cityExpression: string | undefined;
    if (cityText) {
      values.push(cityText);
      const city = `$${values.length}`;
      cityExpression = `${accentFold("m.descricao")} = ${accentFold(city)}`;
    }
    if (state) {
      values.push(state);
      buckets.push({
        rank: 3,
        condition: `e.uf = $${values.length}`,
        limit: SIMILAR_BUCKET_LIMITS.location,
        ...(cityExpression ? { orderPrefix: `CASE WHEN ${cityExpression} THEN 0 ELSE 1 END,` } : {})
      });
    } else if (cityExpression) {
      buckets.push({
        rank: 3,
        condition: cityExpression,
        limit: SIMILAR_BUCKET_LIMITS.location
      });
    }
    const profileConditions: string[] = [];
    if (input.porte?.trim()) {
      values.push(input.porte.trim());
      profileConditions.push(`em.porte = $${values.length}`);
    }
    if (input.legalNature?.trim()) {
      values.push(input.legalNature.trim());
      profileConditions.push(`em.natureza_juridica = $${values.length}`);
    }
    if (profileConditions.length > 0) {
      buckets.push({
        rank: 4,
        condition: `(${profileConditions.join(" AND ")})`,
        limit: SIMILAR_BUCKET_LIMITS.profile
      });
    }

    const limit = boundedInteger(input.limit, 25, MAX_SIMILAR_CANDIDATES);
    values.push(limit);
    const bucketSql = buckets.length > 0
      ? buckets.map(({ rank, condition, limit: bucketLimit, orderPrefix = "" }) => `(SELECT
          e.cnpj_basico, e.cnpj_ordem, e.cnpj_dv, ${rank} AS coarse_relevance
        ${SEARCH_KEY_FROM}
        WHERE ${sharedWhere.join(" AND ")} AND ${condition}
        ORDER BY ${orderPrefix} e.cnpj_basico ASC, e.cnpj_ordem ASC, e.cnpj_dv ASC
        LIMIT ${bucketLimit})`).join("\n        UNION ALL\n        ")
      : `(SELECT e.cnpj_basico, e.cnpj_ordem, e.cnpj_dv, 9 AS coarse_relevance
        ${SEARCH_KEY_FROM}
        WHERE ${sharedWhere.join(" AND ")} AND false
        LIMIT 0)`;
    const rows = await this.query(`WITH candidate_keys AS (
      ${bucketSql}
    ), paged_keys AS (
      SELECT cnpj_basico, cnpj_ordem, cnpj_dv, MIN(coarse_relevance) AS coarse_relevance
      FROM candidate_keys
      GROUP BY cnpj_basico, cnpj_ordem, cnpj_dv
      ORDER BY coarse_relevance ASC, cnpj_basico ASC, cnpj_ordem ASC, cnpj_dv ASC
      LIMIT $${values.length}
    )
    SELECT ${SELECT_FIELDS}
    FROM paged_keys
    ${SEARCH_DETAIL_JOINS}
    ORDER BY paged_keys.coarse_relevance ASC, e.cnpj_basico ASC, e.cnpj_ordem ASC, e.cnpj_dv ASC`, values);
    return rows.map(toRecord);
  }

  async countEstablishments(filters: CnpjSearchFilters = {}) {
    const { values, where } = this.buildFilter(filters);
    const rows = await this.query(`SELECT COUNT(*)::text AS total
      ${SEARCH_KEY_FROM}
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`, values);
    return Number(rows[0]?.total ?? 0) || 0;
  }

  async scanEstablishments(input: {
    filters?: CnpjSearchFilters;
    cursor?: CnpjScanCursor | null;
    limit?: number;
  } = {}): Promise<CnpjScanResult> {
    const { values, where, bind } = this.buildFilter(input.filters ?? {});
    if (input.cursor) {
      const base = bind(input.cursor.cnpjBasico);
      const order = bind(input.cursor.cnpjOrdem);
      const dv = bind(input.cursor.cnpjDv);
      where.push(`(e.cnpj_basico, e.cnpj_ordem, e.cnpj_dv) > (${base}, ${order}, ${dv})`);
    }
    const limit = boundedInteger(input.limit, 100, MAX_PAGE_SIZE);
    values.push(limit);
    const rows = await this.query(`WITH paged_keys AS (
      SELECT e.cnpj_basico, e.cnpj_ordem, e.cnpj_dv
      ${SEARCH_KEY_FROM}
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY e.cnpj_basico ASC, e.cnpj_ordem ASC, e.cnpj_dv ASC
      LIMIT $${values.length}
    )
    SELECT ${SELECT_FIELDS}
    FROM paged_keys
    ${SEARCH_DETAIL_JOINS}
    ORDER BY e.cnpj_basico ASC, e.cnpj_ordem ASC, e.cnpj_dv ASC`, values);
    const items = rows.map(toRecord);
    const last = items.at(-1);
    return {
      items,
      nextCursor: last && items.length === limit
        ? { cnpjBasico: last.cnpj.slice(0, 8), cnpjOrdem: last.cnpj.slice(8, 12), cnpjDv: last.cnpj.slice(12, 14) }
        : null
    };
  }

  private buildFilter(filters: CnpjSearchFilters, initialWhere?: string) {
    const values: unknown[] = [];
    const where = initialWhere ? [initialWhere] : [];
    const bind = (value: unknown) => {
      values.push(value);
      return `$${values.length}`;
    };
    const like = (column: string, value: string | undefined, accentInsensitive = false) => {
      if (value?.trim()) {
        const placeholder = bind(`%${escapeLike(value.trim())}%`);
        const columnExpression = accentInsensitive ? accentFold(column) : `LOWER(${column})`;
        const valueExpression = accentInsensitive ? accentFold(placeholder) : `LOWER(${placeholder})`;
        where.push(`${columnExpression} LIKE ${valueExpression} ESCAPE '\\'`);
      }
    };
    if (filters.cnpj?.trim()) {
      const [cnpjBasico, cnpjOrdem, cnpjDv] = splitCnpj(normalizeCnpj(filters.cnpj));
      where.push(`e.cnpj_basico = ${bind(cnpjBasico)} AND e.cnpj_ordem = ${bind(cnpjOrdem)} AND e.cnpj_dv = ${bind(cnpjDv)}`);
    }
    like("em.razao_social", filters.companyName, true);
    like("e.nome_fantasia", filters.tradeName, true);
    like("m.descricao", filters.city, true);
    if (filters.state?.trim()) where.push(`e.uf = ${bind(filters.state.trim().toUpperCase())}`);
    if (filters.cnaePrimary?.trim()) where.push(`e.cnae_fiscal_principal = ${bind(filters.cnaePrimary.trim())}`);
    if (filters.cnaeSecondary?.trim()) where.push(`EXISTS (SELECT 1 FROM unnest(string_to_array(COALESCE(e.cnae_fiscal_secundaria, ''), ',')) AS secondary_cnae(code) WHERE btrim(secondary_cnae.code) = ${bind(filters.cnaeSecondary.trim())})`);
    if (filters.porte?.trim()) where.push(`em.porte = ${bind(filters.porte.trim())}`);
    if (filters.openedFrom?.trim()) where.push(`e.data_inicio_atividade >= ${bind(filters.openedFrom.trim())}`);
    if (filters.openedTo?.trim()) where.push(`e.data_inicio_atividade <= ${bind(filters.openedTo.trim())}`);
    if (typeof filters.capitalMin === "number" && Number.isFinite(filters.capitalMin)) where.push(`em.capital_social >= ${bind(filters.capitalMin)}`);
    if (typeof filters.capitalMax === "number" && Number.isFinite(filters.capitalMax)) where.push(`em.capital_social <= ${bind(filters.capitalMax)}`);
    if (filters.phone?.trim()) {
      const placeholder = bind(`%${escapeLike(filters.phone.trim())}%`);
      where.push(`(LOWER(${PHONE_1}) LIKE LOWER(${placeholder}) ESCAPE '\\' OR LOWER(${PHONE_2}) LIKE LOWER(${placeholder}) ESCAPE '\\')`);
    }
    like("e.correio_eletronico", filters.email);
    if (filters.hasPhone === true) where.push("(NULLIF(btrim(e.telefone_1), '') IS NOT NULL OR NULLIF(btrim(e.telefone_2), '') IS NOT NULL)");
    else if (filters.hasPhone === false) where.push("(NULLIF(btrim(e.telefone_1), '') IS NULL AND NULLIF(btrim(e.telefone_2), '') IS NULL)");
    if (filters.hasEmail === true) where.push("NULLIF(btrim(e.correio_eletronico), '') IS NOT NULL");
    else if (filters.hasEmail === false) where.push("NULLIF(btrim(e.correio_eletronico), '') IS NULL");
    if (filters.activeOnly) where.push("e.situacao_cadastral = '02'");
    return { values, where, bind };
  }

  private async search(filters: CnpjSearchFilters, initialWhere?: string): Promise<CnpjSearchResult> {
    const { values, where } = this.buildFilter(filters, initialWhere);

    const page = boundedInteger(filters.page, 1, MAX_PAGE);
    const pageSize = boundedInteger(filters.pageSize, 25, MAX_PAGE_SIZE);
    const sort = SORT_COLUMNS[filters.sortBy ?? ""] ?? "company_name";
    const direction = filters.sortDirection === "DESC" ? "DESC" : "ASC";
    values.push(pageSize, (page - 1) * pageSize);
    const rows = await this.query(`WITH filtered_keys AS NOT MATERIALIZED (
      SELECT
        e.cnpj_basico,
        e.cnpj_ordem,
        e.cnpj_dv,
        e.cnpj_basico || e.cnpj_ordem || e.cnpj_dv AS cnpj,
        em.razao_social AS company_name,
        e.nome_fantasia AS trade_name,
        m.descricao AS city,
        e.data_inicio_atividade AS opened_at,
        em.capital_social AS capital_social
      ${SEARCH_KEY_FROM}
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ), counted AS (
      SELECT COUNT(*)::text AS total FROM filtered_keys
    ), paged_keys AS (
      SELECT * FROM filtered_keys
      ORDER BY ${sort} ${direction} NULLS LAST, cnpj ASC NULLS LAST
      LIMIT $${values.length - 1} OFFSET $${values.length}
    )
    SELECT ${SELECT_FIELDS}, counted.total
    FROM counted
    LEFT JOIN paged_keys ON true
    ${SEARCH_DETAIL_JOINS}
    ORDER BY paged_keys.${sort} ${direction} NULLS LAST, paged_keys.cnpj ASC NULLS LAST`, values);
    return {
      items: rows.filter((row) => typeof row.cnpj === "string" && row.cnpj.length > 0).map(toRecord),
      page,
      pageSize,
      total: rows[0] ? Number(rows[0].total ?? 0) || 0 : 0
    };
  }

  private async query(text: string, values: readonly unknown[]) {
    if (!this.client) throw new LeadSourceUnavailableError();
    try {
      return (await this.client.query<DatabaseRow>(text, values)).rows;
    } catch {
      throw new LeadSourceUnavailableError();
    }
  }
}
