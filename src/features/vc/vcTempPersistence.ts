import type DatabaseLib from "better-sqlite3";

export type VcTempTrackedRow = {
  channelId: string;
  guildId: string;
  createdAtMs: number;
  userEverJoined: boolean;
};

export function vcTempListTracked(sqlite: DatabaseLib.Database): VcTempTrackedRow[] {
  const rows = sqlite
    .prepare(
      `SELECT channel_id, guild_id, created_at_ms, user_ever_joined FROM vc_temp_tracked_channels`,
    )
    .all() as {
      channel_id: string;
      guild_id: string;
      created_at_ms: number;
      user_ever_joined: number;
    }[];
  return rows.map((r) => ({
    channelId: r.channel_id,
    guildId: r.guild_id,
    createdAtMs: r.created_at_ms,
    userEverJoined: r.user_ever_joined !== 0,
  }));
}

export function vcTempInsertTracked(sqlite: DatabaseLib.Database, row: VcTempTrackedRow): void {
  sqlite
    .prepare(
      `INSERT INTO vc_temp_tracked_channels (channel_id, guild_id, created_at_ms, user_ever_joined)
       VALUES (?, ?, ?, ?)`,
    )
    .run(row.channelId, row.guildId, row.createdAtMs, row.userEverJoined ? 1 : 0);
}

export function vcTempSetUserEverJoined(sqlite: DatabaseLib.Database, channelId: string): void {
  sqlite
    .prepare(`UPDATE vc_temp_tracked_channels SET user_ever_joined = 1 WHERE channel_id = ?`)
    .run(channelId);
}

export function vcTempDeleteTracked(sqlite: DatabaseLib.Database, channelId: string): void {
  sqlite.prepare(`DELETE FROM vc_temp_tracked_channels WHERE channel_id = ?`).run(channelId);
}
