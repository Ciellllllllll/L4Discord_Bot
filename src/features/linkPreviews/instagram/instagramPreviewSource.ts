import { load } from "cheerio";
import { URL } from "node:url";
import type { PreviewDocument, PreviewTextBlock } from "../shared/previewDocument.js";
import { cancelBody, type FetchLike } from "../shared/previewMediaDownload.js";

export type { FetchLike };

export const INSTAGRAM_DOMAINS: ReadonlySet<string> = new Set(["instagram.com", "m.instagram.com", "instagr.am"]);
const REQUEST_TIMEOUT_MS = 10_000;
/**
 * Instagram の投稿ページは 700KB 近くあるが、OG メタは先頭の head（150KB 程度）にある。
 * head の終わりまでで読み込みを打ち切り、それでも見つからない巨大な応答はこの上限で打ち切る
 */
const MAX_HEAD_BYTES = 512 * 1024;
/**
 * Instagram はクローラー向けにだけ OG メタ（キャプション全文・投稿者・日付・いいね数）を返すため、
 * リンクプレビュー用クローラーとして取得する
 */
const CRAWLER_USER_AGENT = "facebookexternalhit/1.1";
/**
 * 動画とカルーセルの各項目は Instagram 本体の OG に含まれないため、InstaFix 互換のミラーから取得する。
 * ミラーは `/images/<shortcode>/<n>` で n 番目の項目（動画・画像とも）の CDN URL へリダイレクトする
 */
const MIRROR_BASE_URL = "https://uuinstagram.com";
/** ミラーのリダイレクト先として受け付ける Instagram の CDN ホスト */
const CDN_HOST_SUFFIXES = [".cdninstagram.com", ".fbcdn.net"] as const;
/** カルーセルの項目数の上限（Instagram の仕様上の上限でもある） */
export const MAX_INSTAGRAM_MEDIA_ITEMS = 10;
const TRIM_TAIL_CHARS = ".,!?;:)]}>,、。」』）";
const SHORTCODE_PATTERN = /^[A-Za-z0-9_-]{5,64}$/;
const MONTHS: Readonly<Record<string, number>> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

export type InstagramPostKind = "p" | "reel" | "tv";

export type InstagramReplyTarget = {
  /** 正規化済みの投稿URL（クエリなし） */
  url: string;
  shortcode: string;
  kind: InstagramPostKind;
};

export type InstagramPost = {
  shortcode: string;
  url: string;
  username: string;
  displayName?: string;
  caption: string;
  /** "2019/01/04" 形式 */
  date?: string;
  /** Instagram の表記のまま（"60M" や "2,160" など） */
  likes?: string;
  comments?: string;
  /** 1枚目（動画ならサムネイル）の画像 */
  imageUrl?: string;
};

export type InstagramPreviewResult =
  | { status: "ok"; post: InstagramPost }
  | { status: "fallback"; reason: string };

function ensureScheme(urlText: string): string {
  return /^https?:\/\//i.test(urlText) ? urlText : `https://${urlText}`;
}

function stripUrlTail(urlText: string): string {
  let out = urlText.trim();
  while (out && TRIM_TAIL_CHARS.includes(out[out.length - 1]!)) out = out.slice(0, -1);
  return out;
}

function hostWithoutWww(host: string): string {
  const normalized = host.trim().toLowerCase();
  return normalized.startsWith("www.") ? normalized.slice(4) : normalized;
}

function postKind(segment: string | undefined): InstagramPostKind | null {
  if (segment === "p") return "p";
  if (segment === "reel" || segment === "reels") return "reel";
  if (segment === "tv") return "tv";
  return null;
}

/** 投稿（写真・カルーセル・リール・IGTV）のURLを解析する。プロフィールやストーリー等は null。 */
export function parseInstagramUrl(urlText: string): InstagramReplyTarget | null {
  try {
    const parsed = new URL(ensureScheme(stripUrlTail(String(urlText || ""))));
    if (!INSTAGRAM_DOMAINS.has(hostWithoutWww(parsed.host))) return null;
    const parts = parsed.pathname.split("/").filter(Boolean);
    // /p/<code>/ と /<user>/p/<code>/ の両方を受け付ける
    const kindIndex = postKind(parts[0]) ? 0 : postKind(parts[1]) ? 1 : -1;
    if (kindIndex < 0) return null;
    const kind = postKind(parts[kindIndex])!;
    const shortcode = parts[kindIndex + 1];
    if (!shortcode || !SHORTCODE_PATTERN.test(shortcode)) return null;
    return { url: `https://www.instagram.com/${kind}/${shortcode}/`, shortcode, kind };
  } catch {
    return null;
  }
}

export function collectInstagramReplyTargets(links: readonly string[]): InstagramReplyTarget[] {
  const targets: InstagramReplyTarget[] = [];
  const seen = new Set<string>();
  for (const link of links) {
    const target = parseInstagramUrl(link);
    if (!target || seen.has(target.shortcode)) continue;
    seen.add(target.shortcode);
    targets.push(target);
  }
  return targets;
}

function safeHttpsUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** `…: "キャプション"` の形からキャプションを取り出す（末尾の `.` などは除く）。 */
function quotedCaption(text: string, marker: string): string | undefined {
  const start = text.indexOf(marker);
  if (start < 0) return undefined;
  const body = text.slice(start + marker.length);
  const end = body.lastIndexOf("\"");
  return end >= 0 ? body.slice(0, end).trim() : undefined;
}

function parseEnglishDate(text: string): string | undefined {
  const match = text.match(/\b([A-Z][a-z]+) (\d{1,2}), (\d{4})\b/);
  const month = match ? MONTHS[match[1]!.toLowerCase()] : undefined;
  if (!match || !month) return undefined;
  return `${match[3]}/${String(month).padStart(2, "0")}/${match[2]!.padStart(2, "0")}`;
}

export type InstagramOgMeta = Partial<Record<"og:url" | "og:title" | "og:description" | "og:image", string>>;

/**
 * クローラー向けの OG メタから投稿情報を組み立てる。
 * 例: og:title = `Name on Instagram: "caption"`、og:description = `60M likes, 4M comments - user on January 4, 2019: "caption".`
 */
export function normalizeInstagramOgMeta(meta: InstagramOgMeta, target: InstagramReplyTarget): InstagramPreviewResult {
  const ogUrl = meta["og:url"];
  const parsedUrl = ogUrl ? parseInstagramUrl(ogUrl) : null;
  // ログイン画面・非公開・削除済みの投稿では投稿の og:url が返らない
  if (!parsedUrl || parsedUrl.shortcode !== target.shortcode) return { status: "fallback", reason: "post_unavailable" };
  const urlParts = new URL(ogUrl!).pathname.split("/").filter(Boolean);
  const title = meta["og:title"] ?? "";
  const description = meta["og:description"] ?? "";
  // いいね・コメント数は非表示設定の投稿では省略される
  const summaryMatch = description.match(/^((?:[\d.,]+[KMB]? (?:likes?|comments?)(?:, )?)+) - /);
  const summary = summaryMatch?.[1] ?? "";
  const afterSummary = summaryMatch ? description.slice(summaryMatch[0].length) : description;
  const username = urlParts.length >= 3 ? urlParts[0]! : afterSummary.match(/^([A-Za-z0-9._]+) on /)?.[1];
  if (!username) return { status: "fallback", reason: "invalid_data" };

  const titleMarker = title.indexOf(" on Instagram");
  const displayName = titleMarker > 0 ? title.slice(0, titleMarker).trim() : undefined;
  // og:title と og:description のどちらかが省略されている場合に備え、長い方のキャプションを使う
  const captions = [quotedCaption(title, " on Instagram: \""), quotedCaption(afterSummary, ": \"")]
    .filter((caption): caption is string => Boolean(caption));
  const caption = captions.sort((a, b) => b.length - a.length)[0] ?? "";
  const likes = summary.match(/(?:^|, )([\d.,]+[KMB]?) likes?\b/)?.[1];
  const comments = summary.match(/(?:^|, )([\d.,]+[KMB]?) comments?\b/)?.[1];
  const date = parseEnglishDate(afterSummary.split(": \"")[0] ?? "");
  const imageUrl = safeHttpsUrl(meta["og:image"]);
  return {
    status: "ok",
    post: {
      shortcode: target.shortcode,
      url: target.url,
      username,
      ...(displayName && displayName !== username ? { displayName } : {}),
      caption,
      ...(date ? { date } : {}),
      ...(likes ? { likes } : {}),
      ...(comments ? { comments } : {}),
      ...(imageUrl ? { imageUrl } : {}),
    },
  };
}

/** head の終わり（`</head>`）が来るか上限に達するまで読む。上限までに head が終わらなければ例外。 */
async function readHead(response: Response): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    if (text.length > MAX_HEAD_BYTES) throw new Error("instagram head too large");
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      text += decoder.decode(value, { stream: true });
      const headEnd = text.indexOf("</head>");
      if (headEnd >= 0) return text.slice(0, headEnd);
      if (total > MAX_HEAD_BYTES) throw new Error("instagram head too large");
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function extractInstagramOgMeta(html: string): InstagramOgMeta {
  const $ = load(html);
  const meta: InstagramOgMeta = {};
  for (const key of ["og:url", "og:title", "og:description", "og:image"] as const) {
    const value = $(`meta[property="${key}"]`).attr("content") ?? $(`meta[name="${key}"]`).attr("content");
    if (value) meta[key] = value;
  }
  return meta;
}

export async function fetchInstagramPreview(
  target: InstagramReplyTarget,
  fetcher: FetchLike = fetch,
): Promise<InstagramPreviewResult> {
  try {
    const response = await fetcher(target.url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        "User-Agent": CRAWLER_USER_AGENT,
        Accept: "text/html",
        // 日付やいいね数の表記を英語に固定して解析する
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    if (!response.ok) {
      await cancelBody(response);
      return { status: "fallback", reason: `http_${response.status}` };
    }
    return normalizeInstagramOgMeta(extractInstagramOgMeta(await readHead(response)), target);
  } catch (err) {
    return { status: "fallback", reason: err instanceof Error ? (err.name === "TimeoutError" ? "AbortError" : err.name) : "fetch_error" };
  }
}

export function instagramMirrorMediaUrl(shortcode: string, index: number): string {
  return `${MIRROR_BASE_URL}/images/${encodeURIComponent(shortcode)}/${index}`;
}

function isInstagramCdnUrl(value: string | undefined): value is string {
  const url = safeHttpsUrl(value);
  if (!url) return false;
  const host = new URL(url).hostname.toLowerCase();
  return CDN_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * ミラーから n 番目の項目の CDN URL を得る。リダイレクトは自動で追わず、
 * 行き先が Instagram の CDN のときだけ採用する（ミラーが広告サイト等へ飛ばしても従わない）。
 * 項目が無い・ミラーが落ちている場合は undefined。
 */
export async function resolveInstagramMirrorMedia(
  shortcode: string,
  index: number,
  deadline: AbortSignal,
  fetcher: FetchLike = fetch,
): Promise<string | undefined> {
  if (deadline.aborted) return undefined;
  try {
    const response = await fetcher(instagramMirrorMediaUrl(shortcode, index), {
      redirect: "manual",
      signal: AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), deadline]),
      // ミラーはクローラー向けにリダイレクトを返す
      headers: { "User-Agent": "Discordbot/2.0" },
    });
    await cancelBody(response);
    if (response.status < 300 || response.status >= 400) return undefined;
    const location = response.headers.get("location") ?? undefined;
    return isInstagramCdnUrl(location) ? location : undefined;
  } catch {
    return undefined;
  }
}

/** 添付ファイル（attachment://）に差し替えるメディアURL。未指定なら本体の OG 画像を使う */
export type InstagramDocumentMedia = {
  mediaUrls?: readonly string[];
};

export function instagramPreviewToDocument(post: InstagramPost, media: InstagramDocumentMedia = {}): PreviewDocument {
  const authorName = post.displayName ? `${post.displayName} (@${post.username})` : `@${post.username}`;
  const body: PreviewTextBlock = {
    type: "text",
    id: "body",
    lines: [
      { parts: [{ text: authorName, strong: true }] },
      ...(post.caption ? [{ parts: [] }, { parts: [{ text: post.caption.slice(0, 3_000), translationKey: "main" }] }] : []),
    ],
  };
  const mediaUrls = media.mediaUrls ?? (post.imageUrl ? [post.imageUrl] : []);
  const stats = [
    post.likes ? `❤️ ${post.likes}` : null,
    post.comments ? `💬 ${post.comments}` : null,
  ].filter((part): part is string => Boolean(part));
  const meta = [post.date ?? null, stats.length ? stats.join(" / ") : null].filter(Boolean).join(" / ");
  return {
    version: 1,
    source: "instagram",
    url: post.url,
    openLabel: "Instagramで開く",
    blocks: [
      body,
      ...(mediaUrls.length > 0
        ? [{ type: "media" as const, id: "main-media", items: mediaUrls.map((url) => ({ url, description: "Instagram media" })) }]
        : []),
      ...(meta ? [{ type: "text" as const, id: "meta", lines: [{ prefix: "-# ", parts: [{ text: meta }] }] }] : []),
    ],
  };
}
