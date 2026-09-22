import type { CnpjQueryClient } from "../../plugins/cnpj-database.js";
import { normalizeCnpj } from "./leads.types.js";

const MAX_PAGE_SIZE = 100;
const MAX_PAGE = 10_000;
const MAX_SIMILAR_CANDIDATES = 100;

export class LeadSourceUnavailableError extends Error {
  readonly code = "LEAD_SOURCE_UNAVAILABLE" as const;

  constructor() {
    super("CNPJ lead source is unavailable.");
    this.name = "LeadSourceUnavailableError";
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
  activeOnly?: boolean;
  page?: number;
  pageSize?: number;
  sortBy?: string;
  sortDirection?: string;
}

export interface CnpjSimilarCandidatesInput {
  seedCnpj?: string;
  /** Exclude every branch sharing the seed's eight-character company root. */
  excludeSeedRoot?: boolean;
  activeOnly?: boolean;
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
}

export interface CnpjSearchResult {
  items: CnpjCompanyRecord[];
  page: number;
  pageSize: number;
  total: number;
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
  e.data_inicio_atividade AS opened_at,
  e.cnae_fiscal_principal AS cnae_primary,
  primary_cnae.descricao AS cnae_primary_description,
  COALESCE(string_to_array(NULLIF(e.cnae_fiscal_secundaria, ''), ','), ARRAY[]::text[]) AS cnae_secondary,
  concat_ws(', ', NULLIF(e.tipo_logradouro || ' ' || e.logradouro, ''), NULLIF(e.numero, ''), NULLIF(e.complemento, '')) AS address,
  e.bairro AS neighborhood,
  e.cep AS postal_code,
  m.descricao AS city,
  e.uf AS state,
  NULLIF(e.ddd_1 || e.telefone_1, '') AS phone_1,
  NULLIF(e.ddd_2 || e.telefone_2, '') AS phone_2,
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
    mei: nullableBoolean(row.mei)
  };
}

export class CnpjRepository {
  constructor(private readonly client?: CnpjQueryClient | null) {}

  async findByCnpj(cnpj: string): Promise<CnpjCompanyRecord | null> {
    const normalizedCnpj = normalizeCnpj(cnpj);
    const rows = await this.query(`SELECT ${SELECT_FIELDS} ${FROM_CNPJ}
      WHERE e.cnpj_basico || e.cnpj_ordem || e.cnpj_dv = $1`, [normalizedCnpj]);
    return rows[0] ? toRecord(rows[0]) : null;
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
    const where: string[] = [];
    if (input.seedCnpj) {
      const seedCnpj = normalizeCnpj(input.seedCnpj);
      values.push(seedCnpj);
      where.push(`e.cnpj_basico || e.cnpj_ordem || e.cnpj_dv <> $${values.length}`);
      if (input.excludeSeedRoot) {
        values.push(seedCnpj.slice(0, 8));
        where.push(`e.cnpj_basico <> $${values.length}`);
      }
    }
    if (input.activeOnly) where.push("e.situacao_cadastral = '02'");
    const limit = boundedInteger(input.limit, 25, MAX_SIMILAR_CANDIDATES);
    values.push(limit);
    const rows = await this.query(`SELECT ${SELECT_FIELDS} ${FROM_CNPJ}
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY company_name ASC, cnpj ASC
      LIMIT $${values.length}`, values);
    return rows.map(toRecord);
  }

  private async search(filters: CnpjSearchFilters, initialWhere?: string): Promise<CnpjSearchResult> {
    const values: unknown[] = [];
    const where = initialWhere ? [initialWhere] : [];
    const bind = (value: unknown) => {
      values.push(value);
      return `$${values.length}`;
    };
    const like = (column: string, value: string | undefined) => {
      if (value?.trim()) where.push(`LOWER(${column}) LIKE LOWER(${bind(`%${escapeLike(value.trim())}%`)}) ESCAPE '\\'`);
    };

    if (filters.cnpj?.trim()) where.push(`e.cnpj_basico || e.cnpj_ordem || e.cnpj_dv = ${bind(normalizeCnpj(filters.cnpj))}`);
    like("em.razao_social", filters.companyName);
    like("e.nome_fantasia", filters.tradeName);
    like("m.descricao", filters.city);
    if (filters.state?.trim()) where.push(`e.uf = ${bind(filters.state.trim().toUpperCase())}`);
    if (filters.cnaePrimary?.trim()) where.push(`e.cnae_fiscal_principal = ${bind(filters.cnaePrimary.trim())}`);
    if (filters.cnaeSecondary?.trim()) {
      where.push(`EXISTS (SELECT 1 FROM unnest(string_to_array(COALESCE(e.cnae_fiscal_secundaria, ''), ',')) AS secondary_cnae(code) WHERE btrim(secondary_cnae.code) = ${bind(filters.cnaeSecondary.trim())})`);
    }
    if (filters.porte?.trim()) where.push(`em.porte = ${bind(filters.porte.trim())}`);
    if (filters.openedFrom?.trim()) where.push(`e.data_inicio_atividade >= ${bind(filters.openedFrom.trim())}`);
    if (filters.openedTo?.trim()) where.push(`e.data_inicio_atividade <= ${bind(filters.openedTo.trim())}`);
    if (typeof filters.capitalMin === "number" && Number.isFinite(filters.capitalMin)) where.push(`em.capital_social >= ${bind(filters.capitalMin)}`);
    if (typeof filters.capitalMax === "number" && Number.isFinite(filters.capitalMax)) where.push(`em.capital_social <= ${bind(filters.capitalMax)}`);
    like("e.ddd_1 || e.telefone_1", filters.phone);
    if (filters.phone?.trim()) like("e.ddd_2 || e.telefone_2", filters.phone);
    like("e.correio_eletronico", filters.email);
    if (filters.activeOnly) where.push("e.situacao_cadastral = '02'");

    const page = boundedInteger(filters.page, 1, MAX_PAGE);
    const pageSize = boundedInteger(filters.pageSize, 25, MAX_PAGE_SIZE);
    const sort = SORT_COLUMNS[filters.sortBy ?? ""] ?? "company_name";
    const direction = filters.sortDirection === "DESC" ? "DESC" : "ASC";
    values.push(pageSize, (page - 1) * pageSize);
    const rows = await this.query(`SELECT ${SELECT_FIELDS}, COUNT(*) OVER() AS total ${FROM_CNPJ}
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY ${sort} ${direction}, cnpj ASC
      LIMIT $${values.length - 1} OFFSET $${values.length}`, values);
    return {
      items: rows.map(toRecord),
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
