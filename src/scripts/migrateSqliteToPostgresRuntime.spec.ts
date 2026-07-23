import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import { createPgPool, quotePgIdent } from "../core/db/postgres.js";
import {
  createPostgresAiHistoryKysely,
  createPostgresAutomoderationKysely,
  createPostgresMainKysely,
  createPostgresReminderKysely,
  createPostgresTicketKysely,
} from "../core/db/kysely.js";
import { PostgresVcRankingRepository } from "../adapters/legacyDb/postgresVcRankingRepository.js";
import { ensureLolWatcherSchema, PostgresLolWatcherRepository } from "../features/lolWatcher/lolWatcher.repository.js";
import { ensurePacchiSchema } from "../features/pacchi/pacchi.schema.js";
import { PostgresPacchiRepository } from "../features/pacchi/postgresPacchiRepository.js";
import { createPostgresSenryuRepository } from "../features/senryu/senryu.repository.js";
import { ensureMessageLogsSchema } from "../features/messageLog/messageLogsSchema.js";
import { prepareMessageAttachmentStore } from "../features/messageLog/messageAttachmentArchive.js";
import { searchMessageLogsPostgres } from "../features/messageLog/messageLogsView.js";
import { ensureVcTimeSchema } from "../features/vc/vcTimeSchema.js";
import { createPostgresVcTempPersistence } from "../features/vc/vcTempPersistence.js";
import { getOptionalPostgresTestUrl } from "../test/postgresTestEnv.js";

function createMainFixture(path: string): void {
  const db = new Database(path);
  try {
    ensurePacchiSchema(db);
    ensureLolWatcherSchema(db);
    db.exec(`
      CREATE TABLE IF NOT EXISTS senryu_records (
        id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        author_id TEXT NOT NULL,
        kamigo TEXT NOT NULL,
        nakashichi TEXT NOT NULL,
        shimogo TEXT NOT NULL,
        formatted TEXT NOT NULL,
        source_content TEXT NOT NULL,
        spoiler INTEGER NOT NULL,
        detected_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS snowflake_verify_fixture (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        executor_user_id INTEGER NOT NULL,
        emoji_id INTEGER NOT NULL
      );
    `);
    db.prepare(`
      INSERT INTO pacchi_settings (
        guild_id, enabled, default_talk_enabled, default_learn_enabled,
        speak_rate, cooldown_seconds, last_spoke_at, last_learned_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("987654321098765432", 0, 1, 0, "slow", 300, null, null, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    db.prepare("INSERT INTO pacchi_words (id, guild_id, word, count, last_seen_at, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("word-1", "987654321098765432", "移行語", 7, "2026-01-01T00:01:00.000Z", "2026-01-01T00:01:00.000Z");
    db.prepare("INSERT INTO pacchi_senryu_submissions (id, guild_id, channel_id, message_id, author_id, kamigo, nakashichi, shimogo, formatted, source_content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("p-senryu-1", "987654321098765432", "987654321098765433", "987654321098765434", "987654321098765435", "古池や", "蛙飛びこむ", "水の音", "古池や 蛙飛びこむ 水の音", "source", "2026-01-01T00:02:00.000Z");
    db.prepare("INSERT INTO pacchi_sleep_logs (id, guild_id, user_id, sleep_at, wake_at, duration_seconds, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)")
      .run("sleep-1", "987654321098765432", "987654321098765435", "2026-01-01T01:00:00.000Z", "2026-01-01T01:00:00.000Z", "2026-01-01T01:00:00.000Z");
    db.prepare("INSERT INTO lol_watcher_accounts (account_key, account_key_norm, user_id, channel_id, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("User#JP1", "user#jp1", "987654321098765435", "987654321098765433", 1, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    db.prepare("INSERT INTO lol_watcher_status (key, value, updated_at) VALUES (?, ?, ?)")
      .run("notification_channel_id", "987654321098765433", "2026-01-01T00:00:00.000Z");
    db.prepare("INSERT INTO senryu_records (id, guild_id, channel_id, message_id, author_id, kamigo, nakashichi, shimogo, formatted, source_content, spoiler, detected_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("senryu-1", "987654321098765432", "987654321098765433", "987654321098765436", "987654321098765435", "上五", "中七です", "下五", "上五 中七です 下五", "content", 1, "2026-01-01T00:03:00.000Z");
    const insertSnowflakeFixture = db.prepare("INSERT INTO snowflake_verify_fixture (guild_id, executor_user_id, emoji_id) VALUES (?, ?, ?)");
    db.transaction(() => {
      const first = 987654321000000000n;
      insertSnowflakeFixture.run(first.toString(), (first + 10_000n).toString(), (first + 20_000n).toString());
      insertSnowflakeFixture.run(first.toString(), (first + 10_000n).toString(), (first + 20_000n).toString());
      for (let i = 1n; i <= 5_000n; i += 1n) {
        insertSnowflakeFixture.run(
          (first + i).toString(),
          (first + 10_000n + i).toString(),
          (first + 20_000n + i).toString(),
        );
      }
    })();
  } finally {
    db.close();
  }
}

function createVcFixture(path: string): void {
  const db = new Database(path);
  try {
    ensureVcTimeSchema(db);
    db.exec(`
      CREATE TABLE IF NOT EXISTS vc_temp_tracked_channels (
        channel_id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        user_ever_joined INTEGER NOT NULL DEFAULT 0
      );
    `);
    db.prepare("INSERT INTO sessions (guild_id, user_id, channel_id, started_at, ended_at, duration_sec) VALUES (?, ?, ?, ?, ?, ?)")
      .run(987654321098765432n, 987654321098765435n, 987654321098765433n, "2026-01-01T00:00:00.000Z", "2026-01-01T00:10:00.000Z", 600);
    db.prepare("INSERT INTO sessions (guild_id, user_id, channel_id, started_at, ended_at, duration_sec) VALUES (?, ?, ?, ?, NULL, NULL)")
      .run(987654321098765432n, 987654321098765437n, 987654321098765433n, "2026-01-01T00:20:00.000Z");
    db.prepare("INSERT INTO vc_temp_tracked_channels (channel_id, guild_id, created_at_ms, user_ever_joined) VALUES (?, ?, ?, ?)")
      .run("987654321098765442", "987654321098765432", 1767226800000, 0);
  } finally {
    db.close();
  }
}

function createMessageFixtures(messagePath: string, attachmentPath: string): void {
  const messageDb = new Database(messagePath);
  const attachmentDb = new Database(attachmentPath);
  try {
    ensureMessageLogsSchema(messageDb);
    prepareMessageAttachmentStore(attachmentDb);
    messageDb.prepare(`
      INSERT INTO message_logs (
        log_type, guild_id, channel_id, user_id, user_name, content, time,
        message_id, author_id, author_tag, author_display_name, created_at,
        message_type, attachment_count, attachments_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "create",
      987654321098765432n,
      987654321098765433n,
      987654321098765435n,
      "user",
      "移行ログ本文",
      "2026-01-01T00:00:00.000Z",
      987654321098765438n,
      987654321098765435n,
      "user#0001",
      "User",
      "2026-01-01T00:00:00.000Z",
      "Default",
      1,
      JSON.stringify([{ id: "987654321098765439", name: "a.png" }]),
    );
    attachmentDb.prepare(`
      INSERT INTO message_log_attachment_files (
        guild_id, message_id, attachment_id, filename, content_type, size_bytes,
        kind, storage_relpath, sha256_hex, source_url, fetched_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "987654321098765432",
      "987654321098765438",
      "987654321098765439",
      "a.png",
      "image/png",
      12,
      "image",
      "data/test/a.png",
      "abc",
      "https://example.invalid/a.png",
      "2026-01-01T00:00:00.000Z",
    );
  } finally {
    messageDb.close();
    attachmentDb.close();
  }
}

async function assertMigrationHistory(adminPool: Awaited<ReturnType<typeof createPgPool>>, schemas: Record<string, string>): Promise<void> {
  for (const [label, schema] of Object.entries(schemas)) {
    const result = await adminPool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM ${quotePgIdent(schema)}.postgres_schema_migrations`,
    );
    assert.ok(Number(result.rows[0]?.count ?? 0) > 0, `${label} schema should record PostgreSQL migration history`);
  }
}

async function assertPollsStateRevisionSchema(adminPool: Awaited<ReturnType<typeof createPgPool>>, schema: string): Promise<void> {
  const result = await adminPool.query<{ data_type: string; is_nullable: string; column_default: string | null; version: number }>(
    `SELECT columns.data_type, columns.is_nullable, columns.column_default, migrations.version
     FROM information_schema.columns AS columns
     JOIN ${quotePgIdent(schema)}.postgres_schema_migrations AS migrations ON migrations.version = 7
     WHERE columns.table_schema = $1 AND columns.table_name = 'polls' AND columns.column_name = 'state_revision'`,
    [schema],
  );
  assert.deepEqual(result.rows, [{ data_type: "bigint", is_nullable: "NO", column_default: "0", version: 7 }]);
}

async function assertKyselySchema(label: string, db: Kysely<unknown>, expectedSchema: string): Promise<void> {
  try {
    const result = await sql<{ schema: string | null }>`SELECT current_schema() AS schema`.execute(db);
    assert.equal(result.rows[0]?.schema ?? null, expectedSchema, `${label} Kysely search_path should target ${expectedSchema}`);
  } finally {
    await db.destroy();
  }
}

function runPostgresDataVerification(childEnv: NodeJS.ProcessEnv): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ["--import", "tsx", "src/scripts/verifyPostgresData.ts"], {
    cwd: process.cwd(),
    encoding: "utf8",
    shell: false,
    env: childEnv,
  });
}

async function assertSnowflakeVerifierDetectsMultiplicityMismatch(
  mainPool: Awaited<ReturnType<typeof createPgPool>>,
  childEnv: NodeJS.ProcessEnv,
): Promise<void> {
  await mainPool.query("UPDATE snowflake_verify_fixture SET guild_id = $1 WHERE id = $2", [
    "987654321999999999",
    2,
  ]);
  const failed = runPostgresDataVerification(childEnv);
  assert.notEqual(failed.status, 0, `${failed.stdout}\n${failed.stderr}`);
  assert.match(
    `${failed.stdout}\n${failed.stderr}`,
    /snowflake_verify_fixture\.guild_id: Snowflake values differ/,
  );
  await mainPool.query("UPDATE snowflake_verify_fixture SET guild_id = $1 WHERE id = $2", [
    "987654321000000000",
    2,
  ]);
  const restoredAfterGuild = runPostgresDataVerification(childEnv);
  assert.equal(restoredAfterGuild.status, 0, `${restoredAfterGuild.stdout}\n${restoredAfterGuild.stderr}`);

  await mainPool.query("UPDATE snowflake_verify_fixture SET emoji_id = $1 WHERE id = $2", [
    "987654321999999999",
    2,
  ]);
  const emojiFailed = runPostgresDataVerification(childEnv);
  assert.notEqual(emojiFailed.status, 0, `${emojiFailed.stdout}\n${emojiFailed.stderr}`);
  assert.match(
    `${emojiFailed.stdout}\n${emojiFailed.stderr}`,
    /snowflake_verify_fixture\.emoji_id: Snowflake values differ/,
  );
  await mainPool.query("UPDATE snowflake_verify_fixture SET emoji_id = $1 WHERE id = $2", [
    "987654321000020000",
    2,
  ]);
  const restored = runPostgresDataVerification(childEnv);
  assert.equal(restored.status, 0, `${restored.stdout}\n${restored.stderr}`);
}

async function run(): Promise<void> {
  const connectionString = getOptionalPostgresTestUrl("TEST_DATABASE_URL", "migrateSqliteToPostgresRuntime.spec.ts");
  if (!connectionString) return;

  const tmp = mkdtempSync(join(tmpdir(), "l4-pg-migrate-"));
  const suffix = `${process.pid}_${Date.now()}`;
  const schemas = {
    main: `mig_main_${suffix}`,
    ticket: `mig_ticket_${suffix}`,
    messageLog: `mig_message_log_${suffix}`,
    messageAttachment: `mig_message_attachment_${suffix}`,
    vcTime: `mig_vc_time_${suffix}`,
    aiHistory: `mig_ai_history_${suffix}`,
    automod: `mig_automod_${suffix}`,
    reminder: `mig_reminder_${suffix}`,
  };
  const mainPath = join(tmp, "main.sqlite");
  const vcPath = join(tmp, "vc_time.sqlite");
  const messagePath = join(tmp, "message.sqlite");
  const attachmentPath = join(tmp, "attachment.sqlite");
  const missing = join(tmp, "missing.sqlite");

  createMainFixture(mainPath);
  createVcFixture(vcPath);
  createMessageFixtures(messagePath, attachmentPath);

  const childEnv = {
    ...process.env,
    DB_DRIVER: "postgres",
    DATABASE_URL: connectionString,
    DISCORD_TOKEN: "test-token",
    DISCORD_CLIENT_ID: "client",
    GUILD_ID: "987654321098765432",
    OWNER_ID: "987654321098765435",
    ADMIN_ROLE_ID: "987654321098765440",
    DATABASE_PATH: mainPath,
    VC_TIME_DATABASE_PATH: vcPath,
    MESSAGE_LOG_DB_PATH: messagePath,
    MESSAGE_ATTACHMENT_STORE_DB_PATH: attachmentPath,
    TICKET_DATABASE_PATH: missing,
    AI_HISTORY_DATABASE_PATH: missing,
    AUTOMODERATION_DATABASE_PATH: missing,
    REMINDER_DATABASE_PATH: missing,
    POSTGRES_MAIN_SCHEMA: schemas.main,
    POSTGRES_TICKET_SCHEMA: schemas.ticket,
    POSTGRES_MESSAGE_LOG_SCHEMA: schemas.messageLog,
    POSTGRES_MESSAGE_ATTACHMENT_SCHEMA: schemas.messageAttachment,
    POSTGRES_VC_TIME_SCHEMA: schemas.vcTime,
    POSTGRES_AI_HISTORY_SCHEMA: schemas.aiHistory,
    POSTGRES_AUTOMOD_SCHEMA: schemas.automod,
    POSTGRES_REMINDER_SCHEMA: schemas.reminder,
    PRODUCTION_DATABASE_PATH: mainPath,
    PRODUCTION_VC_TIME_DATABASE_PATH: vcPath,
    PRODUCTION_MESSAGE_LOG_DB_PATH: messagePath,
    PRODUCTION_MESSAGE_ATTACHMENT_STORE_DB_PATH: attachmentPath,
    PRODUCTION_TICKET_DATABASE_PATH: missing,
    PRODUCTION_AI_HISTORY_DATABASE_PATH: missing,
    PRODUCTION_AUTOMODERATION_DATABASE_PATH: missing,
    PRODUCTION_REMINDER_DATABASE_PATH: missing,
    PRODUCTION_POSTGRES_MAIN_SCHEMA: schemas.main,
    PRODUCTION_POSTGRES_TICKET_SCHEMA: schemas.ticket,
    PRODUCTION_POSTGRES_MESSAGE_LOG_SCHEMA: schemas.messageLog,
    PRODUCTION_POSTGRES_MESSAGE_ATTACHMENT_SCHEMA: schemas.messageAttachment,
    PRODUCTION_POSTGRES_VC_TIME_SCHEMA: schemas.vcTime,
    PRODUCTION_POSTGRES_AI_HISTORY_SCHEMA: schemas.aiHistory,
    PRODUCTION_POSTGRES_AUTOMOD_SCHEMA: schemas.automod,
    PRODUCTION_POSTGRES_REMINDER_SCHEMA: schemas.reminder,
    DEBUG_DATABASE_PATH: mainPath,
    DEBUG_VC_TIME_DATABASE_PATH: vcPath,
    DEBUG_MESSAGE_LOG_DB_PATH: messagePath,
    DEBUG_MESSAGE_ATTACHMENT_STORE_DB_PATH: attachmentPath,
    DEBUG_TICKET_DATABASE_PATH: missing,
    DEBUG_AI_HISTORY_DATABASE_PATH: missing,
    DEBUG_AUTOMODERATION_DATABASE_PATH: missing,
    DEBUG_REMINDER_DATABASE_PATH: missing,
    DEBUG_POSTGRES_MAIN_SCHEMA: schemas.main,
    DEBUG_POSTGRES_TICKET_SCHEMA: schemas.ticket,
    DEBUG_POSTGRES_MESSAGE_LOG_SCHEMA: schemas.messageLog,
    DEBUG_POSTGRES_MESSAGE_ATTACHMENT_SCHEMA: schemas.messageAttachment,
    DEBUG_POSTGRES_VC_TIME_SCHEMA: schemas.vcTime,
    DEBUG_POSTGRES_AI_HISTORY_SCHEMA: schemas.aiHistory,
    DEBUG_POSTGRES_AUTOMOD_SCHEMA: schemas.automod,
    DEBUG_POSTGRES_REMINDER_SCHEMA: schemas.reminder,
  };

  const child = spawnSync(process.execPath, ["--import", "tsx", "src/scripts/migrateSqliteToPostgres.ts"], {
    cwd: process.cwd(),
    encoding: "utf8",
    shell: false,
    env: childEnv,
  });

  const adminPool = await createPgPool(connectionString);
  try {
    assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
    const verifyChild = runPostgresDataVerification(childEnv);
    assert.equal(verifyChild.status, 0, `${verifyChild.stdout}\n${verifyChild.stderr}`);
    await assertMigrationHistory(adminPool, schemas);
    const mainMigrationVersions = await adminPool.query<{ version: number }>(
      `SELECT version FROM ${quotePgIdent(schemas.main)}.postgres_schema_migrations ORDER BY version`,
    );
    assert.deepEqual(mainMigrationVersions.rows.map((row) => row.version), Array.from({ length: 11 }, (_, index) => index + 1));
    await assertPollsStateRevisionSchema(adminPool, schemas.main);
    await assertKyselySchema(
      "main",
      createPostgresMainKysely({ connectionString, schema: schemas.main }) as Kysely<unknown>,
      schemas.main,
    );
    await assertKyselySchema(
      "ticket",
      createPostgresTicketKysely({ connectionString, schema: schemas.ticket }) as Kysely<unknown>,
      schemas.ticket,
    );
    await assertKyselySchema(
      "aiHistory",
      createPostgresAiHistoryKysely({ connectionString, schema: schemas.aiHistory }) as Kysely<unknown>,
      schemas.aiHistory,
    );
    await assertKyselySchema(
      "automod",
      createPostgresAutomoderationKysely({ connectionString, schema: schemas.automod }) as Kysely<unknown>,
      schemas.automod,
    );
    await assertKyselySchema(
      "reminder",
      createPostgresReminderKysely({ connectionString, schema: schemas.reminder }) as Kysely<unknown>,
      schemas.reminder,
    );

    const mainPool = await createPgPool(connectionString, schemas.main);
    const vcPool = await createPgPool(connectionString, schemas.vcTime);
    const messagePool = await createPgPool(connectionString, schemas.messageLog);
    const attachmentPool = await createPgPool(connectionString, schemas.messageAttachment);
    try {
      await assertSnowflakeVerifierDetectsMultiplicityMismatch(mainPool, childEnv);
      const pacchi = new PostgresPacchiRepository(mainPool);
      const settings = await pacchi.getSettings("987654321098765432");
      assert.equal(settings.enabled, false);
      assert.equal(settings.defaultTalkEnabled, true);
      assert.equal(settings.defaultLearnEnabled, false);
      const pacchiBooleanColumns = await mainPool.query<{ data_type: string }>(
        `SELECT data_type
         FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND (table_name, column_name) IN (
             ('pacchi_settings', 'enabled'),
             ('pacchi_settings', 'default_talk_enabled'),
             ('pacchi_settings', 'default_learn_enabled'),
             ('pacchi_channel_settings', 'talk_enabled'),
             ('pacchi_channel_settings', 'learn_enabled')
           )`,
      );
      assert.deepEqual(pacchiBooleanColumns.rows.map((row) => row.data_type).sort(), ["boolean", "boolean", "boolean", "boolean", "boolean"]);
      await pacchi.setRate("987654321098765432", "normal");
      await pacchi.setChannelSettings("987654321098765432", "987654321098765433", true, false);
      assert.deepEqual(await pacchi.getChannelSettings("987654321098765432", "987654321098765433"), {
        guildId: "987654321098765432",
        channelId: "987654321098765433",
        talkEnabled: true,
        learnEnabled: false,
      });
      assert.equal((await pacchi.topWords("987654321098765432", 1))[0]?.word, "移行語");
      assert.equal(await pacchi.startSleep("987654321098765432", "987654321098765435"), "2026-01-01T01:00:00.000Z");
      assert.ok(await pacchi.endSleep("987654321098765432", "987654321098765435"));

      const lol = new PostgresLolWatcherRepository(mainPool);
      assert.equal((await lol.getAccount("user#jp1"))?.enabled, true);
      assert.equal(await lol.getNotificationChannelId(), "987654321098765433");
      await lol.disableAccount("user#jp1");
      assert.equal((await lol.getAccount("user#jp1"))?.enabled, false);

      const senryu = await mainPool.query<{ spoiler: boolean }>("SELECT spoiler FROM senryu_records WHERE id = $1", ["senryu-1"]);
      assert.equal(senryu.rows[0]?.spoiler, true);
      const senryuRepository = createPostgresSenryuRepository(mainPool);
      const savedSenryu = await senryuRepository.saveSenryu({
        id: "senryu-pg-write",
        guildId: "987654321098765432",
        channelId: "987654321098765433",
        messageId: "987654321098765443",
        authorId: "987654321098765435",
        kamigo: "移行後も",
        nakashichi: "書けることまで",
        shimogo: "確かめる",
        formatted: "移行後も 書けることまで 確かめる",
        sourceContent: "runtime write",
        spoiler: false,
        detectedAt: "2026-01-01T00:04:00.000Z",
      });
      assert.equal(savedSenryu.id, "senryu-pg-write");
      assert.equal(
        (await mainPool.query<{ spoiler: boolean }>("SELECT spoiler FROM senryu_records WHERE id = $1", ["senryu-pg-write"])).rows[0]?.spoiler,
        false,
      );
      await senryuRepository.deleteSenryu("senryu-pg-write");
      assert.equal(
        Number((await mainPool.query("SELECT COUNT(*) AS count FROM senryu_records WHERE id = $1", ["senryu-pg-write"])).rows[0]?.count ?? 0),
        0,
      );

      const ranking = await new PostgresVcRankingRepository(vcPool, "UTC").getRanking("987654321098765432", "all");
      assert.deepEqual(ranking[0], { userId: "987654321098765435", seconds: 600 });
      assert.equal(
        Number((await vcPool.query("SELECT COUNT(*) AS count FROM sessions WHERE ended_at IS NULL")).rows[0]?.count ?? 0),
        1,
      );
      const vcTemp = createPostgresVcTempPersistence(vcPool);
      assert.deepEqual(await vcTemp.listTracked(), [
        {
          channelId: "987654321098765442",
          guildId: "987654321098765432",
          createdAtMs: 1767226800000,
          userEverJoined: false,
        },
      ]);
      await vcTemp.setUserEverJoined("987654321098765442");
      assert.equal((await vcTemp.listTracked())[0]?.userEverJoined, true);

      const search = await searchMessageLogsPostgres(
        messagePool,
        {
          id: "mig-msg",
          ownerId: "987654321098765441",
          guildId: "987654321098765432",
          keyword: "移行ログ",
          channelId: null,
          userId: null,
          fromIso: null,
          toIso: null,
          attachmentsOnly: false,
          page: 1,
          createdAt: Date.now(),
          lastTouchedAt: Date.now(),
        },
        "987654321098765441",
      );
      assert.equal(search.total, 1);
      assert.equal(search.rows[0]?.message_id?.toString(), "987654321098765438");
      assert.equal(
        Number((await attachmentPool.query("SELECT COUNT(*) AS count FROM message_log_attachment_files WHERE attachment_id = $1", ["987654321098765439"])).rows[0]?.count ?? 0),
        1,
      );
    } finally {
      await mainPool.end();
      await vcPool.end();
      await messagePool.end();
      await attachmentPool.end();
    }
  } finally {
    for (const schema of Object.values(schemas)) {
      await adminPool.query(`DROP SCHEMA IF EXISTS ${quotePgIdent(schema)} CASCADE`);
    }
    await adminPool.end();
    rmSync(tmp, { recursive: true, force: true });
  }
}

void run()
  .then(() => console.log("migrateSqliteToPostgresRuntime.spec.ts: all available assertions passed"))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
