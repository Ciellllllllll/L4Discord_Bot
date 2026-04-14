import type DatabaseLib from "better-sqlite3";

// 自動モデレーション専用 DB（既定: data/Automoderation.db）

export function ensureAutomoderationSchema(db: DatabaseLib.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS automod_guild_settings (
      guild_id TEXT PRIMARY KEY NOT NULL,
      data TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}
