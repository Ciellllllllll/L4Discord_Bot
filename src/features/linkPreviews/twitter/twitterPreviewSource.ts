import { URL } from "node:url";
import { readResponseArrayBufferWithLimit } from "../../ai/fetchWithLimits.js";
import type { PreviewDocument, PreviewTextBlock } from "../shared/previewDocument.js";

const VX_DOMAIN = "vxtwitter.com";
const X_DOMAINS = new Set([
  "x.com",
  "twitter.com",
  "mobile.twitter.com",
  "vxtwitter.com",
  "fxtwitter.com",
  "fixupx.com",
]);
const REQUEST_TIMEOUT_MS = 10_000;
// FxTwitter の 1 ツイート分の応答は数十 KB 程度なので、1MB あれば十分
const MAX_RESPONSE_BYTES = 1024 * 1024;
const USER_AGENT = "L4DiscordBot/0.1 VxTwitterPreview (+https://api.fxtwitter.com/)";
const TRIM_TAIL_CHARS = ".,!?;:)]}>,、。」』）";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type ParsedXStatusUrl = {
  id: string;
  screenName: string;
  originalUrl: string;
  vxUrl: string;
};

export type TwitterReplyTarget = {
  vxUrl: string;
  screenName?: string;
  statusId?: string;
};

export type TweetMediaKind = "photo" | "video" | "gif";

export type TweetMedia = {
  kind: TweetMediaKind;
  url: string;
  thumbnailUrl?: string;
  description?: string;
  sensitive: boolean;
};

export type TweetPreview = {
  id: string;
  url: string;
  text: string;
  createdTimestamp?: number;
  author: {
    name?: string;
    screenName: string;
    avatarUrl?: string;
  };
  likes?: number;
  retweets?: number;
  replies?: number;
  views?: number;
  sensitive: boolean;
  media: TweetMedia[];
  /** 記事リンクのカード（X で「news.yahoo.co.jp から」のように表示されるもの） */
  card?: TweetCard;
  quote?: {
    id?: string;
    url?: string;
    text: string;
    media: TweetMedia[];
    author: {
      name?: string;
      screenName: string;
    };
  };
};

export type TweetCard = {
  url: string;
  title: string;
  description?: string;
  domain: string;
  imageUrl?: string;
};

export type FixTweetPreviewResult =
  | { status: "ok"; tweet: TweetPreview }
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

function safeHttpsUrl(value: unknown): string | undefined {
  const raw = stringValue(value);
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "https:" ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function parseXStatusUrl(urlText: string): ParsedXStatusUrl | null {
  try {
    const parsed = new URL(ensureScheme(stripUrlTail(String(urlText || ""))));
    const host = hostWithoutWww(parsed.host);
    if (!X_DOMAINS.has(host)) return null;
    const parts = parsed.pathname.split("/").filter(Boolean);
    const statusIndex = parts.findIndex((part) => part.toLowerCase() === "status");
    const screenName = statusIndex > 0 ? parts[statusIndex - 1] : "";
    const id = statusIndex >= 0 ? parts[statusIndex + 1] : undefined;
    if (!screenName || !id || !/^\d+$/.test(id)) return null;
    const vx = new URL(parsed.toString());
    vx.host = VX_DOMAIN;
    return { id, screenName, originalUrl: parsed.toString(), vxUrl: vx.toString() };
  } catch {
    return null;
  }
}

function toVxTwitterUrl(urlText: string): string | null {
  try {
    const parsed = new URL(ensureScheme(stripUrlTail(String(urlText || ""))));
    if (!X_DOMAINS.has(hostWithoutWww(parsed.host))) return null;
    parsed.host = VX_DOMAIN;
    return parsed.toString();
  } catch {
    return null;
  }
}

export function collectTwitterReplyTargets(links: readonly string[]): TwitterReplyTarget[] {
  const targets: TwitterReplyTarget[] = [];
  const seen = new Set<string>();
  for (const link of links) {
    const parsed = parseXStatusUrl(link);
    const vxUrl = parsed?.vxUrl ?? toVxTwitterUrl(link);
    if (!vxUrl || seen.has(vxUrl)) continue;
    seen.add(vxUrl);
    targets.push({ vxUrl, screenName: parsed?.screenName, statusId: parsed?.id });
  }
  return targets;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function boolValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function firstString(...values: unknown[]): string | undefined {
  return values.map(stringValue).find(Boolean);
}

function mediaKind(type: string | undefined): TweetMediaKind | null {
  if (type === "photo" || type === "image") return "photo";
  if (type === "video") return "video";
  if (type === "gif") return "gif";
  return null;
}

function normalizeMediaItem(raw: unknown, tweetSensitive: boolean): TweetMedia | null {
  const item = asRecord(raw);
  if (!item) return null;
  const kind = mediaKind(stringValue(item.type));
  const url = safeHttpsUrl(firstString(item.url, item.media_url_https, item.mediaURL));
  if (!kind || !url) return null;
  const thumbnailUrl = safeHttpsUrl(firstString(item.thumbnail_url, item.thumbnailUrl));
  return {
    kind,
    url,
    ...(thumbnailUrl ? { thumbnailUrl } : {}),
    ...(firstString(item.altText, item.alt_text, item.description)
      ? { description: firstString(item.altText, item.alt_text, item.description) }
      : {}),
    sensitive: tweetSensitive || boolValue(item.possibly_sensitive) === true || boolValue(item.sensitive) === true,
  };
}

function normalizeMosaic(raw: unknown, tweetSensitive: boolean): TweetMedia | null {
  const mosaic = asRecord(raw);
  const formats = asRecord(mosaic?.formats);
  const url = safeHttpsUrl(formats?.webp) ?? safeHttpsUrl(formats?.jpeg);
  return url ? {
    kind: "photo",
    url,
    sensitive: tweetSensitive || boolValue(mosaic?.possibly_sensitive) === true || boolValue(mosaic?.sensitive) === true,
  } : null;
}

function normalizeMedia(rawTweet: Record<string, unknown>, tweetSensitive: boolean): TweetMedia[] {
  const media = asRecord(rawTweet.media);
  const all = arrayValue(media?.all);
  const ordered = [
    ...all,
    ...(all.length === 0 ? [...arrayValue(media?.photos), ...arrayValue(media?.videos)] : []),
    ...(media?.external ? [media.external] : []),
    ...(media?.mosaic ? [media.mosaic] : []),
    ...arrayValue(rawTweet.media_extended),
  ];
  const seen = new Set<string>();
  const result: TweetMedia[] = [];
  for (const item of ordered) {
    const normalized = stringValue(asRecord(item)?.type) === "mosaic_photo"
      ? normalizeMosaic(item, tweetSensitive)
      : normalizeMediaItem(item, tweetSensitive);
    if (normalized && !seen.has(normalized.url)) {
      seen.add(normalized.url);
      result.push(normalized);
    }
  }
  return result.slice(0, 10);
}

/** 記事リンクのカード。記事の URL とタイトルが無いもの（投票など別種のカード）は扱わない。 */
function normalizeCard(raw: unknown): TweetCard | undefined {
  const card = asRecord(raw);
  const url = safeHttpsUrl(card?.url);
  const title = stringValue(card?.title)?.trim();
  if (!url || !title) return undefined;
  const description = stringValue(card?.description)?.trim();
  const imageUrl = safeHttpsUrl(asRecord(card?.image)?.url);
  return {
    url,
    title,
    ...(description ? { description } : {}),
    domain: stringValue(card?.domain)?.trim() ?? new URL(url).hostname,
    ...(imageUrl ? { imageUrl } : {}),
  };
}

function normalizeQuote(raw: unknown): TweetPreview["quote"] | undefined {
  const quote = asRecord(raw);
  if (!quote) return undefined;
  const author = asRecord(quote.author);
  const screenName = firstString(author?.screen_name, author?.screenName, quote.screen_name, quote.screenName);
  const text = firstString(quote.text, quote.full_text) ?? "";
  const sensitive = boolValue(quote.possibly_sensitive) === true
    || boolValue(quote.sensitive) === true
    || boolValue(quote.nsfw) === true;
  const media = normalizeMedia(quote, sensitive);
  if (!screenName || (!text && media.length === 0)) return undefined;
  return {
    ...(firstString(quote.id, quote.tweetID) ? { id: firstString(quote.id, quote.tweetID) } : {}),
    ...(safeHttpsUrl(quote.url) ? { url: safeHttpsUrl(quote.url) } : {}),
    text,
    media,
    author: { ...(firstString(author?.name) ? { name: firstString(author?.name) } : {}), screenName },
  };
}

export function normalizeFixTweetResponse(raw: unknown): FixTweetPreviewResult {
  const root = asRecord(raw);
  const code = numberValue(root?.code);
  if (code !== 200) return { status: "fallback", reason: stringValue(root?.message) ?? `code_${code ?? "missing"}` };
  const tweet = asRecord(root?.tweet);
  if (!tweet) return { status: "fallback", reason: "missing_tweet" };
  const author = asRecord(tweet.author);
  const screenName = firstString(author?.screen_name, author?.screenName, tweet.screen_name, tweet.screenName);
  const id = firstString(tweet.id, tweet.tweetID);
  const text = firstString(tweet.text, tweet.full_text) ?? "";
  if (!screenName || (!id && !text)) return { status: "fallback", reason: "invalid_tweet" };
  const sensitive = boolValue(tweet.possibly_sensitive) === true
    || boolValue(tweet.sensitive) === true
    || boolValue(tweet.nsfw) === true;
  const fallbackUrl = id ? `https://twitter.com/${screenName}/status/${id}` : `https://twitter.com/${screenName}`;
  return {
    status: "ok",
    tweet: {
      id: id ?? "",
      url: safeHttpsUrl(tweet.url) ?? fallbackUrl,
      text,
      ...(numberValue(tweet.created_timestamp) ?? numberValue(tweet.date_epoch)
        ? { createdTimestamp: numberValue(tweet.created_timestamp) ?? numberValue(tweet.date_epoch) }
        : {}),
      author: {
        ...(firstString(author?.name) ? { name: firstString(author?.name) } : {}),
        screenName,
        ...(safeHttpsUrl(firstString(author?.avatar_url, author?.avatarUrl))
          ? { avatarUrl: safeHttpsUrl(firstString(author?.avatar_url, author?.avatarUrl)) }
          : {}),
      },
      ...(numberValue(tweet.likes) !== undefined ? { likes: numberValue(tweet.likes) } : {}),
      ...(numberValue(tweet.retweets) !== undefined ? { retweets: numberValue(tweet.retweets) } : {}),
      ...(numberValue(tweet.replies) !== undefined ? { replies: numberValue(tweet.replies) } : {}),
      ...(numberValue(tweet.views) !== undefined ? { views: numberValue(tweet.views) } : {}),
      sensitive,
      media: normalizeMedia(tweet, sensitive),
      ...(normalizeCard(tweet.card) ? { card: normalizeCard(tweet.card) } : {}),
      ...(normalizeQuote(tweet.quote) ? { quote: normalizeQuote(tweet.quote) } : {}),
    },
  };
}

export async function fetchFixTweetPreview(
  input: Pick<ParsedXStatusUrl, "id" | "screenName">,
  fetcher: FetchLike = fetch,
): Promise<FixTweetPreviewResult> {
  try {
    const response = await fetcher(
      `https://api.fxtwitter.com/${encodeURIComponent(input.screenName)}/status/${encodeURIComponent(input.id)}`,
      { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), headers: { "User-Agent": USER_AGENT, Accept: "application/json" } },
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return { status: "fallback", reason: `http_${response.status}` };
    }
    // 上限を超えた時点で読み込みを打ち切って例外になり、外側の catch でフォールバックする
    const text = new TextDecoder().decode(await readResponseArrayBufferWithLimit(response, MAX_RESPONSE_BYTES));
    try {
      return normalizeFixTweetResponse(JSON.parse(text) as unknown);
    } catch {
      return { status: "fallback", reason: "invalid_json" };
    }
  } catch (err) {
    return { status: "fallback", reason: err instanceof Error ? (err.name === "TimeoutError" ? "AbortError" : err.name) : "fetch_error" };
  }
}

function compactText(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function formatDate(timestamp: number | undefined): string | null {
  if (typeof timestamp !== "number") return null;
  const date = new Date(timestamp * 1_000);
  return `${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, "0")}/${String(date.getUTCDate()).padStart(2, "0")}`;
}

function formatCount(icon: string, value: number | undefined): string | null {
  return typeof value === "number" ? `${icon} ${value.toLocaleString("ja-JP")}` : null;
}

function mediaBlock(id: string, items: readonly TweetMedia[]): PreviewDocument["blocks"][number] | null {
  if (items.length === 0) return null;
  return {
    type: "media",
    id,
    items: items.slice(0, 10).map((item) => ({
      url: item.url,
      ...(item.description ? { description: item.description } : {}),
      ...(item.sensitive ? { spoiler: true } : {}),
    })),
  };
}

/** 本文の末尾がカードの記事 URL だけのとき（X 上では表示されない）は、重複しないよう取り除く。 */
function withoutTrailingCardUrl(text: string, card: TweetCard | undefined): string {
  if (!card) return text;
  const trimmed = text.trimEnd();
  return trimmed.endsWith(card.url) ? trimmed.slice(0, -card.url.length).trimEnd() : text;
}

/**
 * 記事カードのブロック。投稿自体に画像・動画が無ければ記事画像を大きく（メディアギャラリー）、
 * あれば右側の小さなサムネイルにする。タイトルと説明は翻訳の対象にする。
 */
function cardBlocks(tweet: TweetPreview): PreviewDocument["blocks"] {
  const card = tweet.card;
  if (!card) return [];
  const largeImage = card.imageUrl && tweet.media.length === 0 ? card.imageUrl : undefined;
  const thumbnailUrl = card.imageUrl && !largeImage ? card.imageUrl : undefined;
  const text: PreviewTextBlock = {
    type: "text",
    id: "card",
    ...(thumbnailUrl ? { thumbnailUrl, thumbnailDescription: "記事の画像", ...(tweet.sensitive ? { thumbnailSpoiler: true } : {}) } : {}),
    lines: [
      { prefix: "> 🔗 ", parts: [{ text: compactText(card.title, 200), translationKey: "card-title", strong: true }] },
      ...(card.description ? [{ prefix: "> ", parts: [{ text: compactText(card.description, 200), translationKey: "card-description" }] }] : []),
      { prefix: "-# ", parts: [{ text: card.domain }] },
    ],
  };
  return [
    ...(largeImage
      ? [{
        type: "media" as const,
        id: "card-media",
        items: [{ url: largeImage, description: "記事の画像", ...(tweet.sensitive ? { spoiler: true } : {}) }],
      }]
      : []),
    text,
  ];
}

export function tweetPreviewToDocument(tweet: TweetPreview): PreviewDocument {
  const authorName = tweet.author.name
    ? `${tweet.author.name} (@${tweet.author.screenName})`
    : `@${tweet.author.screenName}`;
  const bodyText = withoutTrailingCardUrl(tweet.text, tweet.card);
  const body: PreviewTextBlock = {
    type: "text",
    id: "body",
    ...(tweet.author.avatarUrl ? {
      thumbnailUrl: tweet.author.avatarUrl,
      thumbnailDescription: `${authorName} icon`,
    } : {}),
    lines: [
      { parts: [{ text: authorName, strong: true }] },
      ...(bodyText ? [
        { parts: [] },
        { parts: [{ text: bodyText.slice(0, 3_000), translationKey: "main" }] },
      ] : []),
    ],
  };
  const mainMedia = mediaBlock("main-media", tweet.media);
  const quote: PreviewTextBlock | null = tweet.quote ? {
    type: "text",
    id: "quote",
    lines: [
      {
        prefix: `> 引用: @${tweet.quote.author.screenName}${tweet.quote.text ? " " : ""}`,
        parts: tweet.quote.text
          ? [{ text: compactText(tweet.quote.text, 180), translationKey: "quote" }]
          : [],
      },
      ...(tweet.quote.url ? [{ prefix: "> ", parts: [{ text: tweet.quote.url }] }] : []),
    ],
  } : null;
  const quoteMedia = tweet.quote ? mediaBlock("quote-media", tweet.quote.media) : null;
  const stats = [
    formatCount("💬", tweet.replies),
    formatCount("🔁", tweet.retweets),
    formatCount("❤️", tweet.likes),
    formatCount("👁️", tweet.views),
  ].filter((part): part is string => Boolean(part));
  const meta = [formatDate(tweet.createdTimestamp), stats.length ? stats.join(" / ") : null].filter(Boolean).join(" / ");
  return {
    version: 1,
    source: "x",
    url: tweet.url,
    openLabel: "Xで開く",
    ...(tweet.card ? { secondaryAction: { label: "記事を開く", url: tweet.card.url } } : {}),
    blocks: [
      body,
      ...(mainMedia ? [mainMedia] : []),
      ...cardBlocks(tweet),
      ...(quote ? [quote] : []),
      ...(quoteMedia ? [quoteMedia] : []),
      ...(meta ? [{ type: "text" as const, id: "meta", lines: [{ prefix: "-# ", parts: [{ text: meta }] }] }] : []),
    ],
  };
}
