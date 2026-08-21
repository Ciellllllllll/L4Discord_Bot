import type { PgQueryable } from "../../core/db/postgres.js";

export async function ensurePostgresReminderSchema(pool: PgQueryable): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reminders (
      id text PRIMARY KEY,
      guild_id text NOT NULL,
      channel_id text NOT NULL,
      author_id text NOT NULL,
      body text NOT NULL,
      fire_at text NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      data jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_reminders_guild_fire ON reminders(guild_id, fire_at, status);
  `);
}
