import type { PgQueryable } from "../../core/db/postgres.js";

export async function ensurePostgresAiHistorySchema(pool: PgQueryable): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_history (
      id text PRIMARY KEY,
      guild_id text NOT NULL,
      user_id text NOT NULL,
      role text NOT NULL,
      content text NOT NULL,
      meta jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_ai_history_guild_user ON ai_history(guild_id, user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_ai_history_guild_created ON ai_history(guild_id, created_at);
  `);
}
