import assert from "node:assert/strict";
import { createPgPool, quotePgIdent } from "../../core/db/postgres.js";
import { PostgresPacchiRepository } from "./postgresPacchiRepository.js";
import { ensurePostgresPacchiSchema } from "./pacchi.schema.js";
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

async function run(): Promise<void> {
  await assertDdl();
  await assertIntegration();
}

void run()
  .then(() => console.log("postgresPacchiRepository.spec.ts: all available assertions passed"))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
