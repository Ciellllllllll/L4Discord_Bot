import "dotenv/config";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import type { QueryResult } from "pg";
import { existsSync } from "node:fs";
import { loadConfig } from "../core/config.js";
import { createPgPool, quotePgIdent } from "../core/db/postgres.js";

type SourceDb = {
  label: string;
  path: string;
  schema: string;
};

type SqliteColumn = {
  name: string;
  type: string;
  pk: number | bigint;
};

const snowflakeColumns = new Set([
  "guild_id",
  "channel_id",
  "message_id",
  "user_id",
  "executor_user_id",
  "author_id",
  "audit_entry_id",
  "opener_id",
  "assignee_id",
  "host_id",
  "emoji_id",
  "role_id",
  "category_id",
  "parent_channel_id",
  "bot_user_id",
  "webhook_id",
  "application_id",
  "executor_id",
  "target_id",
  "thread_id",
  "source_message_id",
  "confirm_message_id",
  "author_staff_id",
  "approver_staff_id",
  "reviewer_id",
  "review_message_id",
  "hold_thread_id",
]);

const retiredMainTables = new Set(["steam_app_catalog", "steam_verify_queue"]);

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

async function pgTableExists(
  pool: Awaited<ReturnType<typeof createPgPool>>,
  schema: string,
  table: string,
): Promise<boolean> {
  const result = await pool.query(
    `
    SELECT 1 AS ok
    FROM information_schema.tables
    WHERE table_schema = $1 AND table_name = $2
    `,
    [schema, table],
  );
  return (result.rowCount ?? 0) > 0;
}

function sqlitePrimaryKeyColumns(sqlite: Database.Database, table: string): string[] {
  const columns = sqlite.prepare(`PRAGMA table_info(${quoteSqliteIdent(table)})`).all() as SqliteColumn[];
  return columns
    .filter((column) => Number(column.pk) > 0)
    .sort((a, b) => Number(a.pk) - Number(b.pk))
    .map((column) => column.name);
}

function sqliteColumns(sqlite: Database.Database, table: string): SqliteColumn[] {
  return sqlite.prepare(`PRAGMA table_info(${quoteSqliteIdent(table)})`).all() as SqliteColumn[];
}

function sqliteHasIntegerIdPrimaryKey(columns: SqliteColumn[]): boolean {
  return columns.length > 0
    && columns.filter((column) => Number(column.pk) > 0).length === 1
    && columns.some((column) => column.name === "id" && Number(column.pk) > 0 && column.type.toUpperCase().includes("INT"));
}

function updateHash(hash: ReturnType<typeof createHash>, value: string): void {
  hash.update(String(value.length));
  hash.update(":");
  hash.update(value);
  hash.update("\n");
}

function sqliteSnowflakeColumnDigest(sqlite: Database.Database, table: string, column: string): { groups: number; nullCount: number; digest: string } {
  const hash = createHash("sha256");
  let groups = 0;
  const rows = sqlite
    .prepare(`
      SELECT CAST(${quoteSqliteIdent(column)} AS TEXT) AS value, COUNT(*) AS row_count
      FROM ${quoteSqliteIdent(table)}
      WHERE ${quoteSqliteIdent(column)} IS NOT NULL
      GROUP BY value
      ORDER BY value
    `)
    .iterate() as Iterable<{ value: string; row_count: number | bigint }>;
  for (const row of rows) {
    groups += 1;
    updateHash(hash, row.value);
    updateHash(hash, String(row.row_count));
  }
  const nullCount = (sqlite.prepare(`SELECT COUNT(*) AS count FROM ${quoteSqliteIdent(table)} WHERE ${quoteSqliteIdent(column)} IS NULL`).get() as { count: number }).count;
  return { groups, nullCount, digest: hash.digest("hex") };
}

async function pgSnowflakeColumnDigest(
  pool: Awaited<ReturnType<typeof createPgPool>>,
  schema: string,
  table: string,
  column: string,
): Promise<{ groups: number; nullCount: number; digest: string }> {
  const hash = createHash("sha256");
  let groups = 0;
  const pageSize = 5_000;
  const cursorName = quotePgIdent("snowflake_verify_cursor");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      DECLARE ${cursorName} NO SCROLL CURSOR FOR
        SELECT ${quotePgIdent(column)}::text AS value, COUNT(*)::text AS row_count
        FROM ${quotePgIdent(schema)}.${quotePgIdent(table)}
        WHERE ${quotePgIdent(column)} IS NOT NULL
        GROUP BY ${quotePgIdent(column)}::text
        ORDER BY value
    `);
    for (;;) {
      const result: QueryResult<{ value: string; row_count: string }> = await client.query(
        `FETCH FORWARD ${pageSize} FROM ${cursorName}`,
      );
      if (result.rows.length === 0) break;
      for (const row of result.rows) {
        groups += 1;
        updateHash(hash, row.value);
        updateHash(hash, row.row_count);
      }
      if (result.rows.length < pageSize) break;
    }
    await client.query(`CLOSE ${cursorName}`).catch(() => undefined);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  const nullCount = Number(
    (
      await pool.query(
        `SELECT COUNT(*) AS count FROM ${quotePgIdent(schema)}.${quotePgIdent(table)} WHERE ${quotePgIdent(column)} IS NULL`,
      )
    ).rows[0]?.count ?? 0,
  );
  return { groups, nullCount, digest: hash.digest("hex") };
}

async function verifyPrimaryKeyShape(
  pool: Awaited<ReturnType<typeof createPgPool>>,
  sqlite: Database.Database,
  source: SourceDb,
  table: string,
  sqliteCount: number,
): Promise<string[]> {
  const failures: string[] = [];
  const pk = sqlitePrimaryKeyColumns(sqlite, table);
  if (pk.length === 0 || sqliteCount === 0) return failures;

  const nullWhere = pk.map((column) => `${quotePgIdent(column)} IS NULL`).join(" OR ");
  const nullCount = Number(
    (
      await pool.query(
        `SELECT COUNT(*) AS count FROM ${quotePgIdent(source.schema)}.${quotePgIdent(table)} WHERE ${nullWhere}`,
      )
    ).rows[0]?.count ?? 0,
  );
  if (nullCount > 0) failures.push(`${source.label}.${table}: primary key contains ${nullCount} NULL row(s)`);

  const distinctExpr = pk.map((column) => `coalesce(${quotePgIdent(column)}::text, '<NULL>')`).join(" || E'\\u001f' || ");
  const distinctCount = Number(
    (
      await pool.query(
        `SELECT COUNT(DISTINCT (${distinctExpr})) AS count FROM ${quotePgIdent(source.schema)}.${quotePgIdent(table)}`,
      )
    ).rows[0]?.count ?? 0,
  );
  if (distinctCount !== sqliteCount) {
    failures.push(`${source.label}.${table}: primary key distinct=${distinctCount}, rows=${sqliteCount}`);
  }
  return failures;
}

async function verifySnowflakeColumns(
  pool: Awaited<ReturnType<typeof createPgPool>>,
  sqlite: Database.Database,
  source: SourceDb,
  table: string,
  columns: SqliteColumn[],
): Promise<string[]> {
  const failures: string[] = [];
  for (const column of columns.filter((candidate) => snowflakeColumns.has(candidate.name))) {
    const sqliteDigest = sqliteSnowflakeColumnDigest(sqlite, table, column.name);
    const pgDigest = await pgSnowflakeColumnDigest(pool, source.schema, table, column.name);
    if (
      sqliteDigest.groups !== pgDigest.groups
      || sqliteDigest.nullCount !== pgDigest.nullCount
      || sqliteDigest.digest !== pgDigest.digest
    ) {
      failures.push(
        `${source.label}.${table}.${column.name}: Snowflake values differ `
        + `(sqlite groups=${sqliteDigest.groups}, null=${sqliteDigest.nullCount}; `
        + `postgres groups=${pgDigest.groups}, null=${pgDigest.nullCount})`,
      );
    } else if (sqliteDigest.groups > 0 || sqliteDigest.nullCount > 0) {
      console.log(`[ok] ${source.label}.${table}.${column.name}: Snowflake values and counts preserved`);
    }
  }
  return failures;
}

async function verifyIdentitySequence(
  pool: Awaited<ReturnType<typeof createPgPool>>,
  source: SourceDb,
  table: string,
  columns: SqliteColumn[],
): Promise<string[]> {
  if (!sqliteHasIntegerIdPrimaryKey(columns)) return [];

  const sequenceResult = await pool.query<{ sequence_name: string | null }>(
    "SELECT pg_get_serial_sequence($1, 'id') AS sequence_name",
    [`${source.schema}.${table}`],
  );
  const sequenceName = sequenceResult.rows[0]?.sequence_name ?? null;
  if (!sequenceName) return [];

  const maxId = BigInt(
    (
      await pool.query(`SELECT COALESCE(MAX(id), 0)::text AS max_id FROM ${quotePgIdent(source.schema)}.${quotePgIdent(table)}`)
    ).rows[0]?.max_id ?? 0,
  );
  const state = await pool.query<{ last_value: string; is_called: boolean }>(
    `SELECT last_value::text, is_called FROM ${sequenceName}`,
  );
  const lastValue = BigInt(state.rows[0]?.last_value ?? 0);
  const isCalled = state.rows[0]?.is_called ?? false;
  if (maxId > 0n && (!isCalled || lastValue < maxId)) {
    return [`${source.label}.${table}: identity sequence ${sequenceName} last_value=${lastValue}, is_called=${isCalled}, max(id)=${maxId}`];
  }
  console.log(`[ok] ${source.label}.${table}: identity sequence ${sequenceName} is at ${lastValue}`);
  return [];
}

async function verifySource(pool: Awaited<ReturnType<typeof createPgPool>>, source: SourceDb): Promise<string[]> {
  const failures: string[] = [];
  if (!existsSync(source.path)) return failures;
  const sqlite = new Database(source.path, { readonly: true, fileMustExist: true });
  try {
    for (const table of sqliteTables(sqlite)) {
      if (source.label === "main" && retiredMainTables.has(table)) {
        console.log(`[skip] ${source.label}.${table}: retired Steam AppList table`);
        continue;
      }

      const columns = sqliteColumns(sqlite, table);
      const sqliteCount = (sqlite.prepare(`SELECT COUNT(*) AS count FROM ${quoteSqliteIdent(table)}`).get() as { count: number }).count;
      if (!(await pgTableExists(pool, source.schema, table))) {
        failures.push(`${source.label}.${table}: missing PostgreSQL table`);
        continue;
      }
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
      failures.push(...await verifyPrimaryKeyShape(pool, sqlite, source, table, sqliteCount));
      failures.push(...await verifySnowflakeColumns(pool, sqlite, source, table, columns));
      failures.push(...await verifyIdentitySequence(pool, source, table, columns));
    }
  } finally {
    sqlite.close();
  }
  return failures;
}

async function countIfTableExists(
  pool: Awaited<ReturnType<typeof createPgPool>>,
  schema: string,
  table: string,
  where = "",
): Promise<number | null> {
  if (!(await pgTableExists(pool, schema, table))) return null;
  const result = await pool.query(
    `SELECT COUNT(*) AS count FROM ${quotePgIdent(schema)}.${quotePgIdent(table)}${where ? ` WHERE ${where}` : ""}`,
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function verifyKnownRuntimeState(
  pool: Awaited<ReturnType<typeof createPgPool>>,
  config: ReturnType<typeof loadConfig>,
): Promise<string[]> {
  const failures: string[] = [];
  const checks: Array<[string, Promise<number | null>]> = [
    ["vc_time.sessions(open)", countIfTableExists(pool, config.POSTGRES_VC_TIME_SCHEMA, "sessions", "ended_at IS NULL")],
    ["main.pacchi_senryu_submissions", countIfTableExists(pool, config.POSTGRES_MAIN_SCHEMA, "pacchi_senryu_submissions")],
    ["main.senryu_records", countIfTableExists(pool, config.POSTGRES_MAIN_SCHEMA, "senryu_records")],
  ];
  for (const [label, countPromise] of checks) {
    const count = await countPromise;
    if (count === null) failures.push(`${label}: missing PostgreSQL table`);
    else console.log(`[ok] ${label}: ${count}`);
  }

  if (
    await pgTableExists(pool, config.POSTGRES_TICKET_SCHEMA, "modmail_replies")
    && await pgTableExists(pool, config.POSTGRES_TICKET_SCHEMA, "tickets")
  ) {
    const missingTickets = Number(
      (
        await pool.query(`
          SELECT COUNT(*) AS count
          FROM ${quotePgIdent(config.POSTGRES_TICKET_SCHEMA)}.modmail_replies r
          LEFT JOIN ${quotePgIdent(config.POSTGRES_TICKET_SCHEMA)}.tickets t ON t.id = r.ticket_id
          WHERE t.id IS NULL
        `)
      ).rows[0]?.count ?? 0,
    );
    if (missingTickets > 0) failures.push(`ticket.modmail_replies: ${missingTickets} row(s) reference missing tickets`);
    else console.log("[ok] ticket.modmail_replies references tickets");
  }

  if (
    await pgTableExists(pool, config.POSTGRES_MESSAGE_ATTACHMENT_SCHEMA, "message_log_attachment_files")
    && await pgTableExists(pool, config.POSTGRES_MESSAGE_LOG_SCHEMA, "message_logs")
  ) {
    const missingMessages = Number(
      (
        await pool.query(`
          SELECT COUNT(*) AS count
          FROM ${quotePgIdent(config.POSTGRES_MESSAGE_ATTACHMENT_SCHEMA)}.message_log_attachment_files a
          LEFT JOIN ${quotePgIdent(config.POSTGRES_MESSAGE_LOG_SCHEMA)}.message_logs m
            ON m.guild_id::text = a.guild_id AND m.message_id::text = a.message_id
          WHERE m.id IS NULL
        `)
      ).rows[0]?.count ?? 0,
    );
    if (missingMessages > 0) failures.push(`message_attachment: ${missingMessages} row(s) reference missing message_logs`);
    else console.log("[ok] message attachments reference message logs");
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
    const failures = [
      ...(await Promise.all(sources.map((source) => verifySource(pool, source)))).flat(),
      ...await verifyKnownRuntimeState(pool, config),
    ];
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

