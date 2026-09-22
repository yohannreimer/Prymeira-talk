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
  it("normalizes an alphanumeric CNPJ and uses a placeholder for the lookup", async () => {
    const client = new FakeCnpjClient([{ cnpj: "12345678ABCD90" }]);
    const repository = new CnpjRepository(client);

    await repository.findByCnpj("12.345.678/abcd-90");

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.values).toContain("12345678ABCD90");
    expect(client.calls[0]?.text).toContain("e.cnpj_basico || e.cnpj_ordem || e.cnpj_dv = $1");
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
      "(LOWER(e.ddd_1 || e.telefone_1) LIKE LOWER($1) ESCAPE '\\' OR LOWER(e.ddd_2 || e.telefone_2) LIKE LOWER($1) ESCAPE '\\')"
    );
    expect(call?.values[0]).toBe("%11\\%\\_\\\\%");
    expect(call?.text).not.toContain(needle);
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
    expect(text).toContain("e.ddd_1 || e.telefone_1");
    expect(text).toContain("e.correio_eletronico");

    const inactiveClient = new FakeCnpjClient();
    await new CnpjRepository(inactiveClient).searchCompanies({ activeOnly: false });
    expect(inactiveClient.calls[0]?.text).not.toContain("e.situacao_cadastral = '02'");
  });

  it("maps phone and email presence filters for both true and false values", async () => {
    const presentClient = new FakeCnpjClient();
    await new CnpjRepository(presentClient).searchEstablishments({ hasPhone: true, hasEmail: true });
    expect(presentClient.calls[0]?.text).toContain(
      "(NULLIF(e.ddd_1 || e.telefone_1, '') IS NOT NULL OR NULLIF(e.ddd_2 || e.telefone_2, '') IS NOT NULL)"
    );
    expect(presentClient.calls[0]?.text).toContain("NULLIF(btrim(e.correio_eletronico), '') IS NOT NULL");

    const absentClient = new FakeCnpjClient();
    await new CnpjRepository(absentClient).searchEstablishments({ hasPhone: false, hasEmail: false });
    expect(absentClient.calls[0]?.text).toContain(
      "(NULLIF(e.ddd_1 || e.telefone_1, '') IS NULL AND NULLIF(e.ddd_2 || e.telefone_2, '') IS NULL)"
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
    expect(call?.text).toContain("ORDER BY company_name ASC, cnpj ASC");
    expect(call?.text).not.toContain("DROP TABLE");
    expect(call?.values.slice(-2)).toEqual([100, 100]);
  });

  it("excludes both the seed full CNPJ and root from bounded similarity candidates without scoring", async () => {
    const client = new FakeCnpjClient();
    const repository = new CnpjRepository(client);

    await repository.findSimilarCandidates({
      seedCnpj: "12.345.678/ABCD-90",
      excludeSeedRoot: true,
      limit: 999
    });

    const call = client.calls[0];
    expect(call?.text).toContain("e.cnpj_basico || e.cnpj_ordem || e.cnpj_dv <> $1");
    expect(call?.text).toContain("e.cnpj_basico <> $2");
    expect(call?.text).toContain("e.situacao_cadastral = '02'");
    expect(call?.text).not.toContain("score");
    expect(call?.values).toEqual(["12345678ABCD90", "12345678", 100]);
  });

  it("optionally narrows active similarity candidates by principal CNAE and UF without scoring", async () => {
    const client = new FakeCnpjClient();

    await new CnpjRepository(client).findSimilarCandidates({
      cnaePrimary: "6201500",
      state: "sp"
    });

    const call = client.calls[0];
    expect(call?.text).toContain("e.situacao_cadastral = '02'");
    expect(call?.text).toContain("e.cnae_fiscal_principal = $1");
    expect(call?.text).toContain("e.uf = $2");
    expect(call?.values).toEqual(["6201500", "SP", 25]);
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
});
