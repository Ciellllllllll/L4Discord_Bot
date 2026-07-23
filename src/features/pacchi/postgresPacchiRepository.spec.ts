import assert from "node:assert/strict";
import { createPgPool, quotePgIdent } from "../../core/db/postgres.js";
import { PostgresPacchiRepository } from "./postgresPacchiRepository.js";
import { ensurePostgresPacchiSchema, migratePostgresPacchiBooleanColumns } from "./pacchi.schema.js";
import { getOptionalPostgresTestUrl } from "../../test/postgresTestEnv.js";

type CapturingPool = { queries: string[]; query: (sql: string) => Promise<{ rows: unknown[] }> };

async function assertDdl(): Promise<void> {
  const pool: CapturingPool = {
    queries: [],
    async query(sql: string): Promise<{ rows: unknown[] }> {
      this.queries.push(sql);
      return { rows: [] };
    },
  };
  await ensurePostgresPacchiSchema(pool as never);
  const sql = pool.queries.join("\n");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS pacchi_settings/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS pacchi_senryu_submissions/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_pacchi_sentence_patterns_guild_count/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS uq_pacchi_sleep_open/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS uq_pacchi_daily_report_open/);
}

async function assertIntegration(): Promise<void> {
  const connectionString = getOptionalPostgresTestUrl("TEST_DATABASE_URL", "postgresPacchiRepository.spec.ts");
  if (!connectionString) return;
  const schemaName = `pacchi_spec_${process.pid}_${Date.now()}`;
  const pool = await createPgPool(connectionString, schemaName);
  try {
    await ensurePostgresPacchiSchema(pool);
    const repo = new PostgresPacchiRepository(pool);
    const guildId = "guild-pg";
    assert.equal((await repo.getSettings(guildId)).enabled, true);
    await repo.learn(guildId, ["猫", "川柳"], "猫がいる");
    await repo.learnMorph(guildId, [{
      surface: "猫",
      base: "猫",
      reading: "ネコ",
      pos: ["名詞"],
      isProperNoun: false,
      isOov: false,
      source: "spec",
    }]);
    await repo.learnSentencePattern(guildId, {
      surfacePattern: "{NOUN}かも",
      slots: ["NOUN"],
      ending: "かも",
      sourceKind: "spec",
      safeLevel: 1,
    });
    assert.equal((await repo.topWords(guildId, 10))[0]?.word, "猫");
    assert.ok(["猫", "川柳"].includes((await repo.pickWord(guildId)) ?? ""));
    assert.equal((await repo.randomSentencePattern(guildId))?.surface_pattern, "{NOUN}かも");
    await repo.setChannelSettings(guildId, "channel-1", false, true);
    assert.equal((await repo.getChannelSettings(guildId, "channel-1")).talkEnabled, false);
    const settings = await Promise.all(Array.from({ length: 5 }, () => repo.getSettings("guild-race")));
    assert.equal(settings.every((row) => row.guildId === "guild-race"), true);
    assert.equal(
      Number((await pool.query("SELECT COUNT(*) AS count FROM pacchi_settings WHERE guild_id = $1", ["guild-race"])).rows[0]?.count ?? 0),
      1,
    );
    const exported = await repo.exportData(guildId);
    assert.equal(exported.words.length, 2);
    await repo.importData("guild-import", exported);
    assert.equal((await repo.topWords("guild-import", 10)).length, 2);
    await repo.startSleep(guildId, "user-1");
    assert.equal((await repo.startSleep(guildId, "user-1")) !== "", true);
    const sleepStarts = await Promise.all(Array.from({ length: 5 }, () => repo.startSleep(guildId, "user-race")));
    assert.equal(new Set(sleepStarts).size, 1);
    assert.equal(
      Number((await pool.query("SELECT COUNT(*) AS count FROM pacchi_sleep_logs WHERE guild_id = $1 AND user_id = $2 AND wake_at IS NULL", [guildId, "user-race"])).rows[0]?.count ?? 0),
      1,
    );
    const reportStarts = await Promise.all(Array.from({ length: 5 }, () => repo.startReport(guildId, "user-race", "channel-1", "goal")));
    assert.equal(reportStarts.filter(Boolean).length, 1);
    assert.equal(
      Number((await pool.query("SELECT COUNT(*) AS count FROM pacchi_daily_reports WHERE guild_id = $1 AND user_id = $2 AND end_at IS NULL", [guildId, "user-race"])).rows[0]?.count ?? 0),
      1,
    );
    assert.ok(await repo.endSleep(guildId, "user-1"));
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${quotePgIdent(schemaName)} CASCADE`);
    await pool.end();
  }
}

async function assertLegacyBooleanMigration(): Promise<void> {
  const connectionString = getOptionalPostgresTestUrl("TEST_DATABASE_URL", "postgresPacchiRepository.spec.ts");
  if (!connectionString) return;
  const schemaName = `pacchi_boolean_migration_${process.pid}_${Date.now()}`;
  const pool = await createPgPool(connectionString, schemaName);
  try {
    await pool.query(`
      CREATE TABLE pacchi_settings (
        guild_id text PRIMARY KEY,
        enabled bigint NOT NULL DEFAULT 1,
        default_talk_enabled bigint NOT NULL DEFAULT 1,
        default_learn_enabled bigint NOT NULL DEFAULT 1,
        speak_rate text NOT NULL DEFAULT 'normal',
        cooldown_seconds integer NOT NULL DEFAULT 60,
        last_spoke_at text,
        last_learned_at text,
        created_at text NOT NULL,
        updated_at text NOT NULL
      );
      CREATE TABLE pacchi_channel_settings (
        guild_id text NOT NULL,
        channel_id text NOT NULL,
        talk_enabled bigint NOT NULL DEFAULT 1,
        learn_enabled bigint NOT NULL DEFAULT 1,
        created_at text NOT NULL,
        updated_at text NOT NULL,
        PRIMARY KEY (guild_id, channel_id)
      );
      INSERT INTO pacchi_settings (guild_id, enabled, default_talk_enabled, default_learn_enabled, created_at, updated_at)
      VALUES ('guild-legacy', 0, 1, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO pacchi_channel_settings (guild_id, channel_id, talk_enabled, learn_enabled, created_at, updated_at)
      VALUES ('guild-legacy', 'channel-legacy', 0, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    `);

    await migratePostgresPacchiBooleanColumns(pool);
    await migratePostgresPacchiBooleanColumns(pool);

    const columns = await pool.query<{ table_name: string; column_name: string; data_type: string; column_default: string | null }>(
      `SELECT table_name, column_name, data_type, column_default
       FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND (table_name, column_name) IN (
           ('pacchi_settings', 'enabled'),
           ('pacchi_settings', 'default_talk_enabled'),
           ('pacchi_settings', 'default_learn_enabled'),
           ('pacchi_channel_settings', 'talk_enabled'),
           ('pacchi_channel_settings', 'learn_enabled')
         )
       ORDER BY table_name, column_name`,
    );
    assert.deepEqual(columns.rows.map((row) => row.data_type), ["boolean", "boolean", "boolean", "boolean", "boolean"]);
    assert.equal(columns.rows.every((row) => row.column_default === "true"), true);

    const settings = await pool.query<{ enabled: boolean; default_talk_enabled: boolean; default_learn_enabled: boolean }>(
      "SELECT enabled, default_talk_enabled, default_learn_enabled FROM pacchi_settings WHERE guild_id = 'guild-legacy'",
    );
    assert.deepEqual(settings.rows, [{ enabled: false, default_talk_enabled: true, default_learn_enabled: false }]);
    const channel = await pool.query<{ talk_enabled: boolean; learn_enabled: boolean }>(
      "SELECT talk_enabled, learn_enabled FROM pacchi_channel_settings WHERE guild_id = 'guild-legacy' AND channel_id = 'channel-legacy'",
    );
    assert.deepEqual(channel.rows, [{ talk_enabled: false, learn_enabled: true }]);
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${quotePgIdent(schemaName)} CASCADE`);
    await pool.end();
  }
}

async function run(): Promise<void> {
  await assertDdl();
  await assertIntegration();
  await assertLegacyBooleanMigration();
}

void run()
  .then(() => console.log("postgresPacchiRepository.spec.ts: all available assertions passed"))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
