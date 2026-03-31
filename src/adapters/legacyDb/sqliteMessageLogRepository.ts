import type DatabaseLib from "better-sqlite3";
import { bigIntToSnowflake, snowflakeToBigInt } from "../../core/snowflake.js";
import type { IMessageLogRepository, MessageLogHit, MessageLogSearchParams } from "./messageLogRepository.js";

function escapeFtsQuery(raw: string): string {
  const t = raw.trim().slice(0, 500);
  if (!t) return "";
  return `"${t.replace(/"/g, '""')}"`;
}

export class SqliteMessageLogRepository implements IMessageLogRepository {
  constructor(private readonly sqlite: DatabaseLib.Database) {}

  async search(params: MessageLogSearchParams): Promise<MessageLogHit[]> {
    const pattern = escapeFtsQuery(params.query);
    if (!pattern) return [];
    const gid = snowflakeToBigInt(params.guildId);
    const lim = Math.min(Math.max(params.limit, 1), 50);
    const stmt = this.sqlite.prepare(`
      SELECT m.id AS id, m.channel_id AS channelId, m.user_id AS userId,
             m.content AS content, m.time AS time
      FROM message_logs m
      INNER JOIN message_logs_fts fts ON fts.rowid = m.id
      WHERE fts MATCH ? AND m.guild_id = ?
      ORDER BY m.id DESC
      LIMIT ?
    `);
    const rows = stmt.all(pattern, gid, lim) as {
      id: number;
      channelId: bigint | number;
      userId: bigint | number;
      content: string | null;
      time: string | null;
    }[];
    return rows.map((r) => ({
      id: String(r.id),
      channelId: bigIntToSnowflake(
        typeof r.channelId === "bigint" ? r.channelId : BigInt(Math.trunc(Number(r.channelId))),
      ),
      authorId: bigIntToSnowflake(typeof r.userId === "bigint" ? r.userId : BigInt(Math.trunc(Number(r.userId)))),
      snippet: (r.content ?? "").slice(0, 200),
      createdAt: r.time ?? "",
    }));
  }
}
