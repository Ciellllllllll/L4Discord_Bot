import type { Client, VoiceState } from "discord.js";
import type { Pool } from "pg";

const MAX_OPEN_SESSION_SEC = 24 * 60 * 60;
const MAX_OPEN_SESSION_MS = MAX_OPEN_SESSION_SEC * 1000;
const postgresVcUpdateQueues = new WeakMap<Pool, Map<string, Promise<void>>>();

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
function isOpenSessionStale(startedAt: string, now: Date): boolean {
  const startMs = Date.parse(startedAt);
  return Number.isFinite(startMs) && now.getTime() - startMs > MAX_OPEN_SESSION_MS;
}

async function closeOpenSessionPostgres(pool: Pool, guildId: string, userId: string): Promise<void> {
  const rows = await pool.query<{ id: number; started_at: string }>(
    `SELECT id, started_at FROM sessions WHERE guild_id = $1 AND user_id = $2 AND ended_at IS NULL ORDER BY id`,
    [guildId, userId],
  );
  if (rows.rowCount === 0) return;
  const now = new Date();
  for (const row of rows.rows) {
    const closed = closeTimeForStartedAt(row.started_at, now);
    await pool.query(
      `UPDATE sessions SET ended_at = $1, duration_sec = $2 WHERE id = $3`,
      [closed.endedAt, closed.durationSec, row.id],
    );
  }
}

async function startSessionPostgres(pool: Pool, guildId: string, userId: string, channelId: string): Promise<void> {
  const now = new Date().toISOString();
  await pool.query(
    `INSERT INTO sessions (guild_id, user_id, channel_id, started_at, ended_at, duration_sec)
     VALUES ($1, $2, $3, $4, NULL, NULL)`,
    [guildId, userId, channelId, now],
  );
}

function runPostgresVcUserUpdate(pool: Pool, userId: string, task: () => Promise<void>): Promise<void> {
  let byUser = postgresVcUpdateQueues.get(pool);
  if (!byUser) {
    byUser = new Map();
    postgresVcUpdateQueues.set(pool, byUser);
  }
  const previous = byUser.get(userId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  const cleanup = next.finally(() => {
    if (byUser?.get(userId) === cleanup) byUser.delete(userId);
  });
  byUser.set(userId, cleanup);
  return next;
}

function dbSnowflakeToString(value: bigint | number | string): string | null {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") {
    const trimmed = value.trim();
    return /^\d+$/.test(trimmed) ? trimmed : null;
  }
  if (!Number.isSafeInteger(value)) return null;
  return BigInt(value).toString();
}

export async function endOpenVcSessionForMemberPostgres(
  pool: Pool,
  guildId: string,
  userId: string,
): Promise<void> {
  await runPostgresVcUserUpdate(pool, userId, () => closeOpenSessionPostgres(pool, guildId, userId));
}

export async function reconcileVcTimeSessionsAtReadyPostgres(
  client: Client,
  pool: Pool,
  targetGuildId: string,
): Promise<void> {
  const guild = client.guilds.cache.get(targetGuildId);
  if (!guild) return;

  const live = new Map<string, string>();
  for (const member of guild.members.cache.values()) {
    const chId = member.voice?.channelId;
    if (chId) live.set(`${guild.id}:${member.id}`, chId);
  }

  for (const [key, channelId] of live.entries()) {
    const uid = key.split(":")[1];
    if (!uid) continue;
    const openRows = await pool.query<{ id: number; startedat: string }>(
      `SELECT id, started_at AS "startedat" FROM sessions WHERE guild_id = $1 AND user_id = $2 AND ended_at IS NULL ORDER BY id`,
      [guild.id, uid],
    );
    if (openRows.rowCount === 0) {
      await startSessionPostgres(pool, guild.id, uid, channelId);
      continue;
    }
    const now = new Date();
    if (openRows.rows.length > 1 || openRows.rows.some((row) => isOpenSessionStale(row.startedat, now))) {
      await closeOpenSessionPostgres(pool, guild.id, uid);
      await startSessionPostgres(pool, guild.id, uid, channelId);
    }
  }

  const openRows = await pool.query<{ user_id: string | number | bigint }>(
    `SELECT user_id FROM sessions WHERE guild_id = $1 AND ended_at IS NULL`,
    [guild.id],
  );
  for (const row of openRows.rows) {
    const uid = dbSnowflakeToString(row.user_id);
    if (!uid) continue;
    const k = `${guild.id}:${uid}`;
    if (!live.has(k)) await closeOpenSessionPostgres(pool, guild.id, uid);
  }
}

export async function trackVoiceStateUpdatePostgres(
  pool: Pool,
  oldS: VoiceState,
  newS: VoiceState,
  targetGuildId: string,
): Promise<void> {
  if (newS.guild.id !== targetGuildId) return;
  if (newS.member?.user.bot) return;
  const guildId = newS.guild.id;
  const userId = newS.id;
  const oldCh = oldS.channelId;
  const newCh = newS.channelId;

  if (oldCh && newCh && oldCh === newCh) return;

  await runPostgresVcUserUpdate(pool, userId, async () => {
    await closeOpenSessionPostgres(pool, guildId, userId);
    if (newCh) await startSessionPostgres(pool, guildId, userId, newCh);
  });
}
