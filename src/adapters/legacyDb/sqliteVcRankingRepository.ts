import type DatabaseLib from "better-sqlite3";
import { vcRankingPeriodStartIso } from "../../core/vcRankingPeriod.js";
import { bigIntToSnowflake, snowflakeToBigInt } from "../../core/snowflake.js";
import type { IVcRankingRepository, VcRankEntry, VcRankPeriod } from "./vcRankingRepository.js";
import { mergedIntervalSeconds, type VcRankingInterval } from "./vcRankingIntervals.js";

function normalizeUserId(userId: string | bigint | number): string {
  if (typeof userId === "string") return userId.trim();
  return bigIntToSnowflake(userId);
}

export class SqliteVcRankingRepository implements IVcRankingRepository {
  constructor(
    private readonly sqlite: DatabaseLib.Database,
    private readonly rankingTimeZone: string,
  ) {}

  async getRanking(guildId: string, period: VcRankPeriod): Promise<VcRankEntry[]> {
    const gid = snowflakeToBigInt(guildId);
    const start = vcRankingPeriodStartIso(period, this.rankingTimeZone);
    const periodStartMs = start ? Date.parse(start) : null;
    let sql = `
      SELECT CAST(user_id AS TEXT) AS userId, started_at AS startedAt, ended_at AS endedAt
      FROM sessions
      WHERE guild_id = ? AND ended_at IS NOT NULL
    `;
    const args: (bigint | string)[] = [gid];
    if (start) {
      sql += ` AND ended_at > ?`;
      args.push(start);
    }
    sql += ` ORDER BY user_id, started_at, ended_at, id`;
    const stmt = this.sqlite.prepare(sql);
    const rows = stmt.all(...args) as {
      userId: string | bigint | number;
      startedAt: string;
      endedAt: string;
    }[];

    const intervalsByUser = new Map<string, VcRankingInterval[]>();
    for (const row of rows) {
      const rawStartMs = Date.parse(row.startedAt);
      const rawEndMs = Date.parse(row.endedAt);
      const clippedStartMs = periodStartMs === null ? rawStartMs : Math.max(rawStartMs, periodStartMs);
      if (!Number.isFinite(clippedStartMs) || !Number.isFinite(rawEndMs) || rawEndMs <= clippedStartMs) continue;

      const userId = normalizeUserId(row.userId);
      const intervals = intervalsByUser.get(userId) ?? [];
      intervals.push({ startMs: clippedStartMs, endMs: rawEndMs });
      intervalsByUser.set(userId, intervals);
    }

    return [...intervalsByUser.entries()]
      .map(([userId, intervals]) => ({ userId, seconds: mergedIntervalSeconds(intervals) }))
      .filter((entry) => entry.seconds > 0)
      .sort((a, b) => b.seconds - a.seconds || a.userId.localeCompare(b.userId))
      .slice(0, 25);
  }
}
