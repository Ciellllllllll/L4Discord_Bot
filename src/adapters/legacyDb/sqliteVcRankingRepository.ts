import type DatabaseLib from "better-sqlite3";
import { bigIntToSnowflake, snowflakeToBigInt } from "../../core/snowflake.js";
import type { IVcRankingRepository, VcRankEntry, VcRankPeriod } from "./vcRankingRepository.js";

function periodStartIso(period: VcRankPeriod): string | null {
  const now = Date.now();
  const d = new Date(now);
  if (period === "all") return null;
  if (period === "day") {
    d.setHours(0, 0, 0, 0);
  } else if (period === "week") {
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    d.setDate(diff);
    d.setHours(0, 0, 0, 0);
  } else if (period === "month") {
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
  }
  return d.toISOString();
}

export class SqliteVcRankingRepository implements IVcRankingRepository {
  constructor(private readonly sqlite: DatabaseLib.Database) {}

  async getRanking(guildId: string, period: VcRankPeriod): Promise<VcRankEntry[]> {
    const gid = snowflakeToBigInt(guildId);
    const start = periodStartIso(period);
    let sql = `
      SELECT CAST(user_id AS TEXT) AS userId, CAST(SUM(duration_sec) AS TEXT) AS sec
      FROM sessions
      WHERE guild_id = ? AND ended_at IS NOT NULL AND duration_sec IS NOT NULL
    `;
    const args: (bigint | string)[] = [gid];
    if (start) {
      sql += ` AND started_at >= ?`;
      args.push(start);
    }
    sql += ` GROUP BY user_id ORDER BY sec DESC LIMIT 25`;
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
