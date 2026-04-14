import { randomBytes } from "node:crypto";
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ModalSubmitInteraction,
} from "discord.js";
import type DatabaseLib from "better-sqlite3";
import type { BotContext } from "../../bot/context.js";
import { isAdmin } from "../../core/permission.js";
import { bigIntToSnowflake, snowflakeToBigInt } from "../../core/snowflake.js";
import {
  buildDetailImageSlots,
  formatStoredHint,
  lookupStoredAttachmentsMap,
} from "./messageAttachmentArchive.js";

export const PANEL_BUTTON_ID = "message_logs_open";
const MODAL_PREFIX = "ml:modal:";
const LIST_PREFIX = "ml:list:";
const DETAIL_PREFIX = "ml:detail:";

const RESULTS_PER_PAGE = 5;
const MAX_EXPORT_ROWS = 5000;
const MAX_CONTENT_PREVIEW = 120;
const CONTENT_CHUNK = 3500;
const MAX_CONTENT_EMBEDS = 5;
const SESSION_TTL_MS = 30 * 60 * 1000;

const LOG_EVENT_TIME_SQL =
  "COALESCE(CASE WHEN log_type='delete' THEN deleted_at WHEN log_type='edit' THEN edited_at ELSE created_at END, time)";

type SearchSession = {
  id: string;
  ownerId: string;
  guildId: string;
  keyword: string;
  userId: string | null;
  channelId: string | null;
  fromIso: string | null;
  toIso: string | null;
  attachmentsOnly: boolean;
  page: number;
  createdAt: number;
  lastTouchedAt: number;
};

const searchSessions = new Map<string, SearchSession>();

function makeSessionId(): string {
  for (let i = 0; i < 5; i += 1) {
    const id = randomBytes(6)
      .toString("base64url")
      .replace(/[^a-zA-Z0-9]/g, "")
      .slice(0, 8);
    if (id && !searchSessions.has(id)) return id;
  }
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`.slice(0, 8);
}

function cleanupSearchSessions(): void {
  const now = Date.now();
  for (const [id, s] of searchSessions.entries()) {
    if (now - s.lastTouchedAt > SESSION_TTL_MS) searchSessions.delete(id);
  }
}

function normalizeSnowflake(value: unknown): string | null {
  const s = String(value ?? "").trim();
  return /^\d+$/.test(s) ? s : null;
}

function snowflakeFromDb(v: bigint | number | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  try {
    return bigIntToSnowflake(typeof v === "bigint" ? v : BigInt(Math.trunc(Number(v))));
  } catch {
    return null;
  }
}

function toUnixSeconds(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function formatDiscordDate(iso: string | null | undefined): string {
  const sec = toUnixSeconds(iso);
  return sec ? `<t:${sec}:F>` : String(iso || "-");
}

function parseDateInput(raw: string, endOfDay = false): { iso: string | null; error: string | null } {
  const input = String(raw || "").trim();
  if (!input) return { iso: null, error: null };
  if (/^\d{10,13}$/.test(input)) {
    const asNum = Number(input);
    const ms = input.length === 13 ? asNum : asNum * 1000;
    const dt = new Date(ms);
    if (!Number.isFinite(dt.getTime())) return { iso: null, error: `日時の形式が不正です: ${input}` };
    return { iso: dt.toISOString(), error: null };
  }
  const dateOnly = input.match(/^(\d{4})[/-](\d{2})[/-](\d{2})$/);
  if (dateOnly) {
    const normalized = `${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}`;
    const dt = new Date(normalized);
    if (!Number.isFinite(dt.getTime())) return { iso: null, error: `日時の形式が不正です: ${input}` };
    return { iso: dt.toISOString(), error: null };
  }
  const normalized = input.replace(/\//g, "-").replace(/\s+/, "T");
  const dt = new Date(normalized);
  if (!Number.isFinite(dt.getTime())) return { iso: null, error: `日時の形式が不正です: ${input}` };
  return { iso: dt.toISOString(), error: null };
}

function formatForInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const dt = new Date(iso);
  if (!Number.isFinite(dt.getTime())) return "";
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const d = String(dt.getDate()).padStart(2, "0");
  const hh = String(dt.getHours()).padStart(2, "0");
  const mm = String(dt.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${d} ${hh}:${mm}`;
}

function extractSnowflakeInput(raw: string): string | null {
  const s = String(raw || "").trim();
  if (!s) return null;
  const mention = s.match(/^<[@#]!?(\d+)>$/);
  if (mention) return mention[1] ?? null;
  const plain = normalizeSnowflake(s);
  if (plain) return plain;
  const fromText = s.match(/(\d{17,20})/);
  return fromText ? (fromText[1] ?? null) : null;
}

function shorten(text: string, max = 80): string {
  const src = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!src) return "";
  return src.length <= max ? src : `${src.slice(0, max - 1)}…`;
}

function canUseLogUi(interaction: { guildId: string | null; member: unknown }, ctx: BotContext): boolean {
  const member = interaction.member && typeof interaction.member === "object" && "roles" in interaction.member
    ? interaction.member
    : null;
  if (!interaction.guildId || interaction.guildId !== ctx.config.GUILD_ID) return false;
  return isAdmin(member as never, ctx.config);
}

function buildSearchModal(existing: SearchSession | null): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId(`${MODAL_PREFIX}${existing?.id ?? "new"}`)
    .setTitle("メッセージログ検索条件");

  const keywordInput = new TextInputBuilder()
    .setCustomId("ml_keyword")
    .setLabel("キーワード (任意)")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setPlaceholder("本文に含まれる語句");

  const userInput = new TextInputBuilder()
    .setCustomId("ml_user")
    .setLabel("ユーザーID/メンション (任意)")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setPlaceholder("123… または <@…>");

  const channelInput = new TextInputBuilder()
    .setCustomId("ml_channel")
    .setLabel("チャンネルID/メンション (任意)")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setPlaceholder("123… または <#…>");

  const fromInput = new TextInputBuilder()
    .setCustomId("ml_from")
    .setLabel("開始日時 (任意)")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setPlaceholder("例: 2026-03-16 00:00");

  const toInput = new TextInputBuilder()
    .setCustomId("ml_to")
    .setLabel("終了日時 (任意)")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setPlaceholder("例: 2026-03-16 23:59");

  if (existing) {
    if (existing.keyword) keywordInput.setValue(existing.keyword.slice(0, 100));
    if (existing.userId) userInput.setValue(existing.userId);
    if (existing.channelId) channelInput.setValue(existing.channelId);
    if (existing.fromIso) fromInput.setValue(formatForInput(existing.fromIso));
    if (existing.toIso) toInput.setValue(formatForInput(existing.toIso));
  }

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(keywordInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(userInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(channelInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(fromInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(toInput),
  );
  return modal;
}

type SearchFilters = {
  keyword: string;
  userId: string | null;
  channelId: string | null;
  fromIso: string | null;
  toIso: string | null;
};

function parseSearchModalFields(interaction: ModalSubmitInteraction): { ok: true; filters: SearchFilters } | { ok: false; error: string } {
  const keyword = String(interaction.fields.getTextInputValue("ml_keyword") || "")
    .trim()
    .slice(0, 100);
  const userRaw = String(interaction.fields.getTextInputValue("ml_user") || "").trim();
  const channelRaw = String(interaction.fields.getTextInputValue("ml_channel") || "").trim();
  const fromRaw = String(interaction.fields.getTextInputValue("ml_from") || "").trim();
  const toRaw = String(interaction.fields.getTextInputValue("ml_to") || "").trim();

  const userId = userRaw ? extractSnowflakeInput(userRaw) : null;
  if (userRaw && !userId) return { ok: false, error: "ユーザー指定が不正です。ID またはメンション形式で入力してください。" };

  const channelId = channelRaw ? extractSnowflakeInput(channelRaw) : null;
  if (channelRaw && !channelId) return { ok: false, error: "チャンネル指定が不正です。ID またはメンション形式で入力してください。" };

  const fromParsed = parseDateInput(fromRaw, false);
  if (fromParsed.error) return { ok: false, error: fromParsed.error };

  const toParsed = parseDateInput(toRaw, true);
  if (toParsed.error) return { ok: false, error: toParsed.error };

  if (fromParsed.iso && toParsed.iso && new Date(fromParsed.iso).getTime() > new Date(toParsed.iso).getTime()) {
    return { ok: false, error: "開始日時は終了日時より前にしてください。" };
  }

  return {
    ok: true,
    filters: { keyword, userId, channelId, fromIso: fromParsed.iso, toIso: toParsed.iso },
  };
}

type LogRow = {
  id: number;
  log_type: string | null;
  guild_id: bigint | number | null;
  channel_id: bigint | number | null;
  user_id: bigint | number | null;
  user_name: string | null;
  content: string | null;
  edited_at: string | null;
  deleted_at: string | null;
  time: string | null;
  message_id: bigint | number | null;
  author_id: bigint | number | null;
  author_tag: string | null;
  author_display_name: string | null;
  created_at: string | null;
  message_type: string | null;
  attachments: string | null;
  attachments_json: string | null;
  attachment_count: number | null;
  embeds_json: string | null;
  reply_ref_json: string | null;
  event_time?: string | null;
};

function buildWhereClause(session: SearchSession, botUserId: string): { where: string[]; params: unknown[] } {
  const gid = snowflakeToBigInt(session.guildId);
  const where: string[] = ["guild_id = ?"];
  const params: unknown[] = [gid];

  const selfBot = normalizeSnowflake(botUserId);
  if (selfBot) {
    where.push("(COALESCE(author_id, user_id) IS NULL OR COALESCE(author_id, user_id) != ?)");
    params.push(snowflakeToBigInt(selfBot));
  }

  if (session.userId) {
    where.push("COALESCE(author_id, user_id) = ?");
    params.push(snowflakeToBigInt(session.userId));
  }
  if (session.channelId) {
    where.push("channel_id = ?");
    params.push(snowflakeToBigInt(session.channelId));
  }
  if (session.keyword) {
    const esc = session.keyword.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
    where.push("content LIKE ? ESCAPE '\\'");
    params.push(`%${esc}%`);
  }
  if (session.fromIso) {
    where.push(`${LOG_EVENT_TIME_SQL} >= ?`);
    params.push(session.fromIso);
  }
  if (session.toIso) {
    where.push(`${LOG_EVENT_TIME_SQL} <= ?`);
    params.push(session.toIso);
  }
  if (session.attachmentsOnly) {
    where.push(
      "(COALESCE(attachment_count, 0) > 0 OR (COALESCE(attachments_json, '') NOT IN ('', '[]', 'null')) OR (COALESCE(attachments, '') NOT IN ('', '[]')))",
    );
  }
  return { where, params };
}

function searchLogsPage(db: DatabaseLib.Database, session: SearchSession, botUserId: string) {
  const { where, params } = buildWhereClause(session, botUserId);
  const whereSql = where.join(" AND ");
  const countRow = db.prepare(`SELECT COUNT(*) AS total FROM message_logs WHERE ${whereSql}`).get(...params) as {
    total: number;
  };
  const total = Number(countRow?.total || 0);
  const totalPages = Math.max(1, Math.ceil(total / RESULTS_PER_PAGE));
  if (session.page >= totalPages) session.page = totalPages - 1;
  if (session.page < 0) session.page = 0;
  const offset = session.page * RESULTS_PER_PAGE;
  const rows = db
    .prepare(
      `SELECT
         id, log_type, guild_id, channel_id, user_id, user_name, content,
         edited_at, deleted_at, time,
         message_id, author_id, author_tag, author_display_name, created_at, message_type,
         attachments, attachments_json, attachment_count, embeds_json, reply_ref_json,
         ${LOG_EVENT_TIME_SQL} AS event_time
       FROM message_logs
       WHERE ${whereSql}
       ORDER BY ${LOG_EVENT_TIME_SQL} DESC, id DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, RESULTS_PER_PAGE, offset) as LogRow[];
  return { total, totalPages, rows };
}

function fetchLogById(db: DatabaseLib.Database, session: SearchSession, logId: number): LogRow | undefined {
  const gid = snowflakeToBigInt(session.guildId);
  return db
    .prepare(
      `SELECT id, log_type, guild_id, channel_id, user_id, user_name, content,
       edited_at, deleted_at, time, message_id, author_id, author_tag, author_display_name,
       created_at, message_type, attachments, attachments_json, attachment_count, embeds_json, reply_ref_json
       FROM message_logs WHERE id = ? AND guild_id = ?`,
    )
    .get(logId, gid) as LogRow | undefined;
}

function fetchLogsForExport(db: DatabaseLib.Database, session: SearchSession, botUserId: string, limit: number) {
  const { where, params } = buildWhereClause(session, botUserId);
  const whereSql = where.join(" AND ");
  const countRow = db.prepare(`SELECT COUNT(*) AS total FROM message_logs WHERE ${whereSql}`).get(...params) as {
    total: number;
  };
  const total = Number(countRow?.total || 0);
  const rows = db
    .prepare(
      `SELECT id, log_type, guild_id, channel_id, user_id, user_name, content,
       edited_at, deleted_at, time, message_id, author_id, author_tag, author_display_name,
       created_at, message_type, attachments, attachments_json, attachment_count, embeds_json, reply_ref_json,
       ${LOG_EVENT_TIME_SQL} AS event_time
       FROM message_logs WHERE ${whereSql}
       ORDER BY ${LOG_EVENT_TIME_SQL} DESC, id DESC
       LIMIT ?`,
    )
    .all(...params, limit) as LogRow[];
  return { total, rows };
}

function resolveAttachmentCount(row: LogRow): number {
  const n = row.attachment_count;
  if (Number.isFinite(Number(n)) && Number(n) > 0) return Number(n);
  const raw = row.attachments_json || row.attachments || "";
  try {
    const p = JSON.parse(String(raw)) as unknown;
    return Array.isArray(p) ? p.length : 0;
  } catch {
    return 0;
  }
}

function describeLogType(logType: string | null): string {
  if (logType === "edit") return "編集";
  if (logType === "delete") return "削除";
  if (logType === "normal") return "送信";
  return logType || "-";
}

function resolvePrimaryTimestamp(row: LogRow): { label: string; iso: string | null } {
  if (row.log_type === "delete" && row.deleted_at) return { label: "削除日時", iso: row.deleted_at };
  if (row.log_type === "edit" && row.edited_at) return { label: "編集日時", iso: row.edited_at };
  return { label: "送信日時", iso: row.created_at || row.time || null };
}

function resolveSenderLine(row: LogRow): string {
  const authorId = snowflakeFromDb(row.author_id ?? row.user_id);
  const tag = String(row.author_tag || row.user_name || "").trim();
  const display = String(row.author_display_name || "").trim();
  const name = display || tag;
  const hasName = name && name !== "-";
  if (authorId) return `<@${authorId}>`;
  if (hasName) return name;
  return "不明";
}

function resolveFieldTitleSuffix(row: LogRow): string {
  const authorId = snowflakeFromDb(row.author_id ?? row.user_id);
  const tag = String(row.author_tag || "").trim();
  const display = String(row.author_display_name || "").trim();
  const name = display || tag;
  if (name && name !== "-") return name;
  if (authorId) return `<@${authorId}>`;
  return "不明";
}

function buildFiltersSummary(session: SearchSession): string {
  return [
    `キーワード: ${session.keyword || "指定なし"}`,
    `ユーザー: ${session.userId ? `<@${session.userId}>` : "指定なし"}`,
    `チャンネル: ${session.channelId ? `<#${session.channelId}>` : "指定なし"}`,
    `期間: ${session.fromIso ? formatDiscordDate(session.fromIso) : "指定なし"} 〜 ${session.toIso ? formatDiscordDate(session.toIso) : "指定なし"}`,
    `添付ありのみ: ${session.attachmentsOnly ? "有効" : "無効"}`,
  ].join("\n");
}

function buildListEmbed(session: SearchSession, rows: LogRow[], total: number, totalPages: number): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle("メッセージログ検索結果")
    .setColor(0x3498db)
    .setDescription(buildFiltersSummary(session))
    .setFooter({ text: `ページ ${session.page + 1}/${totalPages} | 全 ${total} 件` });

  if (rows.length === 0) {
    embed.addFields({ name: "結果", value: "該当するログはありません。" });
    return embed;
  }

  rows.forEach((row, index) => {
    const absolute = session.page * RESULTS_PER_PAGE + index + 1;
    const channelId = snowflakeFromDb(row.channel_id);
    const primary = resolvePrimaryTimestamp(row);
    const preview = shorten(row.content ?? "", MAX_CONTENT_PREVIEW) || "(本文なし)";
    const count = resolveAttachmentCount(row);
    const channelLabel = channelId ? `<#${channelId}>` : `ID:${snowflakeFromDb(row.channel_id) || "-"}`;
    embed.addFields({
      name: `${absolute}. ${resolveFieldTitleSuffix(row)}`,
      value: [
        `送信者: ${resolveSenderLine(row)}`,
        `チャンネル: ${channelLabel}`,
        `${primary.label}: ${formatDiscordDate(primary.iso)}`,
        `種別: ${describeLogType(row.log_type)}`,
        `本文先頭: ${preview}`,
        `添付件数: ${count}`,
      ].join("\n"),
    });
  });
  return embed;
}

function buildListComponents(session: SearchSession, rows: LogRow[], total: number, totalPages: number) {
  const navRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${LIST_PREFIX}${session.id}:prev`)
      .setLabel("前へ")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(total === 0 || session.page <= 0),
    new ButtonBuilder()
      .setCustomId(`${LIST_PREFIX}${session.id}:next`)
      .setLabel("次へ")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(total === 0 || session.page + 1 >= totalPages),
    new ButtonBuilder()
      .setCustomId(`${LIST_PREFIX}${session.id}:toggle_attach`)
      .setLabel(`添付ありのみ: ${session.attachmentsOnly ? "有効" : "無効"}`)
      .setStyle(session.attachmentsOnly ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${LIST_PREFIX}${session.id}:modal`)
      .setLabel("条件を再入力")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`${LIST_PREFIX}${session.id}:export`)
      .setLabel("テキスト出力")
      .setStyle(ButtonStyle.Secondary),
  );
  const out: ActionRowBuilder<ButtonBuilder>[] = [navRow];
  if (rows.length > 0) {
    const detailButtons = rows.map((row, idx) => {
      const listNumber = session.page * RESULTS_PER_PAGE + idx + 1;
      return new ButtonBuilder()
        .setCustomId(`${DETAIL_PREFIX}${session.id}:${row.id}:0:img:open`)
        .setLabel(`詳細${listNumber}`)
        .setStyle(ButtonStyle.Secondary);
    });
    out.push(new ActionRowBuilder<ButtonBuilder>().addComponents(detailButtons));
  }
  return out;
}

function buildListPayload(db: DatabaseLib.Database, session: SearchSession, botUserId: string) {
  const { total, totalPages, rows } = searchLogsPage(db, session, botUserId);
  return {
    embeds: [buildListEmbed(session, rows, total, totalPages)],
    components: buildListComponents(session, rows, total, totalPages),
    files: [],
  };
}

function buildMessageUrl(guildId: string | null, channelId: string | null, messageId: string | null): string | null {
  const g = normalizeSnowflake(guildId);
  const c = normalizeSnowflake(channelId);
  const m = normalizeSnowflake(messageId);
  if (!g || !c || !m) return null;
  return `https://discord.com/channels/${g}/${c}/${m}`;
}

function buildDetailMetaEmbed(row: LogRow): EmbedBuilder {
  const states: string[] = [];
  if (row.edited_at) states.push(`編集済み: ${formatDiscordDate(row.edited_at)}`);
  if (row.deleted_at) states.push(`削除ログ: ${formatDiscordDate(row.deleted_at)}`);
  if (states.length === 0) states.push("通常");

  const channelId = snowflakeFromDb(row.channel_id);
  const primary = resolvePrimaryTimestamp(row);
  const gid = snowflakeFromDb(row.guild_id);
  const mid = snowflakeFromDb(row.message_id);
  const url = buildMessageUrl(gid, channelId, mid);

  const embed = new EmbedBuilder()
    .setTitle(`メッセージログ詳細 #${row.id}`)
    .setColor(0x2ecc71)
    .addFields({
      name: "投稿メタ情報",
      value: [
        `送信者: ${resolveSenderLine(row)}`,
        `チャンネル: ${channelId ? `<#${channelId}>` : "-"}`,
        `${primary.label}: ${formatDiscordDate(primary.iso)}`,
        `ログ種別: ${describeLogType(row.log_type)}`,
        `メッセージ種別: ${row.message_type || "-"}`,
        `状態: ${states.join(" / ")}`,
      ].join("\n"),
    });

  if (url) embed.addFields({ name: "Discord メッセージURL", value: `[開く](${url})` });

  let replyRef: Record<string, unknown> | null = null;
  try {
    const p = row.reply_ref_json ? JSON.parse(row.reply_ref_json) : null;
    replyRef = p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : null;
  } catch {
    replyRef = null;
  }
  if (replyRef) {
    const rMid = normalizeSnowflake(replyRef.message_id);
    const rCh = normalizeSnowflake(replyRef.channel_id);
    const rG = normalizeSnowflake(replyRef.guild_id) || gid;
    const rUrl = buildMessageUrl(rG, rCh, rMid);
    const rUser = normalizeSnowflake(replyRef.replied_user_id);
    const replyText = [
      `返信先メッセージID: ${rMid || "-"}`,
      `返信先チャンネル: ${rCh ? `<#${rCh}>` : "-"}`,
      rUser ? `返信先ユーザー: <@${rUser}>` : null,
      rUrl ? `[返信元を開く](${rUrl})` : null,
    ]
      .filter(Boolean)
      .join("\n");
    embed.addFields({ name: "返信情報", value: replyText || "-" });
  }

  let embedSummaries: { type?: string; title?: string | null; description?: string | null }[] = [];
  try {
    const p = row.embeds_json ? JSON.parse(row.embeds_json) : [];
    embedSummaries = Array.isArray(p) ? p : [];
  } catch {
    embedSummaries = [];
  }
  if (embedSummaries.length > 0) {
    const summaryLines = embedSummaries.slice(0, 3).map((item, i) => {
      const bits = [
        `#${i + 1}`,
        item.type || "embed",
        item.title ? `title:${shorten(String(item.title), 40)}` : null,
        item.description ? `desc:${shorten(String(item.description), 60)}` : null,
      ].filter(Boolean);
      return bits.join(" | ");
    });
    embed.addFields({
      name: `埋め込み要約 (${embedSummaries.length})`,
      value: summaryLines.join("\n"),
    });
  }
  return embed;
}

function splitLongText(text: string, chunk: number): string[] {
  const src = String(text || "");
  if (!src) return [""];
  const out: string[] = [];
  for (let i = 0; i < src.length; i += chunk) out.push(src.slice(i, i + chunk));
  return out;
}

function buildContentEmbeds(content: string | null): EmbedBuilder[] {
  const source = String(content || "");
  if (!source) {
    return [new EmbedBuilder().setTitle("本文").setColor(0x1abc9c).setDescription("(本文なし)")];
  }
  const chunks = splitLongText(source, CONTENT_CHUNK);
  const out: EmbedBuilder[] = [];
  for (let i = 0; i < Math.min(chunks.length, MAX_CONTENT_EMBEDS); i += 1) {
    out.push(
      new EmbedBuilder()
        .setTitle(chunks.length > 1 ? `本文 (${i + 1}/${Math.min(chunks.length, MAX_CONTENT_EMBEDS)})` : "本文")
        .setColor(0x1abc9c)
        .setDescription(chunks[i]!.slice(0, 4096)),
    );
  }
  if (chunks.length > MAX_CONTENT_EMBEDS) {
    const last = out[out.length - 1]!;
    const consumed = chunks.slice(0, MAX_CONTENT_EMBEDS).join("").length;
    const left = Math.max(0, source.length - consumed);
    last.setDescription(`${last.data.description || ""}\n\n… 残り ${left} 文字は省略`.slice(0, 4096));
  }
  return out;
}

function attachmentSummaryBlock(row: LogRow, storeDb?: DatabaseLib.Database | null): string {
  const raw = row.attachments_json || row.attachments || "[]";
  try {
    const arr = JSON.parse(String(raw)) as unknown[];
    if (!Array.isArray(arr) || arr.length === 0) return "(添付なし)";
    const gid = snowflakeFromDb(row.guild_id);
    const mid = snowflakeFromDb(row.message_id);
    const map =
      storeDb && gid && mid ? lookupStoredAttachmentsMap(storeDb, gid, mid) : new Map();
    return arr
      .slice(0, 8)
      .map((a, i) => {
        const o = a && typeof a === "object" ? (a as Record<string, unknown>) : {};
        const fn = String(o.filename || o.name || "-");
        const u = String(o.url || o.proxy_url || "");
        const aid = String(o.id ?? "").trim();
        const stored = aid ? map.get(aid) : undefined;
        const line = `${i + 1}. ${fn}${u ? ` — ${u}` : ""}`;
        const hint = formatStoredHint(stored);
        return hint ? `${line}\n   ${hint}` : line;
      })
      .join("\n");
  } catch {
    return "(添付 JSON の解析に失敗)";
  }
}

function buildOversizeEphemeralEmbed(
  items: { filename: string; storageRelpath: string }[],
): EmbedBuilder {
  const list = items.map((o) => `**${o.filename}**\n\`${o.storageRelpath}\``).join("\n\n");
  const desc =
    "ファイルサイズが大きく送信できなかったため、ダウンロードして閲覧してください。\n" +
    "ダウンロード時はウイルスに注意してください。\n\n" +
    list;
  return new EmbedBuilder()
    .setTitle("大きな添付ファイル")
    .setColor(0xf39c12)
    .setDescription(desc.slice(0, 4096));
}

function buildDetailPayload(
  db: DatabaseLib.Database,
  session: SearchSession,
  logId: number,
  attachmentStore: DatabaseLib.Database | null | undefined,
  imageIndexRequested: number,
): {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
  files: AttachmentBuilder[];
  ephemeralFollowUpEmbed?: EmbedBuilder;
} {
  const row = fetchLogById(db, session, logId);
  if (!row) {
    return {
      embeds: [
        new EmbedBuilder().setTitle("詳細").setColor(0xe74c3c).setDescription("ログが見つかりません。"),
      ],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`${LIST_PREFIX}${session.id}:refresh`)
            .setLabel("一覧へ戻る")
            .setStyle(ButtonStyle.Secondary),
        ),
      ],
      files: [],
    };
  }
  const meta = buildDetailMetaEmbed(row);
  const bodyEmbeds = buildContentEmbeds(row.content);
  const gid = snowflakeFromDb(row.guild_id);
  const mid = snowflakeFromDb(row.message_id);
  const slots = buildDetailImageSlots(attachmentStore ?? undefined, gid, mid);

  const maxImgIdx = Math.max(0, slots.imageSlots.length - 1);
  const clampedIdx =
    slots.imageSlots.length === 0 ? 0 : Math.max(0, Math.min(imageIndexRequested, maxImgIdx));

  let attachDesc = attachmentSummaryBlock(row, attachmentStore ?? null);
  if (slots.oversizeItems.length > 0) {
    const extra = slots.oversizeItems
      .map((o) => `・${o.filename}\n  \`${o.storageRelpath}\``)
      .join("\n");
    attachDesc = `${attachDesc}\n\n【8MB超の動画・ファイル（ローカルパス）】\n${extra}`;
  }
  if (slots.skippedImageCount > 0) {
    attachDesc = `${attachDesc}\n\n※ 画像 ${slots.skippedImageCount} 件は読み込みできませんでした。`;
  }
  const attachEmbed = new EmbedBuilder()
    .setTitle("添付一覧")
    .setColor(0x9b59b6)
    .setDescription(attachDesc.slice(0, 4096))
    .setFooter({
      text:
        slots.imageSlots.length > 1
          ? "画像は「戻る」「次へ」で1枚ずつ表示。動画・ファイルは8MB以下を再送信。超過はパス参照。"
          : "画像は上の Embed に表示。動画・ファイルは8MB以下を再送信。超過はパス参照。",
    });

  const imageEmbeds: EmbedBuilder[] = [];
  if (slots.imageSlots.length > 0) {
    const cur = slots.imageSlots[clampedIdx]!;
    imageEmbeds.push(
      new EmbedBuilder()
        .setTitle(`画像 ${clampedIdx + 1}/${slots.imageSlots.length}: ${cur.displayName}`)
        .setColor(0x9b59b6)
        .setImage(`attachment://${cur.attachName}`),
    );
  }

  const embeds = [meta, ...bodyEmbeds, ...imageEmbeds, attachEmbed].slice(0, 10);

  const files: AttachmentBuilder[] = [];
  if (slots.imageSlots.length > 0) {
    const cur = slots.imageSlots[clampedIdx]!;
    try {
      files.push(new AttachmentBuilder(cur.absPath, { name: cur.attachName }));
    } catch {}
  }
  files.push(...slots.nonImageFiles);

  const componentRows: ActionRowBuilder<ButtonBuilder>[] = [];
  if (slots.imageSlots.length > 1) {
    componentRows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`${DETAIL_PREFIX}${session.id}:${logId}:${clampedIdx}:img:prev`)
          .setLabel("戻る")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(clampedIdx <= 0),
        new ButtonBuilder()
          .setCustomId(`${DETAIL_PREFIX}${session.id}:${logId}:${clampedIdx}:img:next`)
          .setLabel("次へ")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(clampedIdx >= slots.imageSlots.length - 1),
      ),
    );
  }

  const back = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${LIST_PREFIX}${session.id}:refresh`)
      .setLabel("一覧へ戻る")
      .setStyle(ButtonStyle.Secondary),
  );
  const cid = snowflakeFromDb(row.channel_id);
  const msgUrl = buildMessageUrl(gid, cid, mid);
  if (msgUrl) {
    back.addComponents(
      new ButtonBuilder().setLabel("元メッセージを開く").setStyle(ButtonStyle.Link).setURL(msgUrl),
    );
  }
  componentRows.push(back);

  const ephemeralFollowUpEmbed =
    slots.oversizeItems.length > 0 ? buildOversizeEphemeralEmbed(slots.oversizeItems) : undefined;

  return {
    embeds,
    components: componentRows,
    files,
    ephemeralFollowUpEmbed,
  };
}

function formatExportEntry(row: LogRow, index: number, storeDb?: DatabaseLib.Database | null): string {
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
  if (storeDb) {
    const gid = snowflakeFromDb(row.guild_id);
    const mid = snowflakeFromDb(row.message_id);
    if (gid && mid) {
      const map = lookupStoredAttachmentsMap(storeDb, gid, mid);
      if (map.size > 0) {
        lines.push("保存済み添付:");
        for (const s of map.values()) {
          lines.push(
            `  - ${s.filename}: ${s.storage_relpath} (${s.size_bytes != null ? `${s.size_bytes} B` : "?"})`,
          );
        }
      }
    }
  }
  return lines.join("\n");
}

function buildExportText(
  session: SearchSession,
  rows: LogRow[],
  total: number,
  attachmentStore?: DatabaseLib.Database | null,
): string {
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
    .map((r, i) => formatExportEntry(r, i + 1, attachmentStore))
    .join("\n\n----------------------------------------\n\n");
  return `${header.join("\n")}${body}`;
}

function getSession(sessionId: string): SearchSession | null {
  cleanupSearchSessions();
  const s = searchSessions.get(String(sessionId || "").trim());
  if (!s) return null;
  if (Date.now() - s.lastTouchedAt > SESSION_TTL_MS) {
    searchSessions.delete(s.id);
    return null;
  }
  return s;
}

async function requireSession(
  interaction: ButtonInteraction | ModalSubmitInteraction,
  ctx: BotContext,
  sessionId: string,
): Promise<SearchSession | null> {
  const session = getSession(sessionId);
  if (!session) {
    await interaction.reply({
      content: "検索セッションの期限が切れました。もう一度検索を開始してください。",
      flags: MessageFlags.Ephemeral,
    });
    return null;
  }
  if (interaction.user.id !== session.ownerId) {
    await interaction.reply({ content: "この検索UIは作成者のみ操作できます。", flags: MessageFlags.Ephemeral });
    return null;
  }
  if (interaction.guildId !== session.guildId) {
    await interaction.reply({ content: "このサーバーでは利用できない検索セッションです。", flags: MessageFlags.Ephemeral });
    return null;
  }
  if (!canUseLogUi(interaction, ctx)) {
    await interaction.reply({ content: "ログ閲覧の権限がありません。", flags: MessageFlags.Ephemeral });
    return null;
  }
  session.lastTouchedAt = Date.now();
  return session;
}

export async function routeMessageLogButton(interaction: ButtonInteraction, ctx: BotContext): Promise<boolean> {
  cleanupSearchSessions();
  const id = interaction.customId;

  if (id === PANEL_BUTTON_ID) {
    if (!interaction.guildId || interaction.guildId !== ctx.config.GUILD_ID) {
      await interaction.reply({ content: "このサーバーでは利用できません。", flags: MessageFlags.Ephemeral });
      return true;
    }
    if (!canUseLogUi(interaction, ctx)) {
      await interaction.reply({ content: "ログ閲覧の権限がありません。", flags: MessageFlags.Ephemeral });
      return true;
    }
    await interaction.showModal(buildSearchModal(null));
    return true;
  }

  if (id.startsWith(LIST_PREFIX)) {
    const parts = id.split(":");
    if (parts.length < 4) return false;
    const sessionId = parts[2]!;
    const action = parts[3]!;
    const session = await requireSession(interaction, ctx, sessionId);
    if (!session) return true;

    if (action === "modal") {
      await interaction.showModal(buildSearchModal(session));
      return true;
    }
    if (action === "export") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const { total, rows } = fetchLogsForExport(
          ctx.messageLogSqlite,
          session,
          ctx.client.user?.id ?? "",
          MAX_EXPORT_ROWS,
        );
        if (rows.length === 0) {
          await interaction.editReply({ content: "エクスポート対象のログがありません。" });
          return true;
        }
        const content = buildExportText(session, rows, total, ctx.messageAttachmentStoreSqlite);
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const file = new AttachmentBuilder(Buffer.from(content, "utf8"), {
          name: `message_logs_${session.guildId}_${stamp}.txt`,
        });
        const suffix = total > rows.length ? `（${rows.length}/${total}件を出力）` : "";
        await interaction.editReply({ content: `テキスト出力が完了しました。${suffix}`, files: [file] });
      } catch {
        await interaction.editReply({ content: "ログのエクスポートに失敗しました。" }).catch(() => undefined);
      }
      return true;
    }

    if (action === "prev") session.page = Math.max(0, session.page - 1);
    else if (action === "next") session.page += 1;
    else if (action === "toggle_attach") {
      session.attachmentsOnly = !session.attachmentsOnly;
      session.page = 0;
    } else if (action !== "refresh") return true;

    const payload = buildListPayload(ctx.messageLogSqlite, session, ctx.client.user?.id ?? "");
    await interaction.update(payload).catch(async () => {
      await interaction.reply({ content: "検索UIの更新に失敗しました。", flags: MessageFlags.Ephemeral }).catch(() => undefined);
    });
    return true;
  }

  if (id.startsWith(DETAIL_PREFIX)) {
    const parts = id.split(":");
    if (parts.length < 7) return false;
    const sessionId = parts[2]!;
    const logId = Number(parts[3]);
    const idxPart = Number(parts[4]);
    const part5 = parts[5] ?? "";
    const action = parts[6] ?? "";
    const session = await requireSession(interaction, ctx, sessionId);
    if (!session) return true;
    if (!Number.isFinite(logId)) return true;

    let imageIndex = 0;
    if (action === "open") {
      if (part5 !== "img" && part5 !== "0") return false;
      imageIndex = 0;
    } else if (part5 === "img" && action === "prev") {
      if (!Number.isFinite(idxPart)) return false;
      imageIndex = Math.max(0, idxPart - 1);
    } else if (part5 === "img" && action === "next") {
      if (!Number.isFinite(idxPart)) return false;
      imageIndex = idxPart + 1;
    } else {
      return false;
    }

    const payload = buildDetailPayload(
      ctx.messageLogSqlite,
      session,
      logId,
      ctx.messageAttachmentStoreSqlite,
      imageIndex,
    );
    try {
      await interaction.update({
        embeds: payload.embeds,
        components: payload.components,
        files: payload.files,
      });
      if (payload.ephemeralFollowUpEmbed) {
        await interaction.followUp({
          embeds: [payload.ephemeralFollowUpEmbed],
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch {
      await interaction.reply({ content: "詳細の表示に失敗しました。", flags: MessageFlags.Ephemeral }).catch(() => undefined);
    }
    return true;
  }

  return false;
}

export async function routeMessageLogModal(interaction: ModalSubmitInteraction, ctx: BotContext): Promise<boolean> {
  if (!interaction.customId.startsWith(MODAL_PREFIX)) return false;
  cleanupSearchSessions();

  if (!interaction.guildId || interaction.guildId !== ctx.config.GUILD_ID) {
    await interaction.reply({ content: "このサーバーでは利用できません。", flags: MessageFlags.Ephemeral });
    return true;
  }
  if (!canUseLogUi(interaction, ctx)) {
    await interaction.reply({ content: "ログ閲覧の権限がありません。", flags: MessageFlags.Ephemeral });
    return true;
  }

  const parts = interaction.customId.split(":");
  const sessionToken = parts[2] || "new";
  let existing: SearchSession | null = null;
  if (sessionToken !== "new") {
    existing = getSession(sessionToken);
    if (existing && existing.ownerId !== interaction.user.id) {
      await interaction.reply({ content: "この検索セッションは作成者のみ更新できます。", flags: MessageFlags.Ephemeral });
      return true;
    }
    if (existing && existing.guildId !== interaction.guildId) existing = null;
  }

  const parsed = parseSearchModalFields(interaction);
  if (!parsed.ok) {
    await interaction.reply({ content: parsed.error, flags: MessageFlags.Ephemeral });
    return true;
  }

  const now = Date.now();
  const session: SearchSession = existing ?? {
    id: makeSessionId(),
    ownerId: interaction.user.id,
    guildId: interaction.guildId,
    keyword: "",
    userId: null,
    channelId: null,
    fromIso: null,
    toIso: null,
    attachmentsOnly: false,
    page: 0,
    createdAt: now,
    lastTouchedAt: now,
  };
  session.keyword = parsed.filters.keyword;
  session.userId = parsed.filters.userId;
  session.channelId = parsed.filters.channelId;
  session.fromIso = parsed.filters.fromIso;
  session.toIso = parsed.filters.toIso;
  session.page = 0;
  session.lastTouchedAt = now;
  if (!existing) session.attachmentsOnly = false;
  searchSessions.set(session.id, session);

  const payload = buildListPayload(ctx.messageLogSqlite, session, ctx.client.user?.id ?? "");
  await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
  return true;
}
