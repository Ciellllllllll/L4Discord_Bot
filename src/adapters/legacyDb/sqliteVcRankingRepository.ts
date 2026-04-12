import type DatabaseLib from "better-sqlite3";
import { vcRankingPeriodStartIso } from "../../core/vcRankingPeriod.js";
import { bigIntToSnowflake, snowflakeToBigInt } from "../../core/snowflake.js";
import type { IVcRankingRepository, VcRankEntry, VcRankPeriod } from "./vcRankingRepository.js";

export class SqliteVcRankingRepository implements IVcRankingRepository {
  constructor(
    private readonly sqlite: DatabaseLib.Database,
    private readonly rankingTimeZone: string,
  ) {}

  async getRanking(guildId: string, period: VcRankPeriod): Promise<VcRankEntry[]> {
    const gid = snowflakeToBigInt(guildId);
    const start = vcRankingPeriodStartIso(period, this.rankingTimeZone);
    let sql = `
      SELECT CAST(user_id AS TEXT) AS userId, SUM(duration_sec) AS sec
      FROM sessions
      WHERE guild_id = ? AND ended_at IS NOT NULL AND duration_sec IS NOT NULL
    `;
    const args: (bigint | string)[] = [gid];
    if (start) {
      sql += ` AND started_at >= ?`;
      args.push(start);
    }
    sql += ` GROUP BY user_id ORDER BY SUM(duration_sec) DESC LIMIT 25`;
    const stmt = this.sqlite.prepare(sql);
    const rows = stmt.all(...args) as { userId: string | bigint | number; sec: string | number | bigint | null }[];
    return rows.map((r) => ({
      userId:
        typeof r.userId === "string"
          ? r.userId.trim()
          : bigIntToSnowflake(typeof r.userId === "bigint" ? r.userId : BigInt(Math.trunc(Number(r.userId)))),
      seconds: Number(r.sec ?? 0),
    }));
  }
}
