import type DatabaseLib from "better-sqlite3";
import type { PgQueryable } from "../../core/db/postgres.js";

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

export async function ensurePostgresAutomoderationSchema(pool: PgQueryable): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS automod_guild_settings (
      guild_id text PRIMARY KEY,
      data jsonb NOT NULL DEFAULT '{}'::jsonb,
      updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}
