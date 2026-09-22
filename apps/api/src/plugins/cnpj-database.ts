import { Pool } from "pg";
import fp from "fastify-plugin";

/** The deliberately small read-only surface exposed to lead-source code. */
export interface CnpjQueryClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[]
  ): Promise<{ rows: Row[]; rowCount: number | null }>;
}

declare module "fastify" {
  interface FastifyInstance {
    /** Undefined when no separate Receita/CNPJ database has been configured. */
    cnpj?: CnpjQueryClient;
  }
}

export interface CnpjDatabasePluginOptions {
  databaseUrl: string;
  pool?: Pick<Pool, "connect" | "end">;
}

export class CnpjQueryRejectedError extends Error {
  constructor() {
    super("CNPJ query was rejected.");
    this.name = "CnpjQueryRejectedError";
  }
}

function assertReadOnlyQuery(text: string) {
  const startsWithReadQuery = /^(?:SELECT|WITH)\b/i.test(text.trim());
  const containsStatementBoundary = text.includes(";");
  const containsWriteOrTransactionControl =
    /\b(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|INSERT|UPDATE|DELETE|MERGE|ALTER|DROP|CREATE|GRANT|REVOKE|COPY|TRUNCATE)\b/i.test(
      text
    );
  if (!startsWithReadQuery || containsStatementBoundary || containsWriteOrTransactionControl) {
    throw new CnpjQueryRejectedError();
  }
}

class ReadOnlyPoolQueryClient implements CnpjQueryClient {
  constructor(private readonly pool: Pick<Pool, "connect">) {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = []
  ): Promise<{ rows: Row[]; rowCount: number | null }> {
    assertReadOnlyQuery(text);
    const client = await this.pool.connect();
    let transactionStarted = false;
    try {
      // A session role alone is not sufficient: pin each repository statement to a read-only tx.
      await client.query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY");
      await client.query("BEGIN READ ONLY");
      transactionStarted = true;
      const result = await client.query<Row>(text, [...values]);
      await client.query("COMMIT");
      transactionStarted = false;
      return { rows: result.rows, rowCount: result.rowCount };
    } catch (error) {
      if (transactionStarted) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // Preserve the original error; callers must never receive connection details either way.
        }
      }
      throw error;
    } finally {
      client.release();
    }
  }
}

export const cnpjDatabasePlugin = fp<CnpjDatabasePluginOptions>(async (app, options) => {
  const pool =
    options.pool ??
    new Pool({
      connectionString: options.databaseUrl,
      max: 3,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 5_000
    });

  app.decorate("cnpj", new ReadOnlyPoolQueryClient(pool));
  app.addHook("onClose", async () => {
    await pool.end();
  });
});
