import "dotenv/config";
import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { loadConfig } from "../core/config.js";
import { createPgPool, quotePgIdent } from "../core/db/postgres.js";

type SourceDb = {
  label: string;
  path: string;
  schema: string;
};

function quoteSqliteIdent(name: string): string {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function sqliteTables(db: Database.Database): string[] {
  const rows = db
    .prepare(
      `
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%'
        AND name NOT LIKE '%_fts'
        AND name NOT LIKE '%_fts_%'
      ORDER BY name
    `,
    )
    .all() as { name: string }[];
  return rows.map((row) => row.name);
}

async function verifySource(pool: Awaited<ReturnType<typeof createPgPool>>, source: SourceDb): Promise<string[]> {
  const failures: string[] = [];
  if (!existsSync(source.path)) return failures;
  const sqlite = new Database(source.path, { readonly: true, fileMustExist: true });
  try {
    for (const table of sqliteTables(sqlite)) {
      const sqliteCount = (sqlite.prepare(`SELECT COUNT(*) AS count FROM ${quoteSqliteIdent(table)}`).get() as { count: number }).count;
      const pgCount = Number(
        (
          await pool.query(
            `SELECT COUNT(*) AS count FROM ${quotePgIdent(source.schema)}.${quotePgIdent(table)}`,
          )
        ).rows[0]?.count ?? 0,
      );
      if (sqliteCount !== pgCount) {
        failures.push(`${source.label}.${table}: sqlite=${sqliteCount}, postgres=${pgCount}`);
      } else {
        console.log(`[ok] ${source.label}.${table}: ${sqliteCount}`);
      }
    }
  } finally {
    sqlite.close();
  }
  return failures;
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.DATABASE_URL) throw new Error("DATABASE_URL is required.");
  const pool = await createPgPool(config.DATABASE_URL);
  const sources: SourceDb[] = [
    { label: "main", path: config.DATABASE_PATH, schema: config.POSTGRES_MAIN_SCHEMA },
    { label: "ticket", path: config.TICKET_DATABASE_PATH, schema: config.POSTGRES_TICKET_SCHEMA },
    { label: "message_log", path: config.MESSAGE_LOG_DB_PATH, schema: config.POSTGRES_MESSAGE_LOG_SCHEMA },
    {
      label: "message_attachment",
      path: config.MESSAGE_ATTACHMENT_STORE_DB_PATH,
      schema: config.POSTGRES_MESSAGE_ATTACHMENT_SCHEMA,
    },
    { label: "vc_time", path: config.VC_TIME_DATABASE_PATH, schema: config.POSTGRES_VC_TIME_SCHEMA },
    { label: "ai_history", path: config.AI_HISTORY_DATABASE_PATH, schema: config.POSTGRES_AI_HISTORY_SCHEMA },
    { label: "automod", path: config.AUTOMODERATION_DATABASE_PATH, schema: config.POSTGRES_AUTOMOD_SCHEMA },
    { label: "reminder", path: config.REMINDER_DATABASE_PATH, schema: config.POSTGRES_REMINDER_SCHEMA },
  ];

  try {
    const failures = (await Promise.all(sources.map((source) => verifySource(pool, source)))).flat();
    if (failures.length > 0) {
      console.error("PostgreSQL data verification failed:");
      for (const failure of failures) console.error(`- ${failure}`);
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

