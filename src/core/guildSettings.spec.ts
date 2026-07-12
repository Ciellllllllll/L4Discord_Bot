import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { createKysely } from "./db/kysely.js";
import { getGuildSettingsData, upsertGuildSettingsData } from "./guildSettings.js";

test("getGuildSettingsData returns an empty object for malformed or non-object JSON", async () => {
  const sqlite = new Database(":memory:");
  sqlite.exec("CREATE TABLE guild_settings (guild_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0)");
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

test("upsertGuildSettingsData preserves concurrent patches with revision CAS", async () => {
  const sqlite = new Database(":memory:");
  sqlite.exec("CREATE TABLE guild_settings (guild_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0)");
  const db = createKysely(sqlite);
  try {
    await Promise.all([
      upsertGuildSettingsData(db, "guild", { ai_thinking_enabled: true }),
      upsertGuildSettingsData(db, "guild", { member_leave_channel_id: "channel" }),
    ]);
    assert.deepEqual(await getGuildSettingsData(db, "guild"), {
      ai_thinking_enabled: true,
      member_leave_channel_id: "channel",
    });
    const row = sqlite.prepare("SELECT revision FROM guild_settings WHERE guild_id = ?").get("guild") as { revision: number };
    assert.equal(row.revision, 2);
  } finally {
    await db.destroy();
  }
});
