import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { ensureAiR18UserSettingsSchema } from "./aiR18UserSettingsSchema.js";

const db = new Database(":memory:");
try {
  ensureAiR18UserSettingsSchema(db);

  const columns = db.prepare("PRAGMA table_info(ai_r18_user_settings)").all() as Array<{
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
  }>;
  const byName = new Map(columns.map((column) => [column.name, column]));

  assert.deepEqual(
    columns.map((column) => column.name),
    ["guild_id", "user_id", "enabled", "updated_at"],
  );
  assert.equal(byName.get("guild_id")?.notnull, 1);
  assert.equal(byName.get("user_id")?.notnull, 1);
  assert.equal(byName.get("enabled")?.type, "SMALLINT");
  assert.equal(byName.get("enabled")?.notnull, 1);
  assert.equal(byName.get("enabled")?.dflt_value, "0");
  assert.equal(byName.get("updated_at")?.notnull, 1);
  assert.equal(byName.get("guild_id")?.pk, 1);
  assert.equal(byName.get("user_id")?.pk, 2);

  db.prepare("INSERT INTO ai_r18_user_settings (guild_id, user_id, enabled) VALUES (?, ?, ?)").run(
    "guild",
    "user",
    1,
  );
  const row = db.prepare("SELECT guild_id, user_id, enabled, updated_at FROM ai_r18_user_settings").get() as {
    guild_id: string;
    user_id: string;
    enabled: number;
    updated_at: string;
  };

  assert.equal(row.guild_id, "guild");
  assert.equal(row.user_id, "user");
  assert.equal(row.enabled, 1);
  assert.match(row.updated_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

  assert.throws(
    () => {
      db.prepare("INSERT INTO ai_r18_user_settings (guild_id, user_id, enabled) VALUES (?, ?, ?)").run(
        "guild",
        "invalid-user",
        2,
      );
    },
    /CHECK constraint failed/,
  );
} finally {
  db.close();
}

console.log("aiR18UserSettingsSchema.spec.ts: all assertions passed");
