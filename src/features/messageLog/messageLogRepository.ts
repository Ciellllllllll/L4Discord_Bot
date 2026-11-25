import type { Pool } from "pg";
import { normalizeSnowflake, snowflakeToBigInt } from "../../core/snowflake.js";
import { lookupStoredAttachmentsMapPostgres, type StoredAttachmentRow } from "./messageAttachmentArchive.js";
import {
  describeLogType,
  resolveAttachmentCount,
  resolvePrimaryTimestamp,
  resolveSenderLine,
  snowflakeFromDb,
  type LogRow,
  type SearchSession,
} from "./messageLogFilters.js";

export const MESSAGE_LOG_RESULTS_PER_PAGE = 5;

const LOG_EVENT_TIME_SQL =
  "COALESCE(CASE WHEN log_type='delete' THEN deleted_at WHEN log_type='edit' THEN edited_at ELSE created_at END, time)";

const LOG_ROW_SELECT = `id, log_type, guild_id, channel_id, user_id, user_name, content,
  edited_at, deleted_at, time, message_id, author_id, author_tag, author_display_name,
  created_at, message_type, attachments, attachments_json, attachment_count, embeds_json, reply_ref_json`;

function buildPostgresWhereClause(session: SearchSession, botUserId: string): { where: string[]; params: unknown[] } {
  const params: unknown[] = [];
  const add = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };
  const where: string[] = [`guild_id = ${add(snowflakeToBigInt(session.guildId))}`];
  const selfBot = normalizeSnowflake(botUserId);
  if (selfBot) {
    where.push(`(COALESCE(author_id, user_id) IS NULL OR COALESCE(author_id, user_id) != ${add(snowflakeToBigInt(selfBot))})`);
  }
  if (session.userId) where.push(`COALESCE(author_id, user_id) = ${add(snowflakeToBigInt(session.userId))}`);
  if (session.channelId) where.push(`channel_id = ${add(snowflakeToBigInt(session.channelId))}`);
  if (session.keyword) {
    const esc = session.keyword.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
    where.push(`content ILIKE ${add(`%${esc}%`)} ESCAPE '\\'`);
  }
  if (session.fromIso) where.push(`${LOG_EVENT_TIME_SQL} >= ${add(session.fromIso)}`);
  if (session.toIso) where.push(`${LOG_EVENT_TIME_SQL} <= ${add(session.toIso)}`);
  if (session.attachmentsOnly) {
    where.push("(COALESCE(attachment_count, 0) > 0 OR (COALESCE(attachments_json, '') NOT IN ('', '[]', 'null')) OR (COALESCE(attachments, '') NOT IN ('', '[]')))");
  }
  return { where, params };
}

export async function searchMessageLogsPostgres(
  pool: Pool,
  session: SearchSession,
  botUserId: string,
): Promise<{ total: number; totalPages: number; rows: LogRow[] }> {
  const { where, params } = buildPostgresWhereClause(session, botUserId);
  const whereSql = where.join(" AND ");
  const count = await pool.query<{ total: string }>(`SELECT COUNT(*) AS total FROM message_logs WHERE ${whereSql}`, params);
  const total = Number(count.rows[0]?.total ?? 0);
  const totalPages = Math.max(1, Math.ceil(total / MESSAGE_LOG_RESULTS_PER_PAGE));
  if (session.page >= totalPages) session.page = totalPages - 1;
  if (session.page < 0) session.page = 0;
  const limitParam = params.length + 1;
  const offsetParam = params.length + 2;
  const rows = await pool.query<LogRow>(
    `SELECT ${LOG_ROW_SELECT}, ${LOG_EVENT_TIME_SQL} AS event_time FROM message_logs WHERE ${whereSql}
     ORDER BY ${LOG_EVENT_TIME_SQL} DESC, id DESC LIMIT $${limitParam} OFFSET $${offsetParam}`,
    [...params, MESSAGE_LOG_RESULTS_PER_PAGE, session.page * MESSAGE_LOG_RESULTS_PER_PAGE],
  );
  return { total, totalPages, rows: rows.rows };
}

export async function fetchLogByIdPostgres(
  pool: Pool,
  guildId: string,
  logId: number,
): Promise<LogRow | undefined> {
  const result = await pool.query<LogRow>(
    `SELECT ${LOG_ROW_SELECT} FROM message_logs WHERE id = $1 AND guild_id = $2`,
    [logId, snowflakeToBigInt(guildId)],
  );
  return result.rows[0];
}

export async function fetchLogsForExportPostgres(
  pool: Pool,
  session: SearchSession,
  botUserId: string,
  limit: number,
): Promise<{ total: number; rows: LogRow[] }> {
  const { where, params } = buildPostgresWhereClause(session, botUserId);
  const whereSql = where.join(" AND ");
  const count = await pool.query<{ total: string }>(`SELECT COUNT(*) AS total FROM message_logs WHERE ${whereSql}`, params);
  const total = Number(count.rows[0]?.total ?? 0);
  const rows = await pool.query<LogRow>(
    `SELECT ${LOG_ROW_SELECT}, ${LOG_EVENT_TIME_SQL} AS event_time FROM message_logs WHERE ${whereSql} ORDER BY ${LOG_EVENT_TIME_SQL} DESC, id DESC LIMIT $${params.length + 1}`,
    [...params, limit],
  );
  return { total, rows: rows.rows };
}

function formatExportEntry(
  row: LogRow,
  index: number,
  storedMap?: Map<string, StoredAttachmentRow>,
): string {
  const channelId = snowflakeFromDb(row.channel_id) || "-";
  const messageId = snowflakeFromDb(row.message_id) || "-";
  const primary = resolvePrimaryTimestamp(row);
  const content = String(row.content || "").replace(/\r\n/g, "\n");
  const lines = [
    `#${index}`,
    `ログID: ${row.id}`,
    `ログ種別: ${describeLogType(row.log_type)}`,
    `送信者: ${resolveSenderLine(row)}`,
    `チャンネルID: ${channelId}`,
    `メッセージID: ${messageId}`,
    `${primary.label}: ${primary.iso || "-"}`,
    `本文:`,
    content || "(空)",
    `添付件数: ${resolveAttachmentCount(row)}`,
  ];
  if (storedMap && storedMap.size > 0 && snowflakeFromDb(row.guild_id) && snowflakeFromDb(row.message_id)) {
    lines.push("保存済み添付:");
    for (const s of storedMap.values()) {
      lines.push(`  - ${s.filename}: ${s.storage_relpath} (${s.size_bytes != null ? `${s.size_bytes} B` : "?"})`);
    }
  }
  return lines.join("\n");
}

export async function buildExportTextPostgres(
  pool: Pool | undefined,
  session: SearchSession,
  rows: LogRow[],
  total: number,
): Promise<string> {
  const maps = new Map<string, Map<string, StoredAttachmentRow>>();
  if (pool) {
    for (const row of rows) {
      const gid = snowflakeFromDb(row.guild_id);
      const mid = snowflakeFromDb(row.message_id);
      if (!gid || !mid) continue;
      const key = `${gid}:${mid}`;
      if (!maps.has(key)) maps.set(key, await lookupStoredAttachmentsMapPostgres(pool, gid, mid));
    }
  }
  const header = [
    "メッセージログ出力",
    `生成日時: ${new Date().toISOString()}`,
    `サーバーID: ${session.guildId}`,
    `実行者ID: ${session.ownerId}`,
    `キーワード: ${session.keyword || "-"}`,
    `ユーザーID: ${session.userId || "-"}`,
    `チャンネルID: ${session.channelId || "-"}`,
    `開始: ${session.fromIso || "-"}`,
    `終了: ${session.toIso || "-"}`,
    `添付ありのみ: ${session.attachmentsOnly ? "はい" : "いいえ"}`,
    `総件数: ${total}`,
    `出力件数: ${rows.length}`,
    "",
  ];
  const body = rows
    .map((row, i) => {
      const gid = snowflakeFromDb(row.guild_id);
      const mid = snowflakeFromDb(row.message_id);
      return formatExportEntry(row, i + 1, gid && mid ? maps.get(`${gid}:${mid}`) : undefined);
    })
    .join("\n\n----------------------------------------\n\n");
  return `${header.join("\n")}${body}`;
}

export async function exportMessageLogsPostgres(
  pool: Pool,
  attachmentPool: Pool | undefined,
  session: SearchSession,
  botUserId: string,
  limit: number,
): Promise<{ total: number; rows: LogRow[]; content: string }> {
  const result = await fetchLogsForExportPostgres(pool, session, botUserId, limit);
  return { ...result, content: await buildExportTextPostgres(attachmentPool, session, result.rows, result.total) };
}
