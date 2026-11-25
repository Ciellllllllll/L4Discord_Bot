import { extname } from "node:path";
import type { Attachment } from "discord.js";
import { readResponseArrayBufferWithLimit } from "../../core/http/fetchWithLimits.js";

export type QAttachment = Pick<Attachment, "id" | "name" | "url" | "size" | "contentType">;
export type PreparedQAttachment =
  | { kind: "image"; name: string; imageDataUrl: string }
  | { kind: "text"; name: string; text: string };

export class QAttachmentError extends Error {}

const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const TEXT_MAX_BYTES = 1024 * 1024;
const TEXT_MAX_CHARACTERS = 20_000;
const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".csv", ".json", ".jsonl", ".log", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".c", ".h", ".cpp", ".hpp", ".cs", ".java", ".go", ".rs", ".rb", ".php", ".html",
  ".css", ".xml", ".yaml", ".yml", ".toml", ".ini", ".sql", ".sh", ".ps1",
]);
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const TEXT_TYPES = new Set([
  "", "application/octet-stream", "application/json", "application/javascript", "application/xml",
  "application/yaml", "application/x-yaml", "application/toml", "application/sql", "application/x-sh",
]);

export function qAttachmentKind(attachment: QAttachment): "image" | "text" {
  const mime = (attachment.contentType ?? "").toLowerCase().split(";")[0]!.trim();
  const extension = extname(attachment.name).toLowerCase();
  if (IMAGE_TYPES.has(mime) || ((!mime || mime === "application/octet-stream") && /\.(?:png|jpe?g|gif|webp)$/.test(extension))) {
    return "image";
  }
  if (TEXT_EXTENSIONS.has(extension) && (mime.startsWith("text/") || TEXT_TYPES.has(mime))) return "text";
  throw new QAttachmentError("添付はJPEG・PNG・GIF・WebP画像、またはUTF-8のテキストファイルに対応しています。PDF・Office・動画・音声には対応していません。");
}

function imageMime(bytes: Buffer): string | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return "image/jpeg";
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

export async function prepareQAttachment(attachment: QAttachment): Promise<PreparedQAttachment> {
  const kind = qAttachmentKind(attachment);
  const maxBytes = kind === "image" ? IMAGE_MAX_BYTES : TEXT_MAX_BYTES;
  const sizeError = `添付は${kind === "image" ? "画像8MiB" : "テキスト1MiB"}以内にしてください。`;
  if (!Number.isSafeInteger(attachment.size) || attachment.size <= 0 || attachment.size > maxBytes) {
    throw new QAttachmentError(sizeError);
  }
  let url: URL;
  try {
    url = new URL(attachment.url);
  } catch {
    throw new QAttachmentError("添付ファイルのURLが無効です。添付し直してください。");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
      !["cdn.discordapp.com", "media.discordapp.net"].includes(url.hostname) ||
      !/^\/(?:ephemeral-)?attachments\//.test(url.pathname)) {
    throw new QAttachmentError("Discordにアップロードしたファイルを添付してください。");
  }

  let bytes: Buffer;
  try {
    const response = await fetch(url.href, { signal: AbortSignal.timeout(10_000), redirect: "error" });
    if (!response.ok || Number(response.headers.get("content-length")) > maxBytes) {
      await response.body?.cancel();
      throw new QAttachmentError(response.ok ? sizeError : "添付ファイルを取得できませんでした。添付し直してください。");
    }
    bytes = Buffer.from(await readResponseArrayBufferWithLimit(response, maxBytes));
  } catch (error) {
    if (error instanceof QAttachmentError) throw error;
    throw new QAttachmentError("添付ファイルを取得できませんでした。サイズを確認して添付し直してください。");
  }
  const name = attachment.name.replace(/[\x00-\x1f]/g, " ").slice(0, 256);
  if (kind === "image") {
    const mime = imageMime(bytes);
    if (!mime) throw new QAttachmentError("添付の内容が対応する画像形式ではありません。");
    return { kind, name, imageDataUrl: `data:${mime};base64,${bytes.toString("base64")}` };
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new QAttachmentError("テキストファイルはUTF-8で保存してください。");
  }
  if (!text.trim() || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text) || text.startsWith("%PDF-")) {
    throw new QAttachmentError("添付には空でないテキストファイルを指定してください。バイナリファイルは読み取れません。");
  }
  if (text.length > TEXT_MAX_CHARACTERS) throw new QAttachmentError("テキストファイルは20,000文字以内にしてください。");
  return { kind, name, text };
}
