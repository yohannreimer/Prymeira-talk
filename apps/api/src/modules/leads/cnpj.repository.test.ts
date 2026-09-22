import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  cnpjDatabasePlugin,
  type CnpjQueryClient
} from "../../plugins/cnpj-database.js";
import {
  CnpjRepository,
  LeadSourceUnavailableError
} from "./cnpj.repository.js";

class FakeCnpjClient implements CnpjQueryClient {
  readonly calls: Array<{ text: string; values: readonly unknown[] }> = [];

  constructor(private readonly rows: Record<string, unknown>[] = []) {}

  async query<Row extends Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = []
  ) {
    this.calls.push({ text, values });
    return { rows: this.rows as Row[], rowCount: this.rows.length };
  }
}

describe("CnpjRepository", () => {
  it("normalizes an alphanumeric CNPJ into indexable text segments for the lookup", async () => {
    const client = new FakeCnpjClient([
      { cnpj: "12345678ABCD90", cnpj_basico: "12345678", opened_at: "2024-02-03" }
    ]);
    const repository = new CnpjRepository(client);

    const result = await repository.findByCnpj("12.345.678/abcd-90");

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.values).toEqual(["12345678", "ABCD", "90"]);
    expect(client.calls[0]?.text).toContain(
      "e.cnpj_basico = $1 AND e.cnpj_ordem = $2 AND e.cnpj_dv = $3"
    );
    expect(client.calls[0]?.text).toContain("e.data_inicio_atividade::text AS opened_at");
    expect(result?.cnpj).toBe("12345678ABCD90");
    expect(result?.openedAt).toBe("2024-02-03");
  });

  it("performs one bounded, parameterized batch lookup using composite CNPJ components", async () => {
    const client = new FakeCnpjClient([
      { cnpj: "12345678ABCD90", cnpj_basico: "12345678" },
      { cnpj: "87654321WXYZ10", cnpj_basico: "87654321" }
    ]);

    const result = await new CnpjRepository(client).findByCnpjs([
      "12.345.678/abcd-90",
      "87654321WXYZ10",
      "12.345.678/ABCD-90"
    ]);

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.values).toEqual([
      "12345678", "ABCD", "90",
      "87654321", "WXYZ", "10"
    ]);
    expect(client.calls[0]?.text).toContain("WITH requested(cnpj_basico, cnpj_ordem, cnpj_dv) AS");
    expect(client.calls[0]?.text).toContain("e.cnpj_basico = requested.cnpj_basico");
    expect(client.calls[0]?.text).toContain("e.cnpj_ordem = requested.cnpj_ordem");
    expect(client.calls[0]?.text).toContain("e.cnpj_dv = requested.cnpj_dv");
    expect(result.map((row) => row.cnpj)).toEqual(["12345678ABCD90", "87654321WXYZ10"]);
  });

  it("rejects an oversized exact CNPJ batch before querying", async () => {
    const client = new FakeCnpjClient();
    const cnpjs = Array.from({ length: 101 }, (_, index) => `${String(index).padStart(8, "0")}ABCD90`);

    await expect(new CnpjRepository(client).findByCnpjs(cnpjs)).rejects.toMatchObject({
      code: "LEAD_LIMIT_EXCEEDED"
    });
    expect(client.calls).toHaveLength(0);
  });

  it("counts once and scans deterministic composite keys without OFFSET", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ total: "201" }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ cnpj: "12345678ABCD90", cnpj_basico: "12345678" }],
        rowCount: 1
      });
    const repository = new CnpjRepository({ query } as never);

    await expect(repository.countEstablishments({ state: "sp", activeOnly: true })).resolves.toBe(201);
    const page = await repository.scanEstablishments({
      filters: { state: "sp", activeOnly: true },
      cursor: { cnpjBasico: "11111111", cnpjOrdem: "AAAA", cnpjDv: "01" },
      limit: 25
    });

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]?.[0]).toContain("SELECT COUNT(*)::text AS total");
    expect(query.mock.calls[0]?.[1]).toEqual(["SP"]);
    const scanSql = query.mock.calls[1]?.[0] as string;
    expect(scanSql).toContain("(e.cnpj_basico, e.cnpj_ordem, e.cnpj_dv) > ($2, $3, $4)");
    expect(scanSql).toContain("ORDER BY e.cnpj_basico ASC, e.cnpj_ordem ASC, e.cnpj_dv ASC");
    expect(scanSql.indexOf("WITH paged_keys AS")).toBeLessThan(scanSql.indexOf("LEFT JOIN cnpj.cnaes primary_cnae"));
    expect(scanSql).not.toContain("OFFSET");
    expect(scanSql).not.toContain("COUNT(");
    expect(query.mock.calls[1]?.[1]).toEqual(["SP", "11111111", "AAAA", "01", 25]);
    expect(page.nextCursor).toBeNull();
  });

  it("splits an exact CNPJ search filter into the composite primary-key columns", async () => {
    const client = new FakeCnpjClient();

    await new CnpjRepository(client).searchEstablishments({ cnpj: "12.345.678/ABCD-90" });

    expect(client.calls[0]?.text).toContain(
      "e.cnpj_basico = $1 AND e.cnpj_ordem = $2 AND e.cnpj_dv = $3"
    );
    expect(client.calls[0]?.values.slice(0, 3)).toEqual(["12345678", "ABCD", "90"]);
  });

  it("binds malicious search text and escapes LIKE wildcards", async () => {
    const client = new FakeCnpjClient();
    const repository = new CnpjRepository(client);
    const needle = "x%' OR 1=1 --_\\";

    await repository.searchEstablishments({ companyName: needle, page: 0, pageSize: 9999 });

    const call = client.calls[0];
    expect(call?.text).toContain("LIKE translate(lower($1)");
    expect(call?.text).not.toContain(needle);
    expect(call?.values[0]).toBe("%x\\%' OR 1=1 --\\_\\\\%");
    expect(call?.values.slice(-2)).toEqual([100, 0]);
  });

  it("matches a phone filter against either phone column with one escaped bound placeholder", async () => {
    const client = new FakeCnpjClient();
    const needle = "11%_\\";

    await new CnpjRepository(client).searchEstablishments({ phone: needle });

    const call = client.calls[0];
    expect(call?.text).toContain(
      "(LOWER(CASE WHEN NULLIF(btrim(e.telefone_1), '') IS NULL THEN NULL ELSE concat_ws('', NULLIF(btrim(e.ddd_1), ''), NULLIF(btrim(e.telefone_1), '')) END) LIKE LOWER($1) ESCAPE '\\' OR LOWER(CASE WHEN NULLIF(btrim(e.telefone_2), '') IS NULL THEN NULL ELSE concat_ws('', NULLIF(btrim(e.ddd_2), ''), NULLIF(btrim(e.telefone_2), '')) END) LIKE LOWER($1) ESCAPE '\\')"
    );
    expect(call?.values[0]).toBe("%11\\%\\_\\\\%");
    expect(call?.text).not.toContain(needle);
    expect(call?.text).toContain("CASE WHEN NULLIF(btrim(e.telefone_1), '') IS NULL THEN NULL");
    expect(call?.text).toContain("concat_ws('', NULLIF(btrim(e.ddd_1), ''), NULLIF(btrim(e.telefone_1), ''))");
  });

  it("uses static accent folding and placeholders for company, trade name, and city search", async () => {
    const client = new FakeCnpjClient();
    const needle = "São %_ Paulo";

    await new CnpjRepository(client).searchEstablishments({
      companyName: needle,
      tradeName: needle,
      city: needle
    });

    const call = client.calls[0];
    expect(call?.text).toContain("translate(lower(em.razao_social), 'áàâãäå");
    expect(call?.text).toContain("translate(lower($1), 'áàâãäå");
    expect(call?.text).toContain("translate(lower(e.nome_fantasia)");
    expect(call?.text).toContain("translate(lower(m.descricao)");
    expect(call?.text).not.toContain(needle);
    expect(call?.values.slice(0, 3)).toEqual([
      "%São \\%\\_ Paulo%",
      "%São \\%\\_ Paulo%",
      "%São \\%\\_ Paulo%"
    ]);
  });

  it("matches a secondary CNAE as a comma-delimited item rather than a substring", async () => {
    const client = new FakeCnpjClient();
    const repository = new CnpjRepository(client);

    await repository.searchEstablishments({ cnaeSecondary: "6201501" });

    expect(client.calls[0]?.text).toContain("unnest(string_to_array(COALESCE(e.cnae_fiscal_secundaria, ''), ','))");
    expect(client.calls[0]?.text).toContain("btrim(secondary_cnae.code) = $1");
    expect(client.calls[0]?.values[0]).toBe("6201501");
  });

  it("maps supported filters and uses the exact active Receita code only when requested", async () => {
    const client = new FakeCnpjClient();
    const repository = new CnpjRepository(client);

    await repository.searchCompanies({
      tradeName: "Prymeira",
      city: "São Paulo",
      state: "SP",
      cnaePrimary: "6201500",
      porte: "03",
      openedFrom: "2020-01-01",
      openedTo: "2024-12-31",
      capitalMin: 100,
      capitalMax: 500,
      phone: "11999999999",
      email: "@example.com",
      activeOnly: true
    });

    const text = client.calls[0]?.text ?? "";
    expect(text).toContain("e.nome_fantasia");
    expect(text).toContain("m.descricao");
    expect(text).toContain("e.uf =");
    expect(text).toContain("e.cnae_fiscal_principal =");
    expect(text).toContain("em.porte =");
    expect(text).toContain("e.data_inicio_atividade >=");
    expect(text).toContain("em.capital_social >=");
    expect(text).toContain("e.situacao_cadastral = '02'");
    expect(text).toContain("NULLIF(btrim(e.ddd_1), '')");
    expect(text).toContain("e.correio_eletronico");

    const inactiveClient = new FakeCnpjClient();
    await new CnpjRepository(inactiveClient).searchCompanies({ activeOnly: false });
    expect(inactiveClient.calls[0]?.text).not.toContain("e.situacao_cadastral = '02'");
  });

  it("maps phone and email presence filters for both true and false values", async () => {
    const presentClient = new FakeCnpjClient();
    await new CnpjRepository(presentClient).searchEstablishments({ hasPhone: true, hasEmail: true });
    expect(presentClient.calls[0]?.text).toContain(
      "(NULLIF(btrim(e.telefone_1), '') IS NOT NULL OR NULLIF(btrim(e.telefone_2), '') IS NOT NULL)"
    );
    expect(presentClient.calls[0]?.text).toContain("NULLIF(btrim(e.correio_eletronico), '') IS NOT NULL");

    const absentClient = new FakeCnpjClient();
    await new CnpjRepository(absentClient).searchEstablishments({ hasPhone: false, hasEmail: false });
    expect(absentClient.calls[0]?.text).toContain(
      "(NULLIF(btrim(e.telefone_1), '') IS NULL AND NULLIF(btrim(e.telefone_2), '') IS NULL)"
    );
    expect(absentClient.calls[0]?.text).toContain("NULLIF(btrim(e.correio_eletronico), '') IS NULL");
  });

  it("uses a fixed sort whitelist and bounded pagination", async () => {
    const client = new FakeCnpjClient();
    const repository = new CnpjRepository(client);

    await repository.searchEstablishments({
      sortBy: "capital; DROP TABLE cnpj.empresas",
      sortDirection: "DESC; DROP TABLE cnpj.empresas",
      page: 2,
      pageSize: 101
    });

    const call = client.calls[0];
    expect(call?.text).toContain(
      "ORDER BY paged_keys.company_name ASC NULLS LAST, paged_keys.cnpj ASC NULLS LAST"
    );
    expect(call?.text).not.toContain("DROP TABLE");
    expect(call?.values.slice(-2)).toEqual([100, 100]);
  });

  it("keeps the total when the requested page is empty and filters the count sentinel from items", async () => {
    const client = new FakeCnpjClient([{ cnpj: null, total: "42" }]);

    const result = await new CnpjRepository(client).searchEstablishments({ page: 999, pageSize: 25 });

    expect(client.calls[0]?.text).toContain("WITH filtered_keys AS NOT MATERIALIZED");
    expect(client.calls[0]?.text).toContain("LEFT JOIN paged_keys ON true");
    expect(client.calls[0]?.text).toContain(
      "ORDER BY paged_keys.company_name ASC NULLS LAST, paged_keys.cnpj ASC NULLS LAST"
    );
    expect(result).toMatchObject({ items: [], page: 999, pageSize: 25, total: 42 });
  });

  it("paginates narrow keys before projecting details and preserves the whitelisted final ordering", async () => {
    const client = new FakeCnpjClient();

    await new CnpjRepository(client).searchEstablishments({
      sortBy: "capital",
      sortDirection: "DESC"
    });

    const text = client.calls[0]?.text ?? "";
    const pagedKeys = text.indexOf("paged_keys AS");
    const detailCnaeJoin = text.indexOf("LEFT JOIN cnpj.cnaes primary_cnae", pagedKeys);
    expect(text.slice(0, pagedKeys)).not.toContain("primary_cnae.descricao");
    expect(detailCnaeJoin).toBeGreaterThan(pagedKeys);
    expect(text).toContain(
      "ORDER BY paged_keys.capital_social DESC NULLS LAST, paged_keys.cnpj ASC NULLS LAST"
    );
  });

  it("preserves an address and phone when their optional prefixes are null", async () => {
    const client = new FakeCnpjClient([
      {
        cnpj: "12345678ABCD90",
        cnpj_basico: "12345678",
        address: "Rua Exemplo, 10",
        phone_1: "99999999"
      }
    ]);

    const result = await new CnpjRepository(client).findByCnpj("12.345.678/ABCD-90");

    expect(client.calls[0]?.text).toContain("NULLIF(btrim(concat_ws(', '");
    expect(client.calls[0]?.text).toContain("NULLIF(btrim(e.logradouro), '')");
    expect(result?.address).toBe("Rua Exemplo, 10");
    expect(result?.phone1).toBe("99999999");
  });

  it("excludes both the seed full CNPJ and root from bounded similarity candidates without scoring", async () => {
    const client = new FakeCnpjClient();
    const repository = new CnpjRepository(client);

    await repository.findSimilarCandidates({
      seedCnpj: "12.345.678/ABCD-90",
      limit: 9_999
    });

    const call = client.calls[0];
    expect(call?.text).toContain("NOT (e.cnpj_basico = $1 AND e.cnpj_ordem = $2 AND e.cnpj_dv = $3)");
    expect(call?.text).toContain("e.cnpj_basico <> $4");
    expect(call?.text).toContain("e.situacao_cadastral = '02'");
    expect(call?.text).not.toContain("score");
    expect(call?.values).toEqual(["12345678", "ABCD", "90", "12345678", 1_000]);
  });

  it("always excludes the complete seed root when a seed CNPJ is supplied", async () => {
    const client = new FakeCnpjClient();

    await new CnpjRepository(client).findSimilarCandidates({
      seedCnpj: "12.345.678/ABCD-90"
    });

    expect(client.calls[0]?.text).toContain("e.cnpj_basico <> $4");
    expect(client.calls[0]?.values).toEqual(["12345678", "ABCD", "90", "12345678", 25]);
  });

  it("builds a deduplicated active candidate pool from nationwide CNAE and location buckets", async () => {
    const client = new FakeCnpjClient();

    await new CnpjRepository(client).findSimilarCandidates({
      cnaePrimary: "6201500",
      cnaeSecondary: ["6311900"],
      city: "São Paulo",
      state: "sp"
    });

    const call = client.calls[0];
    expect(call?.text).toContain("e.situacao_cadastral = '02'");
    expect(call?.text).not.toContain("eligible AS MATERIALIZED");
    expect(call?.text).toContain("e.cnae_fiscal_principal = $1");
    expect(call?.text).toContain("e.cnae_fiscal_principal = ANY($2::text[])");
    expect(call?.text).toContain("string_to_array(e.cnae_fiscal_secundaria, ',') && $3::text[]");
    expect(call?.text).toContain("left(e.cnae_fiscal_principal, 3) = ANY($4::text[])");
    expect(call?.text).toContain("UNION ALL");
    expect(call?.text).toContain("MIN(coarse_relevance)");
    expect(call?.text).toContain("ORDER BY coarse_relevance ASC, cnpj_basico ASC");
    expect(call?.text).not.toContain("company_name ASC");
    expect(call?.text).not.toContain("ORDER BY CASE WHEN");
    expect(call?.values).toEqual([
      "6201500",
      ["6311900"],
      ["6201500", "6311900"],
      ["620", "631"],
      "São Paulo",
      "SP",
      25
    ]);
    const candidateSql = (call?.text ?? "").split("), paged_keys AS")[0] ?? "";
    expect(candidateSql).toContain("LIMIT 250)");
    expect(candidateSql).toContain("LIMIT 50)");
    expect(candidateSql).toContain("LIMIT 300)");
    expect(candidateSql).toContain("LIMIT 200)");
    expect(candidateSql).toContain("LIMIT 60)");
    expect(candidateSql).toContain("LIMIT 40)");
    expect(candidateSql.indexOf("LIMIT 250)")).toBeLessThan(candidateSql.indexOf("UNION ALL"));
    expect(call?.text).not.toContain("score");
  });

  it("fails closed with a stable typed error when the source is missing or unhealthy", async () => {
    await expect(new CnpjRepository().findByCnpj("12.345.678/ABCD-90")).rejects.toMatchObject({
      code: "LEAD_SOURCE_UNAVAILABLE"
    });

    const unhealthy: CnpjQueryClient = {
      query: async () => {
        throw new Error("postgresql://secret:credential@database/private");
      }
    };
    await expect(new CnpjRepository(unhealthy).searchCompanies()).rejects.toEqual(
      expect.objectContaining<Partial<LeadSourceUnavailableError>>({
        code: "LEAD_SOURCE_UNAVAILABLE",
        message: "CNPJ lead source is unavailable."
      })
    );
  });
});

describe("CNPJ database plugin", () => {
  it("executes each source query in a checked-out read-only transaction and closes its pool", async () => {
    const client = {
      query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
      release: vi.fn()
    };
    const pool = {
      connect: vi.fn(async () => client),
      end: vi.fn(async () => undefined)
    };
    const app = Fastify();
    await app.register(cnpjDatabasePlugin, {
      databaseUrl: "postgresql://not-a-real-database/test",
      pool: pool as never
    });

    await app.cnpj?.query("SELECT $1", ["safe"]);
    await app.close();

    const queryCalls = client.query.mock.calls as unknown as Array<readonly unknown[]>;
    expect(queryCalls.map(([text]) => text)).toEqual([
      "SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY",
      "BEGIN READ ONLY",
      "SELECT $1",
      "COMMIT"
    ]);
    expect(client.release).toHaveBeenCalledOnce();
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it("rejects multi-statement and transaction-control input before checking out a connection", async () => {
    const pool = {
      connect: vi.fn(),
      end: vi.fn(async () => undefined)
    };
    const app = Fastify();
    await app.register(cnpjDatabasePlugin, {
      databaseUrl: "postgresql://not-a-real-database/test",
      pool: pool as never
    });

    await expect(app.cnpj?.query("COMMIT; DELETE FROM cnpj.empresas")).rejects.toThrow(
      "CNPJ query was rejected."
    );
    expect(pool.connect).not.toHaveBeenCalled();
    await app.close();
  });

  it("discards a client if rollback fails while preserving the original query error", async () => {
    const queryError = new Error("query failed");
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockRejectedValueOnce(queryError)
        .mockRejectedValueOnce(new Error("rollback failed")),
      release: vi.fn()
    };
    const pool = {
      connect: vi.fn(async () => client),
      end: vi.fn(async () => undefined)
    };
    const app = Fastify();
    await app.register(cnpjDatabasePlugin, {
      databaseUrl: "postgresql://not-a-real-database/test",
      pool: pool as never
    });

    await expect(app.cnpj?.query("SELECT 1")).rejects.toBe(queryError);
    expect(client.release).toHaveBeenCalledWith(queryError);
    expect(client.release).toHaveBeenCalledTimes(1);
    await app.close();
  });
});
