import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { createKysely } from "./db/kysely.js";
import { getGuildSettingsData } from "./guildSettings.js";

test("getGuildSettingsData returns an empty object for malformed or non-object JSON", async () => {
  const sqlite = new Database(":memory:");
  sqlite.exec("CREATE TABLE guild_settings (guild_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL)");
  const db = createKysely(sqlite);
  try {
    for (const [guildId, data] of [["broken", "{"], ["array", "[]"], ["null", "null"]] as const) {
      sqlite.prepare("INSERT INTO guild_settings (guild_id, data, updated_at) VALUES (?, ?, ?)").run(guildId, data, "now");
      assert.deepEqual(await getGuildSettingsData(db, guildId), {});
    }
    sqlite.prepare("INSERT INTO guild_settings (guild_id, data, updated_at) VALUES (?, ?, ?)").run("valid", '{"ai_thinking_enabled":true}', "now");
    assert.deepEqual(await getGuildSettingsData(db, "valid"), { ai_thinking_enabled: true });
  } finally {
    await db.destroy();
  }
});
