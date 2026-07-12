import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sql } from "kysely";
import pino from "pino";
import { loadConfig } from "../core/config.js";
import { createPgPool, quotePgIdent } from "../core/db/postgres.js";
import { ensurePostgresMainSchema } from "../core/db/postgresMainSchema.js";
import { getGuildSettingsData, upsertGuildSettingsData } from "../core/guildSettings.js";
import { getOptionalPostgresTestUrl } from "../test/postgresTestEnv.js";
import { closeDatabaseRuntime, createDatabaseRuntime, createDatabaseRuntimeWithCleanup } from "./databaseRuntime.js";

const silentLogger = pino({ enabled: false });

function runtimeConfig(overrides: NodeJS.ProcessEnv) {
  return loadConfig({
    DISCORD_TOKEN: "test-token",
    DISCORD_CLIENT_ID: "test-client",
    GUILD_ID: "123456789012345678",
    OWNER_ID: "123456789012345679",
    ADMIN_ROLE_ID: "123456789012345680",
    ...overrides,
  });
}

function runtimePaths(root: string): NodeJS.ProcessEnv {
  return {
    DATABASE_PATH: join(root, "main.sqlite"),
    TICKET_DATABASE_PATH: join(root, "ticket.sqlite"),
    MESSAGE_LOG_DB_PATH: join(root, "message-log.sqlite"),
    MESSAGE_ATTACHMENT_STORE_DB_PATH: join(root, "attachment.sqlite"),
    VC_TIME_DATABASE_PATH: join(root, "vc-time.sqlite"),
    AI_HISTORY_DATABASE_PATH: join(root, "ai-history.sqlite"),
    AUTOMODERATION_DATABASE_PATH: join(root, "automod.sqlite"),
    REMINDER_DATABASE_PATH: join(root, "reminder.sqlite"),
  };
}

test("runtime configuration rejects SQLite", () => {
  assert.throws(
    () => runtimeConfig({ DB_DRIVER: "sqlite", DATABASE_URL: "postgres://user:pass@127.0.0.1:5432/l4discord_test" }),
    /DB_DRIVER=postgres is required/,
  );
});

test("ensurePostgresMainSchema creates polls with a bigint state revision", async () => {
  const connectionString = getOptionalPostgresTestUrl("TEST_DATABASE_URL", "databaseRuntime.spec.ts");
  if (!connectionString) return;

  const schema = `runtime_polls_initial_${process.pid}_${Date.now()}`;
  const adminPool = await createPgPool(connectionString);
  const pool = await createPgPool(connectionString, schema);
  try {
    await ensurePostgresMainSchema(pool);
    const result = await adminPool.query<{ data_type: string; is_nullable: string; column_default: string | null }>(
      `SELECT data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'polls' AND column_name = 'state_revision'`,
      [schema],
    );
    assert.deepEqual(result.rows, [{ data_type: "bigint", is_nullable: "NO", column_default: "0" }]);
    const misplaced = await adminPool.query(
      `SELECT 1
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'werewolf_games' AND column_name = 'state_revision'`,
      [schema],
    );
    assert.equal(misplaced.rowCount, 0);
  } finally {
    await pool.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${quotePgIdent(schema)} CASCADE`);
    await adminPool.end();
  }
});

test("createDatabaseRuntime initializes, pings, and closes all PostgreSQL schemas", async () => {
  const connectionString = getOptionalPostgresTestUrl("TEST_DATABASE_URL", "databaseRuntime.spec.ts");
  if (!connectionString) return;

  const root = mkdtempSync(join(tmpdir(), "l4-runtime-postgres-"));
  const suffix = `${process.pid}_${Date.now()}`;
  const schemas = {
    main: `runtime_main_${suffix}`,
    ticket: `runtime_ticket_${suffix}`,
    messageLog: `runtime_message_log_${suffix}`,
    messageAttachment: `runtime_message_attachment_${suffix}`,
    vcTime: `runtime_vc_time_${suffix}`,
    aiHistory: `runtime_ai_history_${suffix}`,
    automod: `runtime_automod_${suffix}`,
    reminder: `runtime_reminder_${suffix}`,
  };
  const adminPool = await createPgPool(connectionString);
  try {
    const runtime = await createDatabaseRuntime(runtimeConfig({
      DB_DRIVER: "postgres",
      DATABASE_URL: connectionString,
      ...runtimePaths(root),
      POSTGRES_MAIN_SCHEMA: schemas.main,
      POSTGRES_TICKET_SCHEMA: schemas.ticket,
      POSTGRES_MESSAGE_LOG_SCHEMA: schemas.messageLog,
      POSTGRES_MESSAGE_ATTACHMENT_SCHEMA: schemas.messageAttachment,
      POSTGRES_VC_TIME_SCHEMA: schemas.vcTime,
      POSTGRES_AI_HISTORY_SCHEMA: schemas.aiHistory,
      POSTGRES_AUTOMOD_SCHEMA: schemas.automod,
      POSTGRES_REMINDER_SCHEMA: schemas.reminder,
    }), silentLogger);
    assert.equal(runtime.usePostgres, true);
    assert.equal(runtime.sqlite, undefined);
    assert.ok(runtime.mainPgPool);
    assert.ok(runtime.messageLogPgPool);
    assert.ok(runtime.vcTimePgPool);
    assert.ok(runtime.messageAttachmentPgPool);
    for (const schema of Object.values(schemas)) {
      const history = await adminPool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM ${quotePgIdent(schema)}.postgres_schema_migrations`,
      );
      assert.ok(Number(history.rows[0]?.count ?? 0) > 0, `${schema} should have migration history`);
    }
    for (const pool of [runtime.mainPgPool, runtime.messageLogPgPool, runtime.vcTimePgPool, runtime.messageAttachmentPgPool]) {
      assert.equal((await pool!.query<{ ok: number }>("SELECT 1 AS ok")).rows[0]?.ok, 1);
    }
    for (const [database, schema] of [
      [runtime.db, schemas.main],
      [runtime.ticketDb, schemas.ticket],
      [runtime.aiHistoryDb, schemas.aiHistory],
      [runtime.automodDb, schemas.automod],
    ] as const) {
      const result = await sql<{ schema: string | null }>`SELECT current_schema() AS schema`.execute(database);
      assert.equal(result.rows[0]?.schema, schema);
    }
    await Promise.all([
      upsertGuildSettingsData(runtime.db, "guild", { ai_thinking_enabled: true }),
      upsertGuildSettingsData(runtime.db, "guild", { member_leave_channel_id: "channel" }),
    ]);
    assert.deepEqual(await getGuildSettingsData(runtime.db, "guild"), {
      ai_thinking_enabled: true,
      member_leave_channel_id: "channel",
    });
    const settingsRevision = await runtime.mainPgPool.query<{ revision: number }>("SELECT revision FROM guild_settings WHERE guild_id = $1", ["guild"]);
    assert.equal(settingsRevision.rows[0]?.revision, 2);
    await closeDatabaseRuntime(runtime);
    await assert.rejects(runtime.mainPgPool!.query("SELECT 1"));
    await assert.rejects(sql`SELECT 1`.execute(runtime.db));
  } finally {
    for (const schema of Object.values(schemas)) {
      await adminPool.query(`DROP SCHEMA IF EXISTS ${quotePgIdent(schema)} CASCADE`);
    }
    await adminPool.end();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("createDatabaseRuntime applies pending polls and guild settings revision migrations", async () => {
  const connectionString = getOptionalPostgresTestUrl("TEST_DATABASE_URL", "databaseRuntime.spec.ts");
  if (!connectionString) return;

  const root = mkdtempSync(join(tmpdir(), "l4-runtime-postgres-v7-"));
  const suffix = `${process.pid}_${Date.now()}`;
  const schemas = {
    main: `runtime_main_v7_${suffix}`,
    ticket: `runtime_ticket_v7_${suffix}`,
    messageLog: `runtime_message_log_v7_${suffix}`,
    messageAttachment: `runtime_message_attachment_v7_${suffix}`,
    vcTime: `runtime_vc_time_v7_${suffix}`,
    aiHistory: `runtime_ai_history_v7_${suffix}`,
    automod: `runtime_automod_v7_${suffix}`,
    reminder: `runtime_reminder_v7_${suffix}`,
  };
  const adminPool = await createPgPool(connectionString);
  let runtime: Awaited<ReturnType<typeof createDatabaseRuntime>> | undefined;
  try {
    await adminPool.query(`CREATE SCHEMA ${quotePgIdent(schemas.main)}`);
    await adminPool.query(`CREATE TABLE ${quotePgIdent(schemas.main)}.polls (id text PRIMARY KEY)`);
    await adminPool.query(`CREATE TABLE ${quotePgIdent(schemas.main)}.guild_settings (guild_id text PRIMARY KEY, data jsonb NOT NULL DEFAULT '{}'::jsonb, updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
    await adminPool.query(`
      CREATE TABLE ${quotePgIdent(schemas.main)}.postgres_schema_migrations (
        version integer PRIMARY KEY,
        name text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await adminPool.query(
      `INSERT INTO ${quotePgIdent(schemas.main)}.postgres_schema_migrations (version, name)
       SELECT version, 'pre-v7' FROM generate_series(1, 6) AS version`,
    );

    runtime = await createDatabaseRuntime(runtimeConfig({
      DB_DRIVER: "postgres",
      DATABASE_URL: connectionString,
      ...runtimePaths(root),
      POSTGRES_MAIN_SCHEMA: schemas.main,
      POSTGRES_TICKET_SCHEMA: schemas.ticket,
      POSTGRES_MESSAGE_LOG_SCHEMA: schemas.messageLog,
      POSTGRES_MESSAGE_ATTACHMENT_SCHEMA: schemas.messageAttachment,
      POSTGRES_VC_TIME_SCHEMA: schemas.vcTime,
      POSTGRES_AI_HISTORY_SCHEMA: schemas.aiHistory,
      POSTGRES_AUTOMOD_SCHEMA: schemas.automod,
      POSTGRES_REMINDER_SCHEMA: schemas.reminder,
    }), silentLogger);

    const result = await adminPool.query<{ data_type: string; version: number }>(
      `SELECT columns.data_type, migrations.version
       FROM information_schema.columns AS columns
       JOIN ${quotePgIdent(schemas.main)}.postgres_schema_migrations AS migrations ON migrations.version = 7
       WHERE columns.table_schema = $1 AND columns.table_name = 'polls' AND columns.column_name = 'state_revision'`,
      [schemas.main],
    );
    assert.deepEqual(result.rows, [{ data_type: "bigint", version: 7 }]);
    const guildSettingsRevision = await adminPool.query<{ data_type: string; version: number }>(
      `SELECT columns.data_type, migrations.version
       FROM information_schema.columns AS columns
       JOIN ${quotePgIdent(schemas.main)}.postgres_schema_migrations AS migrations ON migrations.version = 8
       WHERE columns.table_schema = $1 AND columns.table_name = 'guild_settings' AND columns.column_name = 'revision'`,
      [schemas.main],
    );
    assert.deepEqual(guildSettingsRevision.rows, [{ data_type: "integer", version: 8 }]);
  } finally {
    if (runtime) await closeDatabaseRuntime(runtime);
    for (const schema of Object.values(schemas)) {
      await adminPool.query(`DROP SCHEMA IF EXISTS ${quotePgIdent(schema)} CASCADE`);
    }
    await adminPool.end();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("closeDatabaseRuntime closes Kysely, PostgreSQL pools, and SQLite handles", async () => {
  const calls: string[] = [];
  const runtime = {
    db: { destroy: async () => { calls.push("main"); } },
    ticketDb: { destroy: async () => { calls.push("ticket"); } },
    aiHistoryDb: { destroy: async () => { calls.push("aiHistory"); } },
    automodDb: { destroy: async () => { calls.push("automod"); } },
    messageLogPgPool: { end: async () => { calls.push("messageLogPool"); } },
    mainPgPool: { end: async () => { calls.push("mainPool"); } },
    vcTimePgPool: { end: async () => { calls.push("vcPool"); } },
    messageAttachmentPgPool: { end: async () => { calls.push("attachmentPool"); } },
    messageLogSqlite: { close: () => { calls.push("messageLogSqlite"); } },
    messageAttachmentStoreSqlite: { close: () => { calls.push("attachmentSqlite"); } },
    vcTimeSqlite: { close: () => { calls.push("vcSqlite"); } },
    ticketSqlite: { close: () => { calls.push("ticketSqlite"); } },
    aiHistorySqlite: { close: () => { calls.push("aiHistorySqlite"); } },
    automodSqlite: { close: () => { calls.push("automodSqlite"); } },
    sqlite: { close: () => { calls.push("mainSqlite"); } },
  };

  await closeDatabaseRuntime(runtime as never);

  assert.deepEqual(calls, [
    "main", "ticket", "aiHistory", "automod", "messageLogPool", "mainPool", "vcPool", "attachmentPool",
    "messageLogSqlite", "attachmentSqlite", "vcSqlite", "ticketSqlite", "aiHistorySqlite", "automodSqlite", "mainSqlite",
  ]);
});

test("closeDatabaseRuntime tries every resource when one close operation fails", async () => {
  const calls: string[] = [];
  const runtime = {
    db: { destroy: async () => { calls.push("main"); throw new Error("main close failed"); } },
    ticketDb: { destroy: async () => { calls.push("ticket"); } },
    aiHistoryDb: { destroy: async () => { calls.push("aiHistory"); } },
    automodDb: { destroy: async () => { calls.push("automod"); } },
    sqlite: { close: () => { calls.push("sqlite"); } },
  };

  await assert.rejects(closeDatabaseRuntime(runtime as never), /main close failed/);
  assert.deepEqual(calls, ["main", "ticket", "aiHistory", "automod", "sqlite"]);
});

test("createDatabaseRuntimeWithCleanup closes resources created before initialization fails", async () => {
  const calls: string[] = [];

  await assert.rejects(
    createDatabaseRuntimeWithCleanup(async (register) => {
      register(async () => { calls.push("first"); });
      register(async () => { calls.push("second"); });
      throw new Error("initialization failed");
    }),
    /initialization failed/,
  );

  assert.deepEqual(calls, ["second", "first"]);
});
