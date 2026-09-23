import { URL } from "node:url";
import type { APIEmbed } from "discord.js";
import { readResponseArrayBufferWithLimit } from "../../ai/fetchWithLimits.js";
import type { PreviewDocument, PreviewTextBlock } from "../shared/previewDocument.js";

const TRIM_TAIL_CHARS = ".,!?;:)]}>,、。」』）";
const REQUEST_TIMEOUT_MS = 10_000;
// Data API（プレイリスト項目は最大 3 件）や oEmbed の応答は数十 KB 程度なので、1MB あれば十分
const MAX_RESPONSE_BYTES = 1024 * 1024;
const CACHE_TTL_MS = 30 * 60 * 1_000;
const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"]);
const YOUTU_BE_HOSTS = new Set(["youtu.be", "www.youtu.be"]);

export type YouTubeTargetKind = "video" | "playlist" | "channel" | "fallback";
export type YouTubeReplyTarget = {
  kind: YouTubeTargetKind;
  originalUrl: string;
  canonicalUrl: string;
  id?: string;
  handle?: string;
  username?: string;
};
export type YouTubePreviewKind = "video" | "playlist" | "channel" | "oembed";
export type YouTubePreview = {
  kind: YouTubePreviewKind;
  url: string;
  title: string;
  description?: string;
  thumbnailUrl?: string;
  channelId?: string;
  channelIconUrl?: string;
  channelTitle?: string;
  publishedAt?: string;
  duration?: string;
  viewCount?: number;
  subscriberCount?: number;
  videoCount?: number;
  itemCount?: number;
  sampleItems?: string[];
  liveBroadcastContent?: string;
};
export type YouTubePreviewResult = { status: "ok"; preview: YouTubePreview } | { status: "fallback"; reason: string };
export type YouTubeSourceFetchOptions = {
  fetcher?: (url: string, init?: RequestInit) => Promise<Response>;
  apiKey?: string;
  requestTimeoutMs?: number;
  nowMs?: () => number;
};

type CacheEntry = { expiresAt: number; result: YouTubePreviewResult };
const previewCache = new Map<string, CacheEntry>();

function ensureScheme(value: string): string {
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

function stripUrlTail(value: string): string {
  let result = value.trim();
  while (result && TRIM_TAIL_CHARS.includes(result.at(-1)!)) result = result.slice(0, -1);
  return result;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function arrayValue(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
function firstString(...values: unknown[]): string | undefined { return values.map(stringValue).find(Boolean); }
export function safeYouTubeHttpsUrl(value: unknown): string | undefined {
  const raw = stringValue(value);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch { return undefined; }
}

function canonicalUrl(pathname: string, search: Record<string, string> = {}): string {
  const url = new URL(`https://www.youtube.com${pathname}`);
  for (const [key, value] of Object.entries(search)) url.searchParams.set(key, value);
  return url.toString();
}

function parsePathParts(url: URL): string[] {
  return url.pathname.split("/").filter(Boolean).map((part) => {
    try { return decodeURIComponent(part); } catch { return part; }
  });
}

function fallbackTarget(url: URL, originalUrl: string): YouTubeReplyTarget {
  url.protocol = "https:";
  url.host = "www.youtube.com";
  return { kind: "fallback", originalUrl, canonicalUrl: url.toString() };
}

export function parseYouTubeUrl(value: string): YouTubeReplyTarget | null {
  let url: URL;
  try { url = new URL(ensureScheme(stripUrlTail(String(value || "")))); } catch { return null; }
  const originalUrl = url.toString();
  const host = url.host.toLowerCase();
  if (YOUTU_BE_HOSTS.has(host)) {
    const id = parsePathParts(url)[0];
    return id ? { kind: "video", originalUrl, canonicalUrl: canonicalUrl("/watch", { v: id }), id } : null;
  }
  if (!YOUTUBE_HOSTS.has(host)) return null;
  const parts = parsePathParts(url);
  const first = parts[0] ?? "";
  if (first === "watch") {
    const id = url.searchParams.get("v") ?? "";
    return id ? { kind: "video", originalUrl, canonicalUrl: canonicalUrl("/watch", { v: id }), id } : fallbackTarget(url, originalUrl);
  }
  if (["shorts", "live", "embed", "v"].includes(first)) {
    const id = parts[1];
    return id ? { kind: "video", originalUrl, canonicalUrl: canonicalUrl("/watch", { v: id }), id } : fallbackTarget(url, originalUrl);
  }
  if (first === "playlist") {
    const id = url.searchParams.get("list") ?? "";
    return id ? { kind: "playlist", originalUrl, canonicalUrl: canonicalUrl("/playlist", { list: id }), id } : fallbackTarget(url, originalUrl);
  }
  if (first === "channel" && parts[1]) return { kind: "channel", originalUrl, canonicalUrl: canonicalUrl(`/channel/${encodeURIComponent(parts[1])}`), id: parts[1] };
  if (first.startsWith("@") && first.length > 1) return { kind: "channel", originalUrl, canonicalUrl: canonicalUrl(`/@${encodeURIComponent(first.slice(1))}`), handle: first.slice(1) };
  if (first === "user" && parts[1]) return { kind: "channel", originalUrl, canonicalUrl: canonicalUrl(`/user/${encodeURIComponent(parts[1])}`), username: parts[1] };
  return fallbackTarget(url, originalUrl);
}

export function collectYouTubeReplyTargets(links: readonly string[]): YouTubeReplyTarget[] {
  const result: YouTubeReplyTarget[] = [];
  const seen = new Set<string>();
  for (const link of links) {
    const target = parseYouTubeUrl(link);
    if (!target || seen.has(target.canonicalUrl)) continue;
    seen.add(target.canonicalUrl);
    result.push(target);
    if (result.length === 5) break;
  }
  return result;
}

function firstItem(raw: unknown): Record<string, unknown> | null { return asRecord(arrayValue(asRecord(raw)?.items)[0]); }
function thumbnailUrl(snippet: Record<string, unknown> | null): string | undefined {
  const thumbnails = asRecord(snippet?.thumbnails);
  return safeYouTubeHttpsUrl(asRecord(thumbnails?.maxres)?.url)
    ?? safeYouTubeHttpsUrl(asRecord(thumbnails?.standard)?.url)
    ?? safeYouTubeHttpsUrl(asRecord(thumbnails?.high)?.url)
    ?? safeYouTubeHttpsUrl(asRecord(thumbnails?.medium)?.url)
    ?? safeYouTubeHttpsUrl(asRecord(thumbnails?.default)?.url);
}
function itemTitle(raw: unknown): string | undefined { return firstString(asRecord(asRecord(raw)?.snippet)?.title); }

export function normalizeYouTubeVideoResponse(raw: unknown, url: string): YouTubePreviewResult {
  const item = firstItem(raw);
  if (!item) return { status: "fallback", reason: "empty_items" };
  const snippet = asRecord(item.snippet);
  const title = firstString(snippet?.title);
  if (!title) return { status: "fallback", reason: "missing_title" };
  const content = asRecord(item.contentDetails);
  const statistics = asRecord(item.statistics);
  return { status: "ok", preview: {
    kind: "video", url, title,
    description: firstString(snippet?.description), thumbnailUrl: thumbnailUrl(snippet),
    channelId: firstString(snippet?.channelId), channelTitle: firstString(snippet?.channelTitle),
    publishedAt: firstString(snippet?.publishedAt), duration: firstString(content?.duration),
    viewCount: numberValue(statistics?.viewCount), liveBroadcastContent: firstString(snippet?.liveBroadcastContent),
  } };
}

export function normalizeYouTubePlaylistResponse(raw: unknown, url: string, sampleRaw?: unknown): YouTubePreviewResult {
  const item = firstItem(raw);
  if (!item) return { status: "fallback", reason: "empty_items" };
  const snippet = asRecord(item.snippet);
  const title = firstString(snippet?.title);
  if (!title) return { status: "fallback", reason: "missing_title" };
  const samples = arrayValue(asRecord(sampleRaw)?.items).map(itemTitle)
    .filter((value): value is string => Boolean(value && !["Deleted video", "Private video"].includes(value))).slice(0, 3);
  return { status: "ok", preview: {
    kind: "playlist", url, title, description: firstString(snippet?.description), thumbnailUrl: thumbnailUrl(snippet),
    channelTitle: firstString(snippet?.channelTitle), publishedAt: firstString(snippet?.publishedAt),
    itemCount: numberValue(asRecord(item.contentDetails)?.itemCount), sampleItems: samples.length ? samples : undefined,
  } };
}

export function normalizeYouTubeChannelResponse(raw: unknown, url: string): YouTubePreviewResult {
  const item = firstItem(raw);
  if (!item) return { status: "fallback", reason: "empty_items" };
  const snippet = asRecord(item.snippet);
  const title = firstString(snippet?.title);
  if (!title) return { status: "fallback", reason: "missing_title" };
  const statistics = asRecord(item.statistics);
  return { status: "ok", preview: {
    kind: "channel", url, title, description: firstString(snippet?.description), thumbnailUrl: thumbnailUrl(snippet),
    publishedAt: firstString(snippet?.publishedAt), subscriberCount: numberValue(statistics?.subscriberCount),
    videoCount: numberValue(statistics?.videoCount),
  } };
}

export function normalizeYouTubeOEmbedResponse(raw: unknown, url: string): YouTubePreviewResult {
  const root = asRecord(raw);
  const title = firstString(root?.title);
  return title ? { status: "ok", preview: {
    kind: "oembed", url, title, description: firstString(root?.description),
    thumbnailUrl: safeYouTubeHttpsUrl(root?.thumbnail_url), channelTitle: firstString(root?.author_name),
  } } : { status: "fallback", reason: "missing_title" };
}

function dataApiUrl(path: string, params: Record<string, string>): string {
  const url = new URL(`https://www.googleapis.com/youtube/v3/${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}
function oembedUrl(urlValue: string): string {
  const url = new URL("https://www.youtube.com/oembed");
  url.searchParams.set("url", urlValue); url.searchParams.set("format", "json"); return url.toString();
}
async function fetchJson(url: string, fetcher: NonNullable<YouTubeSourceFetchOptions["fetcher"]>, timeout: number): Promise<{ ok: true; value: unknown } | { ok: false; reason: string }> {
  try {
    const response = await fetcher(url, { signal: AbortSignal.timeout(timeout), headers: { Accept: "application/json" } });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, reason: `http_${response.status}` };
    }
    // 上限を超えた時点で読み込みを打ち切って例外になり、外側の catch でフォールバックする
    const text = new TextDecoder().decode(await readResponseArrayBufferWithLimit(response, MAX_RESPONSE_BYTES));
    try { return { ok: true, value: JSON.parse(text) as unknown }; } catch { return { ok: false, reason: "invalid_json" }; }
  } catch (error) { return { ok: false, reason: error instanceof Error ? (error.name === "TimeoutError" ? "AbortError" : error.name) : "fetch_error" }; }
}

async function fetchWithDataApi(target: YouTubeReplyTarget, apiKey: string, fetcher: NonNullable<YouTubeSourceFetchOptions["fetcher"]>, timeout: number): Promise<YouTubePreviewResult> {
  if (target.kind === "video" && target.id) {
    const fetched = await fetchJson(dataApiUrl("videos", { part: "snippet,contentDetails,statistics,liveStreamingDetails", id: target.id, key: apiKey }), fetcher, timeout);
    if (!fetched.ok) return { status: "fallback", reason: fetched.reason };
    const video = normalizeYouTubeVideoResponse(fetched.value, target.canonicalUrl);
    if (video.status !== "ok" || !video.preview.channelId) return video;
    const channel = await fetchJson(dataApiUrl("channels", { part: "snippet", id: video.preview.channelId, key: apiKey }), fetcher, timeout);
    const icon = channel.ok ? thumbnailUrl(asRecord(firstItem(channel.value)?.snippet)) : undefined;
    return icon ? { status: "ok", preview: { ...video.preview, channelIconUrl: icon } } : video;
  }
  if (target.kind === "playlist" && target.id) {
    const playlist = await fetchJson(dataApiUrl("playlists", { part: "snippet,contentDetails", id: target.id, key: apiKey }), fetcher, timeout);
    if (!playlist.ok) return { status: "fallback", reason: playlist.reason };
    const items = await fetchJson(dataApiUrl("playlistItems", { part: "snippet", playlistId: target.id, maxResults: "3", key: apiKey }), fetcher, timeout);
    if (!items.ok) return { status: "fallback", reason: items.reason };
    if (!arrayValue(asRecord(items.value)?.items).length) return { status: "fallback", reason: "empty_items" };
    return normalizeYouTubePlaylistResponse(playlist.value, target.canonicalUrl, items.value);
  }
  if (target.kind === "channel") {
    const params: Record<string, string> = { part: "snippet,statistics", key: apiKey };
    if (target.id) params.id = target.id; else if (target.handle) params.forHandle = `@${target.handle}`; else if (target.username) params.forUsername = target.username; else return { status: "fallback", reason: "missing_channel_identifier" };
    const channel = await fetchJson(dataApiUrl("channels", params), fetcher, timeout);
    return channel.ok ? normalizeYouTubeChannelResponse(channel.value, target.canonicalUrl) : { status: "fallback", reason: channel.reason };
  }
  return { status: "fallback", reason: "unsupported_target" };
}

async function fetchWithOEmbed(target: YouTubeReplyTarget, fetcher: NonNullable<YouTubeSourceFetchOptions["fetcher"]>, timeout: number): Promise<YouTubePreviewResult> {
  if (target.kind !== "video") return { status: "fallback", reason: "missing_api_key" };
  const result = await fetchJson(oembedUrl(target.canonicalUrl), fetcher, timeout);
  return result.ok ? normalizeYouTubeOEmbedResponse(result.value, target.canonicalUrl) : { status: "fallback", reason: result.reason };
}

export async function fetchYouTubePreview(target: YouTubeReplyTarget, options: YouTubeSourceFetchOptions = {}): Promise<YouTubePreviewResult> {
  const now = options.nowMs?.() ?? Date.now();
  const cacheKey = `${target.kind}:${target.canonicalUrl}`;
  const cached = previewCache.get(cacheKey);
  if (cached?.expiresAt && cached.expiresAt > now) return cached.result;
  previewCache.delete(cacheKey);
  const fetcher = options.fetcher ?? fetch;
  const timeout = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const apiKey = options.apiKey?.trim() ?? "";
  const primary = apiKey ? await fetchWithDataApi(target, apiKey, fetcher, timeout) : await fetchWithOEmbed(target, fetcher, timeout);
  const result = apiKey && target.kind === "video" && primary.status === "fallback"
    ? await fetchWithOEmbed(target, fetcher, timeout).then((fallback) => fallback.status === "ok" ? fallback : primary)
    : primary;
  previewCache.set(cacheKey, { expiresAt: now + CACHE_TTL_MS, result });
  return result;
}

function compactText(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}
function publishedAt(value: string | undefined): string | null {
  const timestamp = value ? Date.parse(value) : NaN;
  return Number.isFinite(timestamp) ? `<t:${Math.floor(timestamp / 1_000)}:D>` : null;
}
function duration(value: string | undefined): string | null {
  const match = value ? /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(value) : null;
  if (!match) return null;
  const hours = Number(match[1] ?? 0) * 24 + Number(match[2] ?? 0);
  const minutes = Number(match[3] ?? 0); const seconds = Number(match[4] ?? 0);
  if (!hours && !minutes && !seconds) return null;
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}` : `${minutes}:${String(seconds).padStart(2, "0")}`;
}
function count(value: number | undefined): string | null { return typeof value === "number" ? value.toLocaleString("ja-JP") : null; }
function kindLabel(preview: YouTubePreview): string {
  const base = preview.kind === "playlist" ? "プレイリスト" : preview.kind === "channel" ? "チャンネル" : "動画";
  return preview.liveBroadcastContent === "live" ? `${base}・ライブ` : preview.liveBroadcastContent === "upcoming" ? `${base}・配信予定` : base;
}

export function youTubePreviewToDocument(preview: YouTubePreview): PreviewDocument {
  const translateTitle = preview.kind !== "channel";
  const lines: PreviewTextBlock["lines"] = [
    { parts: [{ text: preview.title, strong: true, ...(translateTitle ? { translationKey: "title" } : {}) }] },
    { parts: [{ text: kindLabel(preview) }] },
    ...(preview.channelTitle ? [{ prefix: `${preview.kind === "playlist" ? "所有者" : "投稿者"}: `, parts: [{ text: preview.channelTitle }] }] : []),
    ...(preview.description ? [{ parts: [] }, { parts: [{ text: compactText(preview.description, 300), translationKey: "description" }] }] : []),
  ];
  const meta = [
    publishedAt(preview.publishedAt) ? `公開日: ${publishedAt(preview.publishedAt)}` : null,
    duration(preview.duration) ? `再生時間: ${duration(preview.duration)}` : null,
    count(preview.viewCount) ? `再生数: ${count(preview.viewCount)}` : null,
    count(preview.subscriberCount) ? `登録者数: ${count(preview.subscriberCount)}` : null,
    count(preview.videoCount) ? `動画数: ${count(preview.videoCount)}` : null,
    count(preview.itemCount) ? `動画数: ${count(preview.itemCount)}` : null,
  ].filter((value): value is string => Boolean(value));
  if (meta.length) lines.push({ parts: [] }, { parts: [{ text: meta.join(" / ") }] });
  preview.sampleItems?.slice(0, 3).forEach((title, index) => lines.push({ prefix: "- ", parts: [{ text: compactText(title, 120), translationKey: `sample:${index}` }] }));
  const channelIconUrl = safeYouTubeHttpsUrl(preview.channelIconUrl);
  const thumbnail = safeYouTubeHttpsUrl(preview.thumbnailUrl);
  return {
    version: 1, source: "youtube", url: preview.url, openLabel: "YouTubeで開く",
    blocks: [{ type: "text", id: "body", lines, ...(channelIconUrl ? { thumbnailUrl: channelIconUrl, thumbnailDescription: `${preview.channelTitle ?? preview.title} icon` } : {}) },
      ...(thumbnail ? [{ type: "media" as const, id: "media", items: [{ url: thumbnail, description: `${preview.title} thumbnail` }] }] : [])],
  };
}

export function getYouTubeNativeEmbedVideoUrl(embed: APIEmbed): string | undefined {
  const contentType = embed.video?.content_type?.toLowerCase();
  for (const value of [embed.video?.proxy_url, embed.video?.url]) {
    const url = safeYouTubeHttpsUrl(value);
    if (url && (contentType?.startsWith("video/") || /\.(?:mp4|m4v|webm|mov)(?:$|[?#])/i.test(new URL(url).pathname))) return url;
  }
  return undefined;
}

export function nativeYouTubeEmbedToDocument(embed: APIEmbed, fallbackUrl?: string): PreviewDocument {
  const url = safeYouTubeHttpsUrl(embed.url) ?? safeYouTubeHttpsUrl(fallbackUrl) ?? "https://www.youtube.com";
  const title = compactText(embed.title ?? "YouTube", 256);
  // Discordのproxy動画URLは期限切れになるため、保存対象文書には安定した画像だけを入れる。
  const media = safeYouTubeHttpsUrl(embed.image?.url) ?? safeYouTubeHttpsUrl(embed.thumbnail?.url);
  return {
    version: 1, source: "youtube", url, openLabel: "YouTubeで開く",
    blocks: [{
      type: "text", id: "body",
      ...(safeYouTubeHttpsUrl(embed.author?.icon_url) ? { thumbnailUrl: safeYouTubeHttpsUrl(embed.author?.icon_url), thumbnailDescription: `${embed.author?.name ?? title} icon` } : {}),
      lines: [
        { parts: [{ text: title, strong: true, translationKey: "title" }] },
        ...(embed.provider?.name ? [{ parts: [{ text: embed.provider.name }] }] : []),
        ...(embed.author?.name ? [{ prefix: "投稿者: ", parts: [{ text: embed.author.name }] }] : []),
        ...(embed.description ? [{ parts: [{ text: compactText(embed.description, 3_500), translationKey: "description" }] }] : []),
      ],
    }, ...(media ? [{ type: "media" as const, id: "media", items: [{ url: media, description: `${title} thumbnail` }] }] : [])],
  };
}

export function youTubeRssEntryToDocument(entry: { videoUrl: string; title: string; description?: string | null; channelTitle: string; publishedAt: string; thumbnailUrl?: string | null }): PreviewDocument {
  const timestamp = Date.parse(entry.publishedAt);
  return {
    version: 1, source: "youtube", url: entry.videoUrl, openLabel: "YouTubeで開く",
    blocks: [{ type: "text", id: "body", lines: [
      { parts: [{ text: entry.title, strong: true, translationKey: "title" }] },
      { parts: [{ text: entry.channelTitle }] },
      ...(entry.description ? [{ parts: [{ text: compactText(entry.description, 300), translationKey: "description" }] }] : []),
      ...(Number.isFinite(timestamp) ? [{ prefix: "公開: ", parts: [{ text: `<t:${Math.floor(timestamp / 1_000)}:F>` }] }] : []),
    ] }, ...(entry.thumbnailUrl ? [{ type: "media" as const, id: "media", items: [{ url: entry.thumbnailUrl }] }] : [])],
  };
}
