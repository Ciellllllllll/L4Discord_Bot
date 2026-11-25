import { bigIntToSnowflake, normalizeSnowflake } from "../../core/snowflake.js";

export type SearchFilters = {
  keyword: string;
  userId: string | null;
  channelId: string | null;
  fromIso: string | null;
  toIso: string | null;
};

export type SearchSession = SearchFilters & {
  id: string;
  ownerId: string;
  guildId: string;
  attachmentsOnly: boolean;
  page: number;
  createdAt: number;
  lastTouchedAt: number;
};

export type LogRow = {
  id: number;
  log_type: string | null;
  guild_id: bigint | number | string | null;
  channel_id: bigint | number | string | null;
  user_id: bigint | number | string | null;
  user_name: string | null;
  content: string | null;
  edited_at: string | null;
  deleted_at: string | null;
  time: string | null;
  message_id: bigint | number | string | null;
  author_id: bigint | number | string | null;
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

export function snowflakeFromDb(v: bigint | number | string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  try {
    const snowflake = bigIntToSnowflake(v);
    return snowflake || null;
  } catch {
    return null;
  }
}

export function formatDiscordDate(iso: string | null | undefined): string {
  if (!iso) return String(iso || "-");
  const ms = new Date(iso).getTime();
  const sec = Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
  return sec ? `<t:${sec}:F>` : String(iso || "-");
}

export function parseDateInput(raw: string, endOfDay = false): { iso: string | null; error: string | null } {
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

export function formatDateForInput(iso: string | null | undefined): string {
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

export function extractSnowflakeInput(raw: string): string | null {
  const s = String(raw || "").trim();
  if (!s) return null;
  const mention = s.match(/^<[@#]!?(\d+)>$/);
  if (mention) return mention[1] ?? null;
  const plain = normalizeSnowflake(s);
  if (plain) return plain;
  const fromText = s.match(/(\d{17,20})/);
  return fromText ? (fromText[1] ?? null) : null;
}

export function parseSearchFilterInputs(raw: {
  keyword: string;
  user: string;
  channel: string;
  from: string;
  to: string;
}): { ok: true; filters: SearchFilters } | { ok: false; error: string } {
  const keyword = String(raw.keyword || "").trim().slice(0, 100);
  const userRaw = String(raw.user || "").trim();
  const channelRaw = String(raw.channel || "").trim();
  const fromRaw = String(raw.from || "").trim();
  const toRaw = String(raw.to || "").trim();

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

export function shortenText(text: string, max = 80): string {
  const src = String(text || "").replace(/\s+/g, " ").trim();
  if (!src) return "";
  return src.length <= max ? src : `${src.slice(0, max - 1)}…`;
}

export function splitLongText(text: string, chunk: number): string[] {
  const src = String(text || "");
  if (!src) return [""];
  const out: string[] = [];
  for (let i = 0; i < src.length; i += chunk) out.push(src.slice(i, i + chunk));
  return out;
}

export function buildDiscordMessageUrl(
  guildId: string | null,
  channelId: string | null,
  messageId: string | null,
): string | null {
  const g = normalizeSnowflake(guildId);
  const c = normalizeSnowflake(channelId);
  const m = normalizeSnowflake(messageId);
  if (!g || !c || !m) return null;
  return `https://discord.com/channels/${g}/${c}/${m}`;
}

export function resolveAttachmentCount(row: LogRow): number {
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

export function describeLogType(logType: string | null): string {
  if (logType === "edit") return "編集";
  if (logType === "delete") return "削除";
  if (logType === "normal") return "送信";
  return logType || "-";
}

export function resolvePrimaryTimestamp(row: LogRow): { label: string; iso: string | null } {
  if (row.log_type === "delete" && row.deleted_at) return { label: "削除日時", iso: row.deleted_at };
  if (row.log_type === "edit" && row.edited_at) return { label: "編集日時", iso: row.edited_at };
  return { label: "送信日時", iso: row.created_at || row.time || null };
}

export function resolveSenderLine(row: LogRow): string {
  const authorId = snowflakeFromDb(row.author_id ?? row.user_id);
  const tag = String(row.author_tag || row.user_name || "").trim();
  const display = String(row.author_display_name || "").trim();
  const name = display || tag;
  const hasName = name && name !== "-";
  if (authorId) return `<@${authorId}>`;
  if (hasName) return name;
  return "不明";
}

export function resolveFieldTitleSuffix(row: LogRow): string {
  const authorId = snowflakeFromDb(row.author_id ?? row.user_id);
  const tag = String(row.author_tag || "").trim();
  const display = String(row.author_display_name || "").trim();
  const name = display || tag;
  if (name && name !== "-") return name;
  if (authorId) return `<@${authorId}>`;
  return "不明";
}
