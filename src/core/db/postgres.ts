import { Pool } from "pg";

export type PgQueryable = Pick<Pool, "query">;

export type PostgresSchemaMap = {
  main: string;
  ticket: string;
  messageLog: string;
  messageAttachment: string;
  vcTime: string;
  aiHistory: string;
  automod: string;
  reminder: string;
};

export async function createPgPool(connectionString: string, schema?: string): Promise<Pool> {
  if (schema) {
    const setupPool = new Pool({ connectionString });
    try {
      await setupPool.query(`CREATE SCHEMA IF NOT EXISTS ${quotePgIdent(schema)}`);
    } finally {
      await setupPool.end();
    }
  }
  const pool = new Pool({
    connectionString,
    options: schema ? `-c search_path=${pgSearchPathOption(schema)},public` : undefined,
  });
  await pool.query("SELECT 1");
  if (schema) {
    const result = await pool.query<{ schema: string | null }>("SELECT current_schema() AS schema");
    const actual = result.rows[0]?.schema ?? null;
    if (actual !== schema) {
      await pool.end();
      throw new Error(`PostgreSQL search_path resolved to ${actual ?? "<none>"}; expected ${schema}`);
    }
  }
  return pool;
}

export function quotePgIdent(name: string): string {
  return `"${String(name).replace(/"/g, '""')}"`;
}

export function pgSearchPathOption(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : quotePgIdent(name);
}

