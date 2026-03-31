import type DatabaseLib from "better-sqlite3";
import type { VoiceState } from "discord.js";
import { snowflakeToBigInt } from "../../core/snowflake.js";

function closeOpenSession(sqlite: DatabaseLib.Database, gid: bigint, uid: bigint): void {
  const row = sqlite
    .prepare(
      `SELECT id, started_at FROM sessions WHERE guild_id = ? AND user_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1`,
    )
    .get(gid, uid) as { id: number; started_at: string } | undefined;
  if (!row) return;
  const end = new Date().toISOString();
  const startMs = Date.parse(row.started_at);
  const dur = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
  sqlite.prepare(`UPDATE sessions SET ended_at = ?, duration_sec = ? WHERE id = ?`).run(end, dur, row.id);
}

function startSession(sqlite: DatabaseLib.Database, gid: bigint, uid: bigint, channelId: string): void {
  const cid = snowflakeToBigInt(channelId);
  const now = new Date().toISOString();
  sqlite
    .prepare(
      `INSERT INTO sessions (guild_id, user_id, channel_id, started_at, ended_at, duration_sec) VALUES (?, ?, ?, ?, NULL, NULL)`,
    )
    .run(gid, uid, cid, now);
}

export function trackVoiceStateUpdate(
  sqlite: DatabaseLib.Database,
  oldS: VoiceState,
  newS: VoiceState,
  targetGuildId: string,
): void {
  if (newS.guild.id !== targetGuildId) return;
  if (newS.member?.user.bot) return;
  const gid = snowflakeToBigInt(newS.guild.id);
  const uid = snowflakeToBigInt(newS.id);
  const oldCh = oldS.channelId;
  const newCh = newS.channelId;

  if (oldCh && !newCh) {
    closeOpenSession(sqlite, gid, uid);
    return;
  }
  if (oldCh && newCh && oldCh !== newCh) {
    closeOpenSession(sqlite, gid, uid);
    startSession(sqlite, gid, uid, newCh);
    return;
  }
  if (!oldCh && newCh) {
    startSession(sqlite, gid, uid, newCh);
  }
}
