import { Pool } from "pg";

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
  const pool = new Pool({
    connectionString,
    options: schema ? `-c search_path=${quotePgIdent(schema)},public` : undefined,
  });
  await pool.query("SELECT 1");
  return pool;
}

export function quotePgIdent(name: string): string {
  return `"${String(name).replace(/"/g, '""')}"`;
}

