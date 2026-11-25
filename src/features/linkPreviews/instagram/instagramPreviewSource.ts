import { load } from "cheerio";
import { URL } from "node:url";
import { readResponseArrayBufferWithLimit } from "../../../core/http/fetchWithLimits.js";
import type { PreviewDocument, PreviewTextBlock } from "../shared/previewDocument.js";
import { cancelBody, type FetchLike } from "../shared/previewMediaDownload.js";
import { ensureScheme, hostWithoutWww, safeHttpsUrl, stripUrlTail } from "../shared/urlUtils.js";

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
/** 投稿データ（動画・カルーセルの各項目）はブラウザ向けのページにだけ埋め込まれる */
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
/** ブラウザ向けのページは 1MB 近くあり、投稿データは本文の後半にあるため、全体を上限付きで読む */
const MAX_PAGE_BYTES = 4 * 1024 * 1024;
/**
 * 動画とカルーセルの各項目は Instagram 本体の OG に含まれないため、InstaFix 互換のミラーから取得する。
 * ミラーは `/images/<shortcode>/<n>` で n 番目の項目（動画・画像とも）の CDN URL へリダイレクトする
 */
const MIRROR_BASE_URL = "https://uuinstagram.com";
/** ミラーのリダイレクト先として受け付ける Instagram の CDN ホスト */
const CDN_HOST_SUFFIXES = [".cdninstagram.com", ".fbcdn.net"] as const;
/** カルーセルの項目数の上限（Instagram の仕様上の上限でもある） */
export const MAX_INSTAGRAM_MEDIA_ITEMS = 10;
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
  /** `/<user>/p/<code>/` の形のURLに含まれていた投稿者 */
  username?: string;
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
    const username = kindIndex === 1 ? parts[0] : undefined;
    return {
      url: `https://www.instagram.com/${kind}/${shortcode}/`,
      shortcode,
      kind,
      ...(username && /^[A-Za-z0-9._]+$/.test(username) ? { username } : {}),
    };
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
  const title = meta["og:title"] ?? "";
  const description = meta["og:description"] ?? "";
  // いいね・コメント数は非表示設定の投稿では省略される
  const summaryMatch = description.match(/^((?:[\d.,]+[KMB]? (?:likes?|comments?)(?:, )?)+) - /);
  const summary = summaryMatch?.[1] ?? "";
  const afterSummary = summaryMatch ? description.slice(summaryMatch[0].length) : description;
  const username = parsedUrl.username ?? afterSummary.match(/^([A-Za-z0-9._]+) on /)?.[1];
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
      // チャンクの境目で `</head>` が分かれても見つかるよう、前回の末尾から探す
      const searchFrom = Math.max(0, text.length - "</head>".length);
      text += decoder.decode(value, { stream: true });
      const headEnd = text.indexOf("</head>", searchFrom);
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** `[{ url }, ...]` の形の候補から、Instagram の CDN を指す URL を順番どおり・重複なしで取り出す。 */
function cdnCandidateUrls(value: unknown): string[] {
  const urls = (Array.isArray(value) ? value : [])
    .map((candidate) => asRecord(candidate)?.url)
    .filter((url): url is string => typeof url === "string" && isInstagramCdnUrl(url));
  return [...new Set(urls)];
}

/** DASH の1トラック（映像だけ・音声だけのファイル） */
export type InstagramDashTrack = {
  url: string;
  bandwidth: number;
  /** マニフェストに記載されたファイルサイズ（あれば） */
  bytes?: number;
};

export type InstagramPageMediaItem = {
  /** 候補の URL。動画なら各画質（先頭が既定の画質）、画像なら各サイズ（先頭が最大）。前の候補が取れなければ次を試す */
  urls: string[];
  /** 動画の画質違いのトラック。上限を超える動画を低画質で送るときに使う */
  dash?: {
    /** ビットレートの高い順 */
    videos: InstagramDashTrack[];
    /** 高音質の順。音声の無い動画では空 */
    audios: InstagramDashTrack[];
  };
};

function positiveNumber(value: string | undefined): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

/** DASH マニフェスト（XML）から、映像トラックと音声トラックをそれぞれビットレートの高い順に取り出す。 */
export function parseInstagramDashManifest(manifest: string): InstagramPageMediaItem["dash"] {
  const $ = load(manifest, { xml: true });
  const videos: InstagramDashTrack[] = [];
  const audios: InstagramDashTrack[] = [];
  $("Representation").each((_, element) => {
    const representation = $(element);
    const adaptationSet = representation.parent();
    const mimeType = representation.attr("mimeType") ?? adaptationSet.attr("mimeType") ?? "";
    const contentType = adaptationSet.attr("contentType") ?? mimeType.split("/")[0];
    const url = representation.children("BaseURL").first().text().trim();
    if (!isInstagramCdnUrl(url)) return;
    const bytes = positiveNumber(representation.attr("FBContentLength"));
    const track: InstagramDashTrack = {
      url,
      bandwidth: positiveNumber(representation.attr("bandwidth")) ?? 0,
      ...(bytes ? { bytes } : {}),
    };
    if (contentType === "video") videos.push(track);
    else if (contentType === "audio") audios.push(track);
  });
  if (videos.length === 0) return undefined;
  videos.sort((a, b) => b.bandwidth - a.bandwidth);
  audios.sort((a, b) => b.bandwidth - a.bandwidth);
  return { videos, audios };
}

/**
 * 本体ページの投稿データの1項目から、候補の CDN URL と（動画なら）画質違いのトラックを取り出す。
 * 使える候補が無ければ undefined。
 */
function pageMediaItem(item: Record<string, unknown>): InstagramPageMediaItem | undefined {
  if (Array.isArray(item.video_versions)) {
    const urls = cdnCandidateUrls(item.video_versions);
    if (urls.length === 0) return undefined;
    const dash = typeof item.video_dash_manifest === "string" ? parseInstagramDashManifest(item.video_dash_manifest) : undefined;
    return { urls, ...(dash ? { dash } : {}) };
  }
  const urls = cdnCandidateUrls(asRecord(item.image_versions2)?.candidates);
  return urls.length > 0 ? { urls } : undefined;
}

function findPageMedia(value: unknown, shortcode: string): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = asRecord(value);
  if (record?.code === shortcode && ("video_versions" in record || "image_versions2" in record)) return record;
  for (const child of Object.values(value)) {
    const found = findPageMedia(child, shortcode);
    if (found) return found;
  }
  return undefined;
}

/**
 * ブラウザ向けの本体ページに埋め込まれた投稿データ（JSON）から、各項目（カルーセルなら全項目）の候補の CDN URL を取り出す。
 * 項目の位置は保ち、URL が無い・Instagram の CDN 以外を指す項目は undefined にする（呼び出し側がその項目だけ補う）。
 * 投稿データが見つからない、または使える項目が1つもなければ undefined。
 */
export function extractInstagramPageMedia(html: string, shortcode: string): Array<InstagramPageMediaItem | undefined> | undefined {
  for (const match of html.matchAll(/<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/g)) {
    const json = match[1]!;
    // 対象の投稿を含まないスクリプトは解析しない
    if (!json.includes(`"${shortcode}"`)) continue;
    let media: Record<string, unknown> | undefined;
    try {
      media = findPageMedia(JSON.parse(json), shortcode);
    } catch {
      continue;
    }
    if (!media) continue;
    const items = Array.isArray(media.carousel_media) ? media.carousel_media : [media];
    const urls = items
      .slice(0, MAX_INSTAGRAM_MEDIA_ITEMS)
      .map((item) => {
        const record = asRecord(item);
        return record ? pageMediaItem(record) : undefined;
      });
    return urls.some(Boolean) ? urls : undefined;
  }
  return undefined;
}

/**
 * 本体ページをブラウザとして取得し、埋め込みの投稿データから各項目の候補の CDN URL を得る。
 * クローラー向けの OG には動画が無く、ミラーも一部のリールで動画の代わりにカバー画像を返すため、こちらを優先する。
 * 取得・解析できなければ undefined（呼び出し側はミラーにフォールバックする）。
 */
export async function fetchInstagramPageMedia(
  post: Pick<InstagramPost, "url" | "shortcode">,
  deadline: AbortSignal,
  fetcher: FetchLike = fetch,
): Promise<Array<InstagramPageMediaItem | undefined> | undefined> {
  if (deadline.aborted) return undefined;
  try {
    const response = await fetcher(post.url, {
      signal: AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), deadline]),
      headers: {
        "User-Agent": BROWSER_USER_AGENT,
        Accept: "text/html",
        "Accept-Language": "en-US,en;q=0.9",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
      },
    });
    if (!response.ok) {
      await cancelBody(response);
      return undefined;
    }
    const html = new TextDecoder().decode(await readResponseArrayBufferWithLimit(response, MAX_PAGE_BYTES));
    return extractInstagramPageMedia(html, post.shortcode);
  } catch {
    return undefined;
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
