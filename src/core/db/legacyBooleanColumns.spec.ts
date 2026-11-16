import assert from "node:assert/strict";
import { LEGACY_FLAG_COLUMNS } from "../../bot/databaseRuntime.js";
import { getOptionalPostgresTestUrl } from "../../test/postgresTestEnv.js";
import { migrateLegacyBooleanColumns } from "./legacyBooleanColumns.js";
import { createPgPool, quotePgIdent } from "./postgres.js";

// 本番で見つかった SQLite 由来の bigint 列を再現し、boolean への変換と既存値の保持を確かめる。
async function assertLegacyFlagColumnsMigration(): Promise<void> {
  const connectionString = getOptionalPostgresTestUrl("TEST_DATABASE_URL", "legacyBooleanColumns.spec.ts");
  if (!connectionString) return;
  const schemaName = `legacy_flags_${process.pid}_${Date.now()}`;
  const pool = await createPgPool(connectionString, schemaName);
  try {
    await pool.query(`
      CREATE TABLE pacchi_lexicon (
        id text PRIMARY KEY, guild_id text NOT NULL, surface text NOT NULL, base text NOT NULL,
        reading text NOT NULL, pos_json text NOT NULL,
        is_proper_noun bigint NOT NULL DEFAULT 0, is_oov bigint NOT NULL DEFAULT 0,
        source text NOT NULL, count bigint NOT NULL DEFAULT 1, last_seen_at text NOT NULL, created_at text NOT NULL,
        UNIQUE (guild_id, base, pos_json)
      );
      CREATE TABLE senryu_records (id text PRIMARY KEY, spoiler bigint NOT NULL);
      CREATE TABLE lol_watcher_accounts (account_key_norm text PRIMARY KEY, enabled bigint NOT NULL DEFAULT 1);
      CREATE INDEX lol_watcher_accounts_enabled_idx ON lol_watcher_accounts (enabled, account_key_norm);
      INSERT INTO pacchi_lexicon (id, guild_id, surface, base, reading, pos_json, is_proper_noun, is_oov, source, last_seen_at, created_at)
      VALUES ('a', 'g', '猫', '猫', 'ネコ', '[]', 1, 0, 'spec', 'now', 'now');
      INSERT INTO senryu_records (id, spoiler) VALUES ('s0', 0), ('s1', 1);
      INSERT INTO lol_watcher_accounts (account_key_norm, enabled) VALUES ('on', 1), ('off', 0);
    `);

    await migrateLegacyBooleanColumns(pool, LEGACY_FLAG_COLUMNS);
    await migrateLegacyBooleanColumns(pool, LEGACY_FLAG_COLUMNS);

    const columns = await pool.query<{ table_name: string; column_name: string; data_type: string; column_default: string | null; is_nullable: string }>(
      `SELECT table_name, column_name, data_type, column_default, is_nullable
       FROM information_schema.columns
       WHERE table_schema = current_schema() AND column_name IN ('is_proper_noun', 'is_oov', 'spoiler', 'enabled')
       ORDER BY table_name, column_name`,
    );
    assert.deepEqual(columns.rows, [
      { table_name: "lol_watcher_accounts", column_name: "enabled", data_type: "boolean", column_default: "true", is_nullable: "NO" },
      { table_name: "pacchi_lexicon", column_name: "is_oov", data_type: "boolean", column_default: "false", is_nullable: "NO" },
      { table_name: "pacchi_lexicon", column_name: "is_proper_noun", data_type: "boolean", column_default: "false", is_nullable: "NO" },
      { table_name: "senryu_records", column_name: "spoiler", data_type: "boolean", column_default: null, is_nullable: "NO" },
    ]);

    assert.deepEqual(
      (await pool.query("SELECT is_proper_noun, is_oov FROM pacchi_lexicon")).rows,
      [{ is_proper_noun: true, is_oov: false }],
    );
    assert.deepEqual(
      (await pool.query("SELECT id, spoiler FROM senryu_records ORDER BY id")).rows,
      [{ id: "s0", spoiler: false }, { id: "s1", spoiler: true }],
    );
    // 本番で失敗していた書き込みと検索が通ること。
    await pool.query("INSERT INTO senryu_records (id, spoiler) VALUES ($1, $2)", ["s2", false]);
    await pool.query(
      `INSERT INTO pacchi_lexicon (id, guild_id, surface, base, reading, pos_json, is_proper_noun, is_oov, source, last_seen_at, created_at)
       VALUES ('b', 'g', '犬', '犬', 'イヌ', '[]', $1, $2, 'spec', 'now', 'now')`,
      [false, true],
    );
    assert.deepEqual(
      (await pool.query("SELECT account_key_norm FROM lol_watcher_accounts WHERE enabled = true")).rows,
      [{ account_key_norm: "on" }],
    );
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${quotePgIdent(schemaName)} CASCADE`);
    await pool.end();
  }
}

void assertLegacyFlagColumnsMigration()
  .then(() => console.log("legacyBooleanColumns.spec.ts: all available assertions passed"))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
