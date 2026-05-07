import type DatabaseLib from "better-sqlite3";
import type { Client, VoiceState } from "discord.js";
import { snowflakeToBigInt } from "../../core/snowflake.js";

function closeOpenSession(sqlite: DatabaseLib.Database, gid: bigint, uid: bigint): void {
  const rows = sqlite
    .prepare(
      `SELECT id, started_at FROM sessions WHERE guild_id = ? AND user_id = ? AND ended_at IS NULL ORDER BY id`,
    )
    .all(gid, uid) as { id: number; started_at: string }[];
  if (rows.length === 0) return;
  const now = new Date();
  const end = now.toISOString();
  const endMs = now.getTime();
  const update = sqlite.prepare(`UPDATE sessions SET ended_at = ?, duration_sec = ? WHERE id = ?`);
  for (const row of rows) {
    const startMs = Date.parse(row.started_at);
    const dur = Number.isFinite(startMs) ? Math.max(0, Math.floor((endMs - startMs) / 1000)) : 0;
    update.run(end, dur, row.id);
  }
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

export function endOpenVcSessionForMember(
  sqlite: DatabaseLib.Database,
  guildId: string,
  userId: string,
): void {
  const gid = snowflakeToBigInt(guildId);
  const uid = snowflakeToBigInt(userId);
  closeOpenSession(sqlite, gid, uid);
}

export function reconcileVcTimeSessionsAtReady(
  client: Client,
  sqlite: DatabaseLib.Database,
  targetGuildId: string,
): void {
  const guild = client.guilds.cache.get(targetGuildId);
  if (!guild) return;

  const live = new Map<string, string>();
  for (const member of guild.members.cache.values()) {
    const chId = member.voice?.channelId;
    if (chId) live.set(`${guild.id}:${member.id}`, chId);
  }

  const gid = snowflakeToBigInt(guild.id);

  for (const [key, channelId] of live.entries()) {
    const uidStr = key.split(":")[1];
    if (!uidStr) continue;
    const uid = snowflakeToBigInt(uidStr);
    const open = sqlite
      .prepare(
        `SELECT id FROM sessions WHERE guild_id = ? AND user_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1`,
      )
      .get(gid, uid) as { id: number } | undefined;
    if (!open) startSession(sqlite, gid, uid, channelId);
  }

  const openRows = sqlite
    .prepare(
      `SELECT id, guild_id, user_id FROM sessions WHERE guild_id = ? AND ended_at IS NULL`,
    )
    .all(gid) as { id: number; guild_id: bigint | number; user_id: bigint | number }[];

  for (const row of openRows) {
    const uid =
      typeof row.user_id === "bigint" ? row.user_id.toString() : String(Math.trunc(Number(row.user_id)));
    const k = `${guild.id}:${uid}`;
    if (!live.has(k)) closeOpenSession(sqlite, gid, snowflakeToBigInt(uid));
  }
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

  if (oldCh && newCh && oldCh === newCh) return;

  closeOpenSession(sqlite, gid, uid);
  if (newCh) startSession(sqlite, gid, uid, newCh);
}
