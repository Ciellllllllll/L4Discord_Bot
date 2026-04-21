import { AttachmentBuilder, type Attachment, type Collection } from "discord.js";

export type AttachmentMeta = {
  id: string | null;
  name: string;
  url: string;
  content_type: string | null;
  size: number | null;
};

const MAX_FORWARD = 8;
const MAX_BYTES = 8 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 45_000;

function trimMax(text: string, n: number): string {
  const s = text.trim();
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}

export function sanitizeFilename(filename: string, fallback = "attachment.bin"): string {
  const safe = filename.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  if (!safe) return fallback;
  return safe.slice(0, 120);
}

export function parseAttachmentMetadata(raw: string | null | undefined): AttachmentMeta[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: AttachmentMeta[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      const url = String(o.url ?? "").trim();
      if (!/^https?:\/\//i.test(url)) continue;
      out.push({
        id: typeof o.id === "string" ? o.id : null,
        name: trimMax(String(o.name || "attachment.bin"), 120),
        url,
        content_type: typeof o.content_type === "string" ? o.content_type : null,
        size: Number.isFinite(Number(o.size)) ? Number(o.size) : null,
      });
    }
    return out;
  } catch {
    return [];
  }
}

export function mergeAttachmentLists(base: AttachmentMeta[], extra: AttachmentMeta[]): AttachmentMeta[] {
  const merged: AttachmentMeta[] = [];
  const seen = new Set<string>();
  for (const item of [...base, ...extra]) {
    const url = item.url.trim();
    if (!/^https?:\/\//i.test(url)) continue;
    const key = `${url}|${item.name.trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

export function serializeAttachmentsFromMessage(message: {
  attachments: Collection<string, Attachment>;
}): AttachmentMeta[] {
  const out: AttachmentMeta[] = [];
  for (const a of message.attachments.values()) {
    out.push({
      id: a.id,
      name: trimMax(a.name ?? "file", 120),
      url: a.url,
      content_type: a.contentType,
      size: Number.isFinite(a.size) ? a.size : null,
    });
  }
  return out;
}

export function serializeUploadedCollection(
  files: ReadonlyMap<string, Attachment> | null | undefined,
): AttachmentMeta[] {
  if (!files || files.size === 0) return [];
  const out: AttachmentMeta[] = [];
  for (const a of files.values()) {
    out.push({
      id: a.id,
      name: trimMax(a.name ?? "file", 120),
      url: a.url,
      content_type: a.contentType,
      size: Number.isFinite(a.size) ? a.size : null,
    });
  }
  return out;
}

export function attachmentMetaToJson(items: AttachmentMeta[]): string {
  return JSON.stringify(items);
}

export async function buildForwardDmFiles(rawJson: string): Promise<{
  files: AttachmentBuilder[];
  failed: string[];
}> {
  const items = parseAttachmentMetadata(rawJson).slice(0, MAX_FORWARD);
  const files: AttachmentBuilder[] = [];
  const failed: string[] = [];
  for (const [idx, item] of items.entries()) {
    try {
      const response = await fetch(item.url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`http_${response.status}`);
      const contentLength = response.headers.get("content-length");
      if (contentLength && Number.isFinite(Number(contentLength)) && Number(contentLength) > MAX_BYTES) {
        throw new Error("file_too_large");
      }
      const arrayBuffer = await response.arrayBuffer();
      const size = arrayBuffer.byteLength;
      if (!Number.isFinite(size) || size <= 0) throw new Error("empty_file");
      if (size > MAX_BYTES) throw new Error("file_too_large");
      const fallbackName = `attachment-${idx + 1}.bin`;
      const name = sanitizeFilename(item.name || fallbackName, fallbackName);
      files.push(new AttachmentBuilder(Buffer.from(arrayBuffer), { name }));
    } catch {
      failed.push(item.url);
    }
  }
  return { files, failed };
}

// モーダル添付など擬似メッセージ用

export function pseudoMessageFromUploads(
  _userId: string,
  uploaded: ReadonlyMap<string, Attachment>,
  content = "",
): { id: string | null; content: string; attachments: AttachmentMeta[] } {
  return {
    id: null,
    content: content.trim(),
    attachments: serializeUploadedCollection(uploaded),
  };
}
