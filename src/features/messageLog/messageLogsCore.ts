import { extname } from "node:path";
import type DatabaseLib from "better-sqlite3";
import type { Message, PartialMessage } from "discord.js";
import { snowflakeToBigInt } from "../../core/snowflake.js";
import { ensureMessageLogsSchema } from "./messageLogsSchema.js";

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".avif",
  ".bmp",
  ".heic",
  ".heif",
]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".mov", ".m4v", ".avi", ".mkv"]);
const TEXT_EXTENSIONS = new Set([".txt", ".log", ".json", ".md", ".csv", ".yml", ".yaml", ".ini", ".toml", ".xml"]);

export type MessageLogIngestOptions = {
  targetGuildId: string;
  excludedChannelIds: string[];
  botUserId: string;
};

function utcNowIso(): string {
  return new Date().toISOString();
}

function normalizeSnowflake(value: unknown): string | null {
  const s = String(value ?? "").trim();
  return /^\d+$/.test(s) ? s : null;
}

function snowflakeToBigIntOrNull(id: string | null | undefined): bigint | null {
  if (!id) return null;
  try {
    return snowflakeToBigInt(id);
  } catch {
    return null;
  }
}

function shorten(text: string, max = 80): string {
  const src = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!src) return "";
  return src.length <= max ? src : `${src.slice(0, max - 1)}…`;
}

function getFileExtension(filename: string): string {
  return extname(String(filename || "")).toLowerCase() || "";
}

function inferAttachmentKind(contentType: string | null | undefined, filename: string): string {
  const mime = String(contentType || "").toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  const ext = getFileExtension(filename);
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (TEXT_EXTENSIONS.has(ext) || mime.startsWith("text/") || mime.includes("json")) return "text";
  return "file";
}

function hasUsableUrl(value: unknown): boolean {
  const s = String(value || "").trim();
  return /^https?:\/\//i.test(s);
}

function serializeEmbeds(message: Message | PartialMessage): unknown[] {
  if (!Array.isArray(message.embeds) || message.embeds.length === 0) return [];
  return message.embeds.map((embed) => {
    const raw = embed.toJSON();
    return {
      type: raw.type != null ? String(raw.type) : null,
      title: shorten(raw.title ?? "", 200) || null,
      description: shorten(raw.description ?? "", 280) || null,
      url: raw.url ?? null,
      author_name: raw.author?.name ?? null,
      provider_name: raw.provider?.name ?? null,
      field_count: Array.isArray(raw.fields) ? raw.fields.length : 0,
    };
  });
}

function serializeReplyReference(message: Message | PartialMessage): Record<string, unknown> | null {
  const ref = message.reference;
  if (!ref) return null;
  return {
    message_id: normalizeSnowflake(ref.messageId) || null,
    channel_id: normalizeSnowflake(ref.channelId) || null,
    guild_id: normalizeSnowflake(ref.guildId ?? message.guildId) || null,
    type: ref.type ?? null,
    replied_user_id: normalizeSnowflake(message.mentions?.repliedUser?.id) || null,
  };
}

function serializeAttachments(message: Message | PartialMessage): unknown[] {
  const att = message.attachments;
  if (!att || typeof att.values !== "function") return [];
  const out: unknown[] = [];
  for (const a of att.values()) {
    const filename = String(a.name || "-");
    const contentType = a.contentType ?? null;
    out.push({
      id: normalizeSnowflake(a.id) || null,
      filename,
      url: hasUsableUrl(a.url) ? a.url : null,
      proxy_url: hasUsableUrl(a.proxyURL) ? a.proxyURL : null,
      content_type: contentType,
      size: Number.isFinite(a.size) ? a.size : null,
      width: Number.isFinite(a.width) ? a.width : null,
      height: Number.isFinite(a.height) ? a.height : null,
      duration_secs: Number.isFinite(a.duration) ? a.duration : null,
      is_spoiler: Boolean(a.spoiler || filename.startsWith("SPOILER_")),
      kind: inferAttachmentKind(contentType, filename),
    });
  }
  return out;
}

function isBotAuthoredMessage(message: Message | PartialMessage, botUserId: string): boolean {
  if (!message) return false;
  if (message.author?.bot || message.system || message.webhookId) return true;
  const authorId = normalizeSnowflake(message.author?.id ?? message.member?.id);
  if (!authorId) return false;
  const selfId = normalizeSnowflake(botUserId);
  if (selfId && authorId === selfId) return true;
  return false;
}

function shouldSkipMessage(message: Message | PartialMessage, opt: MessageLogIngestOptions): boolean {
  if (!message.guild) return true;
  if (message.partial && !message.author) return true;
  if (isBotAuthoredMessage(message, opt.botUserId)) return true;
  const channelId = normalizeSnowflake(message.channelId ?? message.channel?.id);
  if (channelId && opt.excludedChannelIds.includes(channelId)) return true;
  if (message.guildId !== opt.targetGuildId) return true;
  return false;
}

export async function hydrateMessageIfPartial(message: Message | PartialMessage): Promise<Message | PartialMessage> {
  if (!message.partial) return message;
  const fetched = await message.fetch().catch(() => null);
  return fetched ?? message;
}

type LogType = "normal" | "edit" | "delete";

function buildLogRecord(message: Message | PartialMessage, logType: LogType, now: string) {
  const createdAt =
    message.createdAt instanceof Date ? message.createdAt.toISOString() : now;
  const editedAt = message.editedAt instanceof Date ? message.editedAt.toISOString() : null;
  const attachments = serializeAttachments(message);
  const attachmentsJson = JSON.stringify(attachments);
  const embeds = serializeEmbeds(message);
  const replyRef = serializeReplyReference(message);
  const guildId = normalizeSnowflake(message.guild?.id ?? message.guildId) || null;
  const channelId = normalizeSnowflake(message.channelId ?? message.channel?.id) || null;
  const authorId = normalizeSnowflake(message.author?.id ?? message.member?.id) || null;
  const authorTag = String(message.author?.tag || message.author?.username || "-");
  const authorDisplayName = String(
    message.member?.displayName || message.author?.globalName || message.author?.username || authorTag,
  );

  return {
    log_type: logType,
    guild_id: snowflakeToBigIntOrNull(guildId),
    channel_id: snowflakeToBigIntOrNull(channelId),
    user_id: snowflakeToBigIntOrNull(authorId),
    user_name: authorTag,
    content: String(message.content ?? ""),
    attachments: attachmentsJson,
    attachments_json: attachmentsJson,
    edited_at: logType === "edit" ? editedAt || now : editedAt,
    deleted_at: logType === "delete" ? now : null,
    time: now,
    message_id: snowflakeToBigIntOrNull(normalizeSnowflake(message.id)),
    author_id: snowflakeToBigIntOrNull(authorId),
    author_tag: authorTag,
    author_display_name: authorDisplayName,
    created_at: createdAt,
    message_type: message.type === undefined || message.type === null ? null : String(message.type),
    embeds_json: JSON.stringify(embeds),
    reply_ref_json: replyRef ? JSON.stringify(replyRef) : null,
    attachment_count: attachments.length,
  };
}

const INSERT_SQL = `INSERT INTO message_logs
  (log_type, guild_id, channel_id, user_id, user_name, content, attachments, attachments_json, edited_at, deleted_at, time,
   message_id, author_id, author_tag, author_display_name, created_at, message_type, embeds_json, reply_ref_json, attachment_count)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function insertLog(db: DatabaseLib.Database, r: ReturnType<typeof buildLogRecord>): void {
  db.prepare(INSERT_SQL).run(
    r.log_type,
    r.guild_id,
    r.channel_id,
    r.user_id,
    r.user_name,
    r.content,
    r.attachments,
    r.attachments_json,
    r.edited_at,
    r.deleted_at,
    r.time,
    r.message_id,
    r.author_id,
    r.author_tag,
    r.author_display_name,
    r.created_at,
    r.message_type,
    r.embeds_json,
    r.reply_ref_json,
    r.attachment_count,
  );
}

// message.db を開いた直後に呼ぶ（スキーマ・FTS・トリガー）

export function prepareMessageLogsDatabase(db: DatabaseLib.Database): void {
  ensureMessageLogsSchema(db);
}

export function ingestMessageCreate(
  db: DatabaseLib.Database,
  message: Message,
  opt: MessageLogIngestOptions,
): void {
  if (shouldSkipMessage(message, opt)) return;
  const now = utcNowIso();
  insertLog(db, buildLogRecord(message, "normal", now));
}

export function ingestMessageUpdate(
  db: DatabaseLib.Database,
  message: Message,
  opt: MessageLogIngestOptions,
): void {
  if (shouldSkipMessage(message, opt)) return;
  const now = utcNowIso();
  insertLog(db, buildLogRecord(message, "edit", now));
}

export function ingestMessageDelete(
  db: DatabaseLib.Database,
  message: Message | PartialMessage,
  opt: MessageLogIngestOptions,
): void {
  if (shouldSkipMessage(message, opt)) return;
  const now = utcNowIso();
  insertLog(db, buildLogRecord(message, "delete", now));
}

export { ensureMessageLogsSchema };
