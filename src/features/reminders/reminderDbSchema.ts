import type DatabaseLib from "better-sqlite3";

/** リマインダーハブ専用 DB（既定: data/reminder.db）— メイン DB の reminders と同一スキーマ */
export function ensureReminderSchema(db: DatabaseLib.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reminders (
      id TEXT PRIMARY KEY NOT NULL,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      author_id TEXT NOT NULL,
      body TEXT NOT NULL,
      fire_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      data TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_reminders_guild_fire ON reminders(guild_id, fire_at, status);");
}
