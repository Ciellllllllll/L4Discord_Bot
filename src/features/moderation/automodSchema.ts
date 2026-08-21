import type { PgQueryable } from "../../core/db/postgres.js";

export async function ensurePostgresAutomoderationSchema(pool: PgQueryable): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS automod_guild_settings (
      guild_id text PRIMARY KEY,
      data jsonb NOT NULL DEFAULT '{}'::jsonb,
      updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}
