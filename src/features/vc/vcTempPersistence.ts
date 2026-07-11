import type DatabaseLib from "better-sqlite3";
import type { Pool } from "pg";
import type { PgQueryable } from "../../core/db/postgres.js";

export type VcTempTrackedRow = {
  channelId: string;
  guildId: string;
  createdAtMs: number;
  userEverJoined: boolean;
};

export type VcTempPersistence = {
  listTracked(): Promise<VcTempTrackedRow[]>;
  insertTracked(row: VcTempTrackedRow): Promise<void>;
  setUserEverJoined(channelId: string): Promise<void>;
  deleteTracked(channelId: string): Promise<void>;
};

export function createSqliteVcTempPersistence(sqlite: DatabaseLib.Database): VcTempPersistence {
  return {
    async listTracked() {
      const rows = sqlite.prepare(`SELECT channel_id, guild_id, created_at_ms, user_ever_joined FROM vc_temp_tracked_channels`).all() as Array<{
        channel_id: string; guild_id: string; created_at_ms: number; user_ever_joined: number;
      }>;
      return rows.map((row) => ({ channelId: row.channel_id, guildId: row.guild_id, createdAtMs: row.created_at_ms, userEverJoined: row.user_ever_joined !== 0 }));
    },
    async insertTracked(row) {
      sqlite.prepare(`INSERT INTO vc_temp_tracked_channels (channel_id, guild_id, created_at_ms, user_ever_joined) VALUES (?, ?, ?, ?)`).run(row.channelId, row.guildId, row.createdAtMs, row.userEverJoined ? 1 : 0);
    },
    async setUserEverJoined(channelId) {
      sqlite.prepare(`UPDATE vc_temp_tracked_channels SET user_ever_joined = 1 WHERE channel_id = ?`).run(channelId);
    },
    async deleteTracked(channelId) {
      sqlite.prepare(`DELETE FROM vc_temp_tracked_channels WHERE channel_id = ?`).run(channelId);
    },
  };
}

export async function ensurePostgresVcTempSchema(pool: PgQueryable): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vc_temp_tracked_channels (
      channel_id text PRIMARY KEY,
      guild_id text NOT NULL,
      created_at_ms bigint NOT NULL,
      user_ever_joined boolean NOT NULL DEFAULT false
    );
    CREATE INDEX IF NOT EXISTS vc_temp_tracked_channels_guild_idx ON vc_temp_tracked_channels (guild_id);
  `);
}

export function createPostgresVcTempPersistence(pool: Pool): VcTempPersistence {
  return {
    async listTracked() {
      const result = await pool.query<{ channel_id: string; guild_id: string; created_at_ms: string | number; user_ever_joined: boolean }>(
        `SELECT channel_id, guild_id, created_at_ms, user_ever_joined FROM vc_temp_tracked_channels`,
      );
      return result.rows.map((row) => ({ channelId: row.channel_id, guildId: row.guild_id, createdAtMs: Number(row.created_at_ms), userEverJoined: row.user_ever_joined }));
    },
    async insertTracked(row) {
      await pool.query(`INSERT INTO vc_temp_tracked_channels (channel_id, guild_id, created_at_ms, user_ever_joined) VALUES ($1, $2, $3, $4)`, [row.channelId, row.guildId, row.createdAtMs, row.userEverJoined]);
    },
    async setUserEverJoined(channelId) {
      await pool.query(`UPDATE vc_temp_tracked_channels SET user_ever_joined = true WHERE channel_id = $1`, [channelId]);
    },
    async deleteTracked(channelId) {
      await pool.query(`DELETE FROM vc_temp_tracked_channels WHERE channel_id = $1`, [channelId]);
    },
  };
}
