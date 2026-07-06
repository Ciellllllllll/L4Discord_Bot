import type DatabaseLib from "better-sqlite3";

export function ensureAiR18UserSettingsSchema(db: DatabaseLib.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_r18_user_settings (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      enabled SMALLINT NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (guild_id, user_id)
    );
  `);
}
