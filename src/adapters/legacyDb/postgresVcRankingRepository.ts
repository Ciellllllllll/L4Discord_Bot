import type { Pool } from "pg";
import { vcRankingPeriodStartIso } from "../../core/vcRankingPeriod.js";
import type { IVcRankingRepository, VcRankEntry, VcRankPeriod } from "./vcRankingRepository.js";
import { mergedIntervalSeconds, type VcRankingInterval } from "./vcRankingIntervals.js";

export class PostgresVcRankingRepository implements IVcRankingRepository {
  constructor(
    private readonly pool: Pool,
    private readonly rankingTimeZone: string,
  ) {}

  async getRanking(guildId: string, period: VcRankPeriod): Promise<VcRankEntry[]> {
    const start = vcRankingPeriodStartIso(period, this.rankingTimeZone);
    const result = await this.pool.query<{ user_id: string; started_at: string; ended_at: string }>(
      `SELECT user_id, started_at, ended_at
       FROM sessions
       WHERE guild_id = $1 AND ended_at IS NOT NULL${start ? " AND ended_at > $2" : ""}
       ORDER BY user_id, started_at, ended_at, id`,
      start ? [guildId, start] : [guildId],
    );
    const periodStartMs = start ? Date.parse(start) : null;
    const intervalsByUser = new Map<string, VcRankingInterval[]>();
    for (const row of result.rows) {
      const rawStartMs = Date.parse(row.started_at);
      const rawEndMs = Date.parse(row.ended_at);
      const clippedStartMs = periodStartMs === null ? rawStartMs : Math.max(rawStartMs, periodStartMs);
      if (!Number.isFinite(clippedStartMs) || !Number.isFinite(rawEndMs) || rawEndMs <= clippedStartMs) continue;
      const intervals = intervalsByUser.get(row.user_id) ?? [];
      intervals.push({ startMs: clippedStartMs, endMs: rawEndMs });
      intervalsByUser.set(row.user_id, intervals);
    }
    return [...intervalsByUser.entries()]
      .map(([userId, intervals]) => ({ userId, seconds: mergedIntervalSeconds(intervals) }))
      .filter((entry) => entry.seconds > 0)
      .sort((a, b) => b.seconds - a.seconds || a.userId.localeCompare(b.userId))
      .slice(0, 25);
  }
}
