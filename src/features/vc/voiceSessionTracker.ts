import type DatabaseLib from "better-sqlite3";
import type { Client, VoiceState } from "discord.js";
import { snowflakeToBigInt } from "../../core/snowflake.js";

const MAX_OPEN_SESSION_SEC = 24 * 60 * 60;
const MAX_OPEN_SESSION_MS = MAX_OPEN_SESSION_SEC * 1000;

function closeTimeForStartedAt(startedAt: string, now: Date): { endedAt: string; durationSec: number } {
  const startMs = Date.parse(startedAt);
  if (!Number.isFinite(startMs)) {
    return { endedAt: now.toISOString(), durationSec: 0 };
  }
  const rawDurationMs = Math.max(0, now.getTime() - startMs);
  const cappedDurationMs = Math.min(rawDurationMs, MAX_OPEN_SESSION_MS);
  const endedMs = startMs + cappedDurationMs;
  return {
    endedAt: new Date(endedMs).toISOString(),
    durationSec: Math.floor(cappedDurationMs / 1000),
  };
}

function closeOpenSession(sqlite: DatabaseLib.Database, gid: bigint, uid: bigint): void {
  const rows = sqlite
    .prepare(
      `SELECT id, started_at FROM sessions WHERE guild_id = ? AND user_id = ? AND ended_at IS NULL ORDER BY id`,
    )
    .all(gid, uid) as { id: number; started_at: string }[];
  if (rows.length === 0) return;
  const now = new Date();
  const update = sqlite.prepare(`UPDATE sessions SET ended_at = ?, duration_sec = ? WHERE id = ?`);
  for (const row of rows) {
    const closed = closeTimeForStartedAt(row.started_at, now);
    update.run(closed.endedAt, closed.durationSec, row.id);
  }
}

function isOpenSessionStale(startedAt: string, now: Date): boolean {
  const startMs = Date.parse(startedAt);
  return Number.isFinite(startMs) && now.getTime() - startMs > MAX_OPEN_SESSION_MS;
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
    const openRows = sqlite
      .prepare(
        `SELECT id, started_at AS startedAt FROM sessions WHERE guild_id = ? AND user_id = ? AND ended_at IS NULL ORDER BY id`,
      )
      .all(gid, uid) as { id: number; startedAt: string }[];
    if (openRows.length === 0) {
      startSession(sqlite, gid, uid, channelId);
      continue;
    }
    const now = new Date();
    if (openRows.length > 1 || openRows.some((row) => isOpenSessionStale(row.startedAt, now))) {
      closeOpenSession(sqlite, gid, uid);
      startSession(sqlite, gid, uid, channelId);
    }
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
