import type { MessageCreateOptions } from "discord.js";
import { readResponseArrayBufferWithLimit } from "../../ai/fetchWithLimits.js";
import { LocalLlmQueue } from "../../ai/localLlmQueue.js";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const DOWNLOAD_TIMEOUT_MS = 20_000;
/** Discord のメッセージ本文の文字数上限 */
const MAX_MESSAGE_CONTENT_LENGTH = 2_000;
/** Discord の1メッセージあたりの添付ファイル数の上限 */
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;
/** 画像1枚あたりの上限。SNS の CDN の画像URLは短時間で失効するため、画像も添付する */
export const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
/**
 * 1投稿あたりのメディア取得（動画・画像・アイコン）全体の締め切り。
 * 構築は共有キューで直列に走るため、CDN が詰まっても1投稿がキューを長時間占有しないようにする
 */
export const MEDIA_TOTAL_TIMEOUT_MS = 30_000;
export const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

/** 同時に構築→返信する件数。メッセージ・サービスをまたいで動画バッファが積み上がらないよう全体で共有する */
const MEDIA_PREVIEW_BUILD_MAX_CONCURRENT = 1;
/** 実行待ちの上限。超えた分は動画をダウンロードせず元URLのみ返信する */
const MEDIA_PREVIEW_BUILD_MAX_QUEUE = 10;

/** 動画を添付するプレビュー（TikTok・Instagram）の構築を1件ずつ行うための、プロセス全体で共有するキュー */
export const mediaPreviewBuildQueue = new LocalLlmQueue({
  maxConcurrent: MEDIA_PREVIEW_BUILD_MAX_CONCURRENT,
  maxQueue: MEDIA_PREVIEW_BUILD_MAX_QUEUE,
});

export function buildOriginalUrlReply(urls: string | readonly string[]): MessageCreateOptions {
  return {
    content: typeof urls === "string" ? urls : urls.join("\n"),
    allowedMentions: { parse: [], repliedUser: false },
  };
}

const retryablePreviews = new WeakSet<object>();

/** 一時的な失敗で元URLに落とした返信を示す。追跡中の展開は定期確認で再構築する。 */
export function markRetryablePreview<T extends object>(payload: T): T {
  retryablePreviews.add(payload);
  return payload;
}

export function isRetryablePreview(payload: object): boolean {
  return retryablePreviews.has(payload);
}

/** 投稿の削除・非公開や、取得結果の形式不一致を示す理由。再試行しても結果は変わらない。 */
const PERMANENT_PREVIEW_FAILURES: ReadonlySet<string> = new Set([
  "post_unavailable", "invalid_data", "missing_tweet", "invalid_tweet", "NOT_FOUND", "PRIVATE_TWEET",
]);

/** 取得失敗の理由が再試行で回復しうるか。投稿の削除・非公開・形式不一致（4xx 等）は再試行しない。 */
export function isTransientPreviewFailure(reason: string): boolean {
  const status = /^http_(\d+)$/.exec(reason)?.[1];
  if (status) return Number(status) >= 500 || status === "408" || status === "429";
  return !PERMANENT_PREVIEW_FAILURES.has(reason);
}

/** URLを改行区切りで、1通あたり Discord の文字数上限に収まるよう分割する。 */
export function chunkUrlsForMessages(urls: readonly string[], maxLength = MAX_MESSAGE_CONTENT_LENGTH): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let length = 0;
  for (const url of urls) {
    // URLは正規化済みで短いが、万一1件で上限を超える場合は送れないため除外する
    if (url.length > maxLength) continue;
    const added = current.length === 0 ? url.length : length + 1 + url.length;
    if (added > maxLength) {
      chunks.push(current);
      current = [url];
      length = url.length;
      continue;
    }
    current.push(url);
    length = added;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export async function cancelBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

export type MediaKind = "video" | "image" | "audio";
export type DownloadedMedia = { buffer: Buffer; contentType: string; kind: MediaKind };

/**
 * メディアを種類ごとの上限サイズ以内でダウンロードする。`limits` に含めた種類だけを受け付け、
 * 種類違い・サイズ超過・失敗時は undefined。content-type が無い応答は、受け付ける種類が1つのときだけその種類とみなす。
 */
export async function downloadMedia(
  url: string,
  limits: Partial<Record<MediaKind, number>>,
  deadline: AbortSignal,
  fetcher: FetchLike = fetch,
): Promise<DownloadedMedia | undefined> {
  const kinds = (Object.keys(limits) as MediaKind[]).filter((kind) => (limits[kind] ?? 0) > 0);
  if (kinds.length === 0 || deadline.aborted) return undefined;
  try {
    const response = await fetcher(url, {
      signal: AbortSignal.any([AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), deadline]),
      headers: {
        Accept: [
          ...(kinds.includes("video") ? ["video/mp4", "video/*;q=0.9"] : []),
          ...(kinds.includes("image") ? ["image/*;q=0.9"] : []),
          ...(kinds.includes("audio") ? ["audio/mp4", "audio/*;q=0.9"] : []),
          "*/*;q=0.1",
        ].join(","),
      },
    });
    if (!response.ok) {
      await cancelBody(response);
      return undefined;
    }
    const contentType = response.headers.get("content-type")?.toLowerCase().split(";")[0]?.trim() ?? "";
    const kind = contentType
      ? kinds.find((candidate) => contentType.startsWith(`${candidate}/`))
      : kinds.length === 1 ? kinds[0] : undefined;
    const maxBytes = kind ? limits[kind] ?? 0 : 0;
    if (!kind || maxBytes <= 0) {
      await cancelBody(response);
      return undefined;
    }
    const contentLength = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      await cancelBody(response);
      return undefined;
    }
    const buffer = Buffer.from(await readResponseArrayBufferWithLimit(response, maxBytes));
    return buffer.byteLength > 0 ? { buffer, contentType, kind } : undefined;
  } catch {
    return undefined;
  }
}
