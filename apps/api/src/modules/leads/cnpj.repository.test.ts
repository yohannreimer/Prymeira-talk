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
    expect(call?.text).toContain("LIKE LOWER($1) ESCAPE '\\'");
    expect(call?.text).not.toContain(needle);
    expect(call?.values[0]).toBe("%x\\%' OR 1=1 --\\_\\\\%");
    expect(call?.values.slice(-2)).toEqual([100, 0]);
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
      activeOnly: true,
      limit: 999
    });

    const call = client.calls[0];
    expect(call?.text).toContain("e.cnpj_basico || e.cnpj_ordem || e.cnpj_dv <> $1");
    expect(call?.text).toContain("e.cnpj_basico <> $2");
    expect(call?.text).toContain("e.situacao_cadastral = '02'");
    expect(call?.text).not.toContain("score");
    expect(call?.values).toEqual(["12345678ABCD90", "12345678", 100]);
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
      "BEGIN READ ONLY",
      "SELECT $1",
      "COMMIT"
    ]);
    expect(client.release).toHaveBeenCalledOnce();
    expect(pool.end).toHaveBeenCalledOnce();
  });
});
