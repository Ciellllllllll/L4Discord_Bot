import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { AttachmentBuilder } from "discord.js";
import type { Message, PartialMessage } from "discord.js";
import type { Pool } from "pg";
import type { PgQueryable } from "../../core/db/postgres.js";
import type pino from "pino";
import { readResponseArrayBufferWithLimit } from "../../core/http/fetchWithLimits.js";

const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
const ATTACHMENT_FETCH_TIMEOUT_MS = 45_000;
// 動画・一般ファイルの「再送信」しきい値（バイト）。画像の Embed 表示は別扱い（最大はアーカイブ上限まで）。

export const BOT_RESEND_MAX_BYTES = 8 * 1024 * 1024;
const MAX_DISCORD_FILES = 10;

export type StoredAttachmentRow = {
  attachment_id: string;
  filename: string;
  content_type: string | null;
  size_bytes: number | null;
  kind: string | null;
  storage_relpath: string;
  sha256_hex: string | null;
};

function normalizeId(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return /^\d+$/.test(s) ? s : null;
}

function inferKind(contentType: string | null | undefined, filename: string): string {
  const mime = String(contentType || "").toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  const ext = extname(String(filename || "")).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif"].includes(ext)) return "image";
  if ([".mp4", ".webm", ".mov", ".m4v", ".avi", ".mkv"].includes(ext)) return "video";
  return "file";
}

function pickExtension(filename: string, contentType: string | null | undefined): string {
  const fromName = extname(String(filename || ""));
  if (fromName && fromName.length <= 10) return fromName;
  const mime = String(contentType || "").toLowerCase();
  if (mime === "image/png") return ".png";
  if (mime === "image/jpeg") return ".jpg";
  if (mime === "image/gif") return ".gif";
  if (mime === "image/webp") return ".webp";
  if (mime === "video/mp4") return ".mp4";
  if (mime === "video/webm") return ".webm";
  return "";
}

// message.db は変更せず、専用 DB + ディスクに添付を複製する（Discord CDN 失効後も参照可能にする）。

export async function archiveMessageAttachmentsFromDiscordPostgres(
  pool: Pool,
  filesRootResolved: string,
  message: Message | PartialMessage,
  log: pino.Logger,
): Promise<void> {
  const guildId = normalizeId(message.guildId ?? message.guild?.id);
  const messageId = normalizeId(message.id);
  if (!guildId || !messageId) return;

  const att = message.attachments;
  if (!att || typeof att.values !== "function") return;

  for (const a of att.values()) {
    const attachmentId = normalizeId(a.id);
    if (!attachmentId) continue;

    const exists = await pool.query(
      `SELECT 1 AS ok FROM message_log_attachment_files WHERE guild_id = $1 AND message_id = $2 AND attachment_id = $3`,
      [guildId, messageId, attachmentId],
    );
    if ((exists.rowCount ?? 0) > 0) continue;

    const url = String(a.url || a.proxyURL || "").trim();
    if (!/^https?:\/\//i.test(url)) continue;

    const filename = String(a.name || "attachment");
    if (Number.isFinite(a.size) && a.size > MAX_DOWNLOAD_BYTES) {
      log.debug({ guildId, messageId, attachmentId, size: a.size }, "attachment archive skipped (too large attachment)");
      continue;
    }
    const kind = inferKind(a.contentType ?? null, filename);
    const ext = pickExtension(filename, a.contentType ?? null);
    const safeFile = `${messageId}_${attachmentId}${ext}`;
    const dir = join(filesRootResolved, guildId);
    await mkdir(dir, { recursive: true });
    const absPath = join(dir, safeFile);

    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "L4DiscordBot/1.0 (message log archive)" },
        signal: AbortSignal.timeout(ATTACHMENT_FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        log.warn({ guildId, messageId, attachmentId, status: res.status }, "attachment archive fetch failed");
        continue;
      }
      const cl = res.headers.get("content-length");
      if (cl && Number.isFinite(Number(cl)) && Number(cl) > MAX_DOWNLOAD_BYTES) {
        log.debug({ guildId, messageId, attachmentId, cl }, "attachment archive skipped (too large header)");
        continue;
      }
      const buf = Buffer.from(await readResponseArrayBufferWithLimit(res, MAX_DOWNLOAD_BYTES));
      await writeFile(absPath, buf);
      const sha256 = createHash("sha256").update(buf).digest("hex");
      const relpath = relative(process.cwd(), absPath).replace(/\\/g, "/") || absPath;
      const now = new Date().toISOString();
      await pool.query(
        `INSERT INTO message_log_attachment_files
          (guild_id, message_id, attachment_id, filename, content_type, size_bytes, kind, storage_relpath, sha256_hex, source_url, fetched_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (guild_id, message_id, attachment_id) DO NOTHING`,
        [guildId, messageId, attachmentId, filename, a.contentType ?? null, buf.length, kind, relpath, sha256, url, now],
      );
    } catch (e) {
      log.warn({ err: e, guildId, messageId, attachmentId }, "attachment archive error");
    }
  }
}

export function scheduleArchiveMessageAttachmentsPostgres(
  pool: Pool | undefined,
  filesRoot: string,
  message: Message | PartialMessage,
  log: pino.Logger,
): void {
  if (!pool) return;
  const root = resolve(process.cwd(), filesRoot);
  void archiveMessageAttachmentsFromDiscordPostgres(pool, root, message, log).catch((e) => {
    log.warn({ err: e }, "scheduleArchiveMessageAttachmentsPostgres failed");
  });
}

export async function prepareMessageAttachmentStorePostgres(pool: PgQueryable): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS message_log_attachment_files (
      guild_id text NOT NULL,
      message_id text NOT NULL,
      attachment_id text NOT NULL,
      filename text NOT NULL,
      content_type text,
      size_bytes bigint,
      kind text,
      storage_relpath text NOT NULL,
      sha256_hex text,
      source_url text,
      fetched_at text NOT NULL,
      PRIMARY KEY (guild_id, message_id, attachment_id)
    );
    CREATE INDEX IF NOT EXISTS idx_ml_att_guild_msg ON message_log_attachment_files(guild_id, message_id);
  `);
}

export async function lookupStoredAttachmentsMapPostgres(
  pool: Pool,
  guildIdStr: string | null,
  messageIdStr: string | null,
): Promise<Map<string, StoredAttachmentRow>> {
  const map = new Map<string, StoredAttachmentRow>();
  if (!guildIdStr || !messageIdStr) return map;
  const result = await pool.query<StoredAttachmentRow>(
    `SELECT attachment_id, filename, content_type, size_bytes, kind, storage_relpath, sha256_hex
     FROM message_log_attachment_files WHERE guild_id = $1 AND message_id = $2`,
    [guildIdStr, messageIdStr],
  );
  for (const row of result.rows) map.set(row.attachment_id, row);
  return map;
}

function resolveStoredAbsPath(storageRelpath: string): string | null {
  const raw = String(storageRelpath || "").trim();
  if (!raw) return null;
  const abs =
    /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith("/") || raw.startsWith("\\")
      ? raw
      : join(process.cwd(), raw);
  if (!existsSync(abs)) return null;
  return abs;
}

function safeAttachmentFilename(original: string, fallback: string): string {
  const s = String(original || "")
    .replace(/[^a-zA-Z0-9_.-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return s || fallback;
}

function fileSizeOnDisk(abs: string, rowSize: number | null): number {
  if (rowSize != null && rowSize > 0) return rowSize;
  try {
    return statSync(abs).size;
  } catch {
    return 0;
  }
}

function kindOfRow(row: StoredAttachmentRow): string {
  if (row.kind) return row.kind;
  return inferKind(row.content_type, row.filename);
}


// 詳細でページ送りする 1 枚分の画像（メタのみ。実体は buildDetailPayload で 1 枚ずつ添付）

export type DetailImageSlot = {
  attachName: string;
  displayName: string;
  absPath: string;
};

export type DetailImageSlotsResult = {
  imageSlots: DetailImageSlot[];
  nonImageFiles: AttachmentBuilder[];
  oversizeItems: { filename: string; storageRelpath: string }[];
    // 読み込み失敗などでスキップした画像数

  skippedImageCount: number;
};

// 詳細表示用: 画像はスロット一覧のみ（1 枚ずつ Embed に出す）。動画・ファイルは 8MB 以下をまとめて添付。
// 画像 1 枚を同じメッセージに載せるため、非画像は最大 9 件まで。

function buildDetailImageSlotsFromRows(rows: StoredAttachmentRow[]): DetailImageSlotsResult {
  const images = rows.filter((r) => kindOfRow(r) === "image");
  const nonImages = rows.filter((r) => kindOfRow(r) !== "image");

  const imageSlots: DetailImageSlot[] = [];
  let skippedImageCount = 0;

  let imgIdx = 0;
  for (const row of images) {
    const abs = resolveStoredAbsPath(row.storage_relpath);
    if (!abs) {
      skippedImageCount += 1;
      continue;
    }
    const size = fileSizeOnDisk(abs, row.size_bytes);
    if (size > MAX_DOWNLOAD_BYTES) {
      skippedImageCount += 1;
      continue;
    }
    const ext = extname(row.filename) || pickExtension(row.filename, row.content_type);
    const base = safeAttachmentFilename(row.filename, `image_${row.attachment_id}`);
    const attachName = `ml_img_${row.attachment_id}_${imgIdx}${ext || ""}`;
    const displayName = base.includes(".") ? base : `${base}${ext || ""}`;
    imageSlots.push({ attachName, displayName, absPath: abs });
    imgIdx += 1;
  }

  const maxNonImage = imageSlots.length > 0 ? 9 : MAX_DISCORD_FILES;
  const nonImageFiles: AttachmentBuilder[] = [];
  const oversizeItems: { filename: string; storageRelpath: string }[] = [];

  for (const row of nonImages) {
    const k = kindOfRow(row);
    const abs = resolveStoredAbsPath(row.storage_relpath);
    if (!abs) continue;
    const size = fileSizeOnDisk(abs, row.size_bytes);
    if (size <= BOT_RESEND_MAX_BYTES) {
      if (nonImageFiles.length >= maxNonImage) {
        oversizeItems.push({ filename: row.filename, storageRelpath: row.storage_relpath });
        continue;
      }
      const ext = extname(row.filename) || pickExtension(row.filename, row.content_type);
      const attachName = `ml_${k}_${row.attachment_id}${ext || ""}`;
      try {
        nonImageFiles.push(new AttachmentBuilder(abs, { name: attachName }));
      } catch {
        oversizeItems.push({ filename: row.filename, storageRelpath: row.storage_relpath });
      }
    } else {
      oversizeItems.push({ filename: row.filename, storageRelpath: row.storage_relpath });
    }
  }

  return { imageSlots, nonImageFiles, oversizeItems, skippedImageCount };
}

export async function buildDetailImageSlotsPostgres(
  pool: Pool | null | undefined,
  guildIdStr: string | null,
  messageIdStr: string | null,
): Promise<DetailImageSlotsResult> {
  if (!pool || !guildIdStr || !messageIdStr) {
    return { imageSlots: [], nonImageFiles: [], oversizeItems: [], skippedImageCount: 0 };
  }
  const map = await lookupStoredAttachmentsMapPostgres(pool, guildIdStr, messageIdStr);
  return buildDetailImageSlotsFromRows([...map.values()].sort((a, b) => a.attachment_id.localeCompare(b.attachment_id)));
}

export function formatStoredHint(stored: StoredAttachmentRow | undefined): string | null {
  if (!stored) return null;
  const sz = stored.size_bytes != null ? `${stored.size_bytes} B` : "?";
  return `保存済み: ${stored.storage_relpath} (${sz})`;
}
