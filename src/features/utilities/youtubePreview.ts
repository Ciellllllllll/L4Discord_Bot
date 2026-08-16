import { URL } from "node:url";
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  MessageFlags,
  type APIActionRowComponent,
  type APIButtonComponent,
  type APIComponentInContainer,
  type APIContainerComponent,
  type APIEmbed,
  type APIMediaGalleryComponent,
  type APIMessageTopLevelComponent,
  type APISectionComponent,
  type APITextDisplayComponent,
  type MessageCreateOptions,
} from "discord.js";
import { resolveYouTubeVideoMedia } from "./youtubeVideoMedia.js";
import { ComponentCardBuilder, componentCardsPayload } from "../panels/componentCard.js";

const TRIM_TAIL_CHARS = ".,!?;:)]}>,、。」』）";
const REQUEST_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 30 * 60 * 1000;
const MEDIA_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
const MEDIA_ATTACHMENT_FILENAME = "youtube-preview.mp4";
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

export type YouTubePreviewResult =
  | { status: "ok"; preview: YouTubePreview }
  | { status: "fallback"; reason: string };

export type YouTubePreviewPayload = {
  embeds: [];
  flags: MessageFlags.IsComponentsV2;
  components: APIMessageTopLevelComponent[];
  allowedMentions: { parse: []; repliedUser: false };
  files?: AttachmentBuilder[];
};

export type YouTubePreviewBuildOptions = {
  fetcher?: (url: string, init?: RequestInit) => Promise<Response>;
  apiKey?: string;
  requestTimeoutMs?: number;
  attachmentSizeLimitBytes?: number;
  nowMs?: () => number;
  componentsOnly?: boolean;
  mediaResolver?: typeof resolveYouTubeVideoMedia;
  mediaUrlOverride?: string;
  mediaMode?: "vps" | "google" | "none";
  log?: { warn?: (...args: unknown[]) => void };
};

export type YouTubePreviewPayloadOptions = {
  mediaUrl?: string;
  files?: AttachmentBuilder[];
  fallback?: boolean;
  mediaMode?: "vps" | "google" | "none";
};

type CacheEntry = {
  expiresAt: number;
  result: YouTubePreviewResult;
};

type ResolvedPreviewMedia = {
  kind: "attachment" | "external";
  mediaUrl: string;
  files?: AttachmentBuilder[];
};

const previewCache = new Map<string, CacheEntry>();

function ensureScheme(urlText: string): string {
  return /^https?:\/\//i.test(urlText) ? urlText : `https://${urlText}`;
}

function stripUrlTail(urlText: string): string {
  let out = urlText.trim();
  while (out && TRIM_TAIL_CHARS.includes(out[out.length - 1]!)) {
    out = out.slice(0, -1);
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const s = stringValue(value);
    if (s) return s;
  }
  return undefined;
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

function safeMediaGalleryUrl(value: unknown): string | undefined {
  const raw = stringValue(value);
  if (!raw) return undefined;
  if (raw === `attachment://${MEDIA_ATTACHMENT_FILENAME}`) return raw;
  return safeHttpsUrl(raw);
}

function isGoogleVideoUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === "googlevideo.com" || host.endsWith(".googlevideo.com");
  } catch {
    return false;
  }
}

function fallbackMediaUrl(options: YouTubePreviewPayloadOptions): string | undefined {
  if (options.mediaMode === "none") return undefined;
  const mediaUrl = safeHttpsUrl(options.mediaUrl);
  if (!mediaUrl) return undefined;
  return options.mediaMode === "google" && !isGoogleVideoUrl(mediaUrl) ? undefined : mediaUrl;
}

function canonicalUrl(pathname: string, search?: Record<string, string>): string {
  const url = new URL(`https://www.youtube.com${pathname}`);
  for (const [key, value] of Object.entries(search ?? {})) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

function parsePathParts(parsed: URL): string[] {
  return parsed.pathname.split("/").filter(Boolean).map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  });
}

function youtubeFallback(parsed: URL, originalUrl: string): YouTubeReplyTarget {
  parsed.protocol = "https:";
  parsed.host = "www.youtube.com";
  return {
    kind: "fallback",
    originalUrl,
    canonicalUrl: parsed.toString(),
  };
}

export function parseYouTubeUrl(urlText: string): YouTubeReplyTarget | null {
  let parsed: URL;
  try {
    parsed = new URL(ensureScheme(stripUrlTail(String(urlText || ""))));
  } catch {
    return null;
  }

  const host = parsed.host.toLowerCase();
  const originalUrl = parsed.toString();

  if (YOUTU_BE_HOSTS.has(host)) {
    const id = parsePathParts(parsed)[0];
    if (!id) return null;
    return {
      kind: "video",
      originalUrl,
      canonicalUrl: canonicalUrl("/watch", { v: id }),
      id,
    };
  }

  if (!YOUTUBE_HOSTS.has(host)) return null;

  const parts = parsePathParts(parsed);
  const first = parts[0] ?? "";
  if (first === "watch") {
    const id = parsed.searchParams.get("v") ?? "";
    if (id) {
      return {
        kind: "video",
        originalUrl,
        canonicalUrl: canonicalUrl("/watch", { v: id }),
        id,
      };
    }
    return youtubeFallback(parsed, originalUrl);
  }

  if (["shorts", "live", "embed", "v"].includes(first)) {
    const id = parts[1];
    if (id) {
      return {
        kind: "video",
        originalUrl,
        canonicalUrl: canonicalUrl("/watch", { v: id }),
        id,
      };
    }
    return youtubeFallback(parsed, originalUrl);
  }

  if (first === "playlist") {
    const id = parsed.searchParams.get("list") ?? "";
    if (id) {
      return {
        kind: "playlist",
        originalUrl,
        canonicalUrl: canonicalUrl("/playlist", { list: id }),
        id,
      };
    }
    return youtubeFallback(parsed, originalUrl);
  }

  if (first === "channel") {
    const id = parts[1];
    if (id) {
      return {
        kind: "channel",
        originalUrl,
        canonicalUrl: canonicalUrl(`/channel/${encodeURIComponent(id)}`),
        id,
      };
    }
    return youtubeFallback(parsed, originalUrl);
  }

  if (first.startsWith("@") && first.length > 1) {
    const handle = first.slice(1);
    return {
      kind: "channel",
      originalUrl,
      canonicalUrl: canonicalUrl(`/@${encodeURIComponent(handle)}`),
      handle,
    };
  }

  if (first === "user") {
    const username = parts[1];
    if (username) {
      return {
        kind: "channel",
        originalUrl,
        canonicalUrl: canonicalUrl(`/user/${encodeURIComponent(username)}`),
        username,
      };
    }
    return youtubeFallback(parsed, originalUrl);
  }

  return youtubeFallback(parsed, originalUrl);
}

export function collectYouTubeReplyTargets(links: readonly string[]): YouTubeReplyTarget[] {
  const targets: YouTubeReplyTarget[] = [];
  const seen = new Set<string>();
  for (const link of links) {
    const target = parseYouTubeUrl(link);
    if (!target || seen.has(target.canonicalUrl)) continue;
    seen.add(target.canonicalUrl);
    targets.push(target);
    if (targets.length >= 5) break;
  }
  return targets;
}

function firstItem(raw: unknown): Record<string, unknown> | null {
  const item = arrayValue(asRecord(raw)?.items)[0];
  return asRecord(item);
}

function thumbnailUrl(snippet: Record<string, unknown> | null): string | undefined {
  const thumbnails = asRecord(snippet?.thumbnails);
  return safeHttpsUrl(asRecord(thumbnails?.maxres)?.url)
    ?? safeHttpsUrl(asRecord(thumbnails?.standard)?.url)
    ?? safeHttpsUrl(asRecord(thumbnails?.high)?.url)
    ?? safeHttpsUrl(asRecord(thumbnails?.medium)?.url)
    ?? safeHttpsUrl(asRecord(thumbnails?.default)?.url);
}

function itemTitle(raw: unknown): string | undefined {
  return firstString(asRecord(asRecord(raw)?.snippet)?.title);
}

function validSampleTitle(title: string): boolean {
  return !["Deleted video", "Private video"].includes(title);
}

export function normalizeYouTubeVideoResponse(raw: unknown, canonicalUrl: string): YouTubePreviewResult {
  const item = firstItem(raw);
  if (!item) return { status: "fallback", reason: "empty_items" };
  const snippet = asRecord(item.snippet);
  const title = firstString(snippet?.title);
  if (!title) return { status: "fallback", reason: "missing_title" };
  const contentDetails = asRecord(item.contentDetails);
  const statistics = asRecord(item.statistics);
  return {
    status: "ok",
    preview: {
      kind: "video",
      url: canonicalUrl,
      title,
      description: firstString(snippet?.description),
      thumbnailUrl: thumbnailUrl(snippet),
      channelId: firstString(snippet?.channelId),
      channelTitle: firstString(snippet?.channelTitle),
      publishedAt: firstString(snippet?.publishedAt),
      duration: firstString(contentDetails?.duration),
      viewCount: numberValue(statistics?.viewCount),
      liveBroadcastContent: firstString(snippet?.liveBroadcastContent),
    },
  };
}

export function normalizeYouTubePlaylistResponse(
  raw: unknown,
  canonicalUrl: string,
  sampleRaw?: unknown,
): YouTubePreviewResult {
  const item = firstItem(raw);
  if (!item) return { status: "fallback", reason: "empty_items" };
  const snippet = asRecord(item.snippet);
  const title = firstString(snippet?.title);
  if (!title) return { status: "fallback", reason: "missing_title" };
  const contentDetails = asRecord(item.contentDetails);
  const sampleItems = arrayValue(asRecord(sampleRaw)?.items)
    .map(itemTitle)
    .filter((title): title is string => Boolean(title && validSampleTitle(title)))
    .slice(0, 3);
  return {
    status: "ok",
    preview: {
      kind: "playlist",
      url: canonicalUrl,
      title,
      description: firstString(snippet?.description),
      thumbnailUrl: thumbnailUrl(snippet),
      channelTitle: firstString(snippet?.channelTitle),
      publishedAt: firstString(snippet?.publishedAt),
      itemCount: numberValue(contentDetails?.itemCount),
      sampleItems: sampleItems.length > 0 ? sampleItems : undefined,
    },
  };
}

export function normalizeYouTubeChannelResponse(raw: unknown, canonicalUrl: string): YouTubePreviewResult {
  const item = firstItem(raw);
  if (!item) return { status: "fallback", reason: "empty_items" };
  const snippet = asRecord(item.snippet);
  const title = firstString(snippet?.title);
  if (!title) return { status: "fallback", reason: "missing_title" };
  const statistics = asRecord(item.statistics);
  return {
    status: "ok",
    preview: {
      kind: "channel",
      url: canonicalUrl,
      title,
      description: firstString(snippet?.description),
      thumbnailUrl: thumbnailUrl(snippet),
      publishedAt: firstString(snippet?.publishedAt),
      subscriberCount: numberValue(statistics?.subscriberCount),
      videoCount: numberValue(statistics?.videoCount),
    },
  };
}

export function normalizeYouTubeOEmbedResponse(raw: unknown, canonicalUrl: string): YouTubePreviewResult {
  const root = asRecord(raw);
  const title = firstString(root?.title);
  if (!title) return { status: "fallback", reason: "missing_title" };
  return {
    status: "ok",
    preview: {
      kind: "oembed",
      url: canonicalUrl,
      title,
      thumbnailUrl: safeHttpsUrl(root?.thumbnail_url),
      channelTitle: firstString(root?.author_name),
    },
  };
}

function dataApiUrl(path: string, params: Record<string, string>): string {
  const url = new URL(`https://www.googleapis.com/youtube/v3/${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

function oembedUrl(canonicalUrl: string): string {
  const url = new URL("https://www.youtube.com/oembed");
  url.searchParams.set("url", canonicalUrl);
  url.searchParams.set("format", "json");
  return url.toString();
}

async function fetchJson(
  url: string,
  fetcher: (url: string, init?: RequestInit) => Promise<Response>,
  requestTimeoutMs: number,
): Promise<{ ok: true; value: unknown } | { ok: false; reason: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetcher(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    const text = await response.text();
    if (!response.ok) return { ok: false, reason: `http_${response.status}` };
    try {
      return { ok: true, value: JSON.parse(text) as unknown };
    } catch {
      return { ok: false, reason: "invalid_json" };
    }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.name : "fetch_error" };
  } finally {
    clearTimeout(timer);
  }
}

function channelIconUrl(raw: unknown): string | undefined {
  const item = firstItem(raw);
  if (!item) return undefined;
  return thumbnailUrl(asRecord(item.snippet));
}

async function fetchWithDataApi(
  target: YouTubeReplyTarget,
  apiKey: string,
  fetcher: (url: string, init?: RequestInit) => Promise<Response>,
  requestTimeoutMs: number,
): Promise<YouTubePreviewResult> {
  if (target.kind === "video" && target.id) {
    const fetched = await fetchJson(
      dataApiUrl("videos", {
        part: "snippet,contentDetails,statistics,liveStreamingDetails",
        id: target.id,
        key: apiKey,
      }),
      fetcher,
      requestTimeoutMs,
    );
    if (!fetched.ok) return { status: "fallback", reason: fetched.reason };
    const videoResult = normalizeYouTubeVideoResponse(fetched.value, target.canonicalUrl);
    if (videoResult.status !== "ok" || !videoResult.preview.channelId) return videoResult;

    const fetchedChannel = await fetchJson(
      dataApiUrl("channels", {
        part: "snippet",
        id: videoResult.preview.channelId,
        key: apiKey,
      }),
      fetcher,
      requestTimeoutMs,
    );
    if (!fetchedChannel.ok) return videoResult;

    const iconUrl = channelIconUrl(fetchedChannel.value);
    if (!iconUrl) return videoResult;

    return {
      status: "ok",
      preview: {
        ...videoResult.preview,
        channelIconUrl: iconUrl,
      },
    };
  }

  if (target.kind === "playlist" && target.id) {
    const fetchedPlaylist = await fetchJson(
      dataApiUrl("playlists", {
        part: "snippet,contentDetails",
        id: target.id,
        key: apiKey,
      }),
      fetcher,
      requestTimeoutMs,
    );
    if (!fetchedPlaylist.ok) return { status: "fallback", reason: fetchedPlaylist.reason };
    const fetchedItems = await fetchJson(
      dataApiUrl("playlistItems", {
        part: "snippet",
        playlistId: target.id,
        maxResults: "3",
        key: apiKey,
      }),
      fetcher,
      requestTimeoutMs,
    );
    if (!fetchedItems.ok) return { status: "fallback", reason: fetchedItems.reason };
    if (arrayValue(asRecord(fetchedItems.value)?.items).length === 0) {
      return { status: "fallback", reason: "empty_items" };
    }
    return normalizeYouTubePlaylistResponse(
      fetchedPlaylist.value,
      target.canonicalUrl,
      fetchedItems.value,
    );
  }

  if (target.kind === "channel") {
    const params: Record<string, string> = {
      part: "snippet,statistics",
      key: apiKey,
    };
    if (target.id) {
      params.id = target.id;
    } else if (target.handle) {
      params.forHandle = `@${target.handle}`;
    } else if (target.username) {
      params.forUsername = target.username;
    } else {
      return { status: "fallback", reason: "missing_channel_identifier" };
    }
    const fetched = await fetchJson(dataApiUrl("channels", params), fetcher, requestTimeoutMs);
    return fetched.ok ? normalizeYouTubeChannelResponse(fetched.value, target.canonicalUrl) : { status: "fallback", reason: fetched.reason };
  }

  return { status: "fallback", reason: "unsupported_target" };
}

async function fetchWithOEmbed(
  target: YouTubeReplyTarget,
  fetcher: (url: string, init?: RequestInit) => Promise<Response>,
  requestTimeoutMs: number,
): Promise<YouTubePreviewResult> {
  if (target.kind !== "video") return { status: "fallback", reason: "missing_api_key" };
  const fetched = await fetchJson(oembedUrl(target.canonicalUrl), fetcher, requestTimeoutMs);
  return fetched.ok ? normalizeYouTubeOEmbedResponse(fetched.value, target.canonicalUrl) : { status: "fallback", reason: fetched.reason };
}

export async function fetchYouTubePreview(
  target: YouTubeReplyTarget,
  options: YouTubePreviewBuildOptions = {},
): Promise<YouTubePreviewResult> {
  const fetcher = options.fetcher ?? fetch;
  const requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const now = options.nowMs?.() ?? Date.now();
  const cacheKey = `${target.kind}:${target.canonicalUrl}`;
  const cached = previewCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.result;
  if (cached) previewCache.delete(cacheKey);

  const apiKey = options.apiKey?.trim() ?? "";
  let result: YouTubePreviewResult;
  if (apiKey) {
    const dataApiResult = await fetchWithDataApi(target, apiKey, fetcher, requestTimeoutMs);
    if (target.kind === "video" && dataApiResult.status === "fallback") {
      const oembedResult = await fetchWithOEmbed(target, fetcher, requestTimeoutMs);
      result = oembedResult.status === "ok" ? oembedResult : dataApiResult;
    } else {
      result = dataApiResult;
    }
  } else {
    result = await fetchWithOEmbed(target, fetcher, requestTimeoutMs);
  }

  previewCache.set(cacheKey, {
    expiresAt: now + CACHE_TTL_MS,
    result,
  });
  return result;
}

function compactText(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function formatCount(value: number | undefined): string | null {
  return typeof value === "number" ? value.toLocaleString("ja-JP") : null;
}

function formatPublishedAt(value: string | undefined): string | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return `<t:${Math.floor(timestamp / 1000)}:D>`;
}

function formatDuration(value: string | undefined): string | null {
  if (!value) return null;
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(value);
  if (!match) return null;
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0) + days * 24;
  const minutes = Number(match[3] ?? 0);
  const seconds = Number(match[4] ?? 0);
  if (hours === 0 && minutes === 0 && seconds === 0 && days === 0) return null;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function kindLabel(preview: YouTubePreview): string {
  const base = preview.kind === "playlist"
    ? "プレイリスト"
    : preview.kind === "channel"
      ? "チャンネル"
      : "動画";
  const liveLabel = preview.liveBroadcastContent === "live"
    ? "ライブ"
    : preview.liveBroadcastContent === "upcoming"
      ? "配信予定"
      : null;
  return liveLabel ? `${base}・${liveLabel}` : base;
}

function buildBodyText(preview: YouTubePreview): string {
  const lines: string[] = [
    `**${preview.title}**`,
    kindLabel(preview),
  ];
  if (preview.channelTitle) {
    lines.push(`${preview.kind === "playlist" ? "所有者" : "投稿者"}: ${preview.channelTitle}`);
  }
  const description = preview.description ? compactText(preview.description, 300) : null;
  if (description) {
    lines.push("");
    lines.push(description);
  }
  const meta = [
    formatPublishedAt(preview.publishedAt) ? `公開日: ${formatPublishedAt(preview.publishedAt)}` : null,
    formatDuration(preview.duration) ? `再生時間: ${formatDuration(preview.duration)}` : null,
    formatCount(preview.viewCount) ? `再生数: ${formatCount(preview.viewCount)}` : null,
    formatCount(preview.subscriberCount) ? `登録者数: ${formatCount(preview.subscriberCount)}` : null,
    formatCount(preview.videoCount) ? `動画数: ${formatCount(preview.videoCount)}` : null,
    formatCount(preview.itemCount) ? `動画数: ${formatCount(preview.itemCount)}` : null,
  ].filter((part): part is string => Boolean(part));
  if (meta.length > 0) {
    lines.push("");
    lines.push(meta.join(" / "));
  }
  if (preview.sampleItems?.length) {
    lines.push("");
    lines.push(...preview.sampleItems.slice(0, 3).map((title) => `- ${compactText(title, 120)}`));
  }
  return lines.join("\n").slice(0, 4000);
}

function buildBodyComponent(preview: YouTubePreview, channelIconUrl: string | undefined): APITextDisplayComponent | APISectionComponent {
  const body: APITextDisplayComponent = {
    type: ComponentType.TextDisplay,
    content: buildBodyText(preview),
  };
  if (!channelIconUrl) return body;
  return {
    type: ComponentType.Section,
    components: [body],
    accessory: {
      type: ComponentType.Thumbnail,
      media: { url: channelIconUrl },
      description: `${preview.channelTitle ?? preview.title} icon`.slice(0, 1024),
    },
  };
}

function buildMediaGallery(mediaUrl: string | undefined, title: string): APIMediaGalleryComponent | null {
  if (!mediaUrl) return null;
  return {
    type: ComponentType.MediaGallery,
    items: [{
      media: { url: mediaUrl },
      description: `${title} thumbnail`.slice(0, 1024),
    }],
  };
}

function buildLinkRowBuilder(url: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>()
    .addComponents(
      new ButtonBuilder().setLabel("YouTubeで開く").setStyle(ButtonStyle.Link).setURL(url),
    );
}

function buildLinkRow(preview: YouTubePreview): APIActionRowComponent<APIButtonComponent> {
  return buildLinkRowBuilder(preview.url).toJSON() as APIActionRowComponent<APIButtonComponent>;
}

function isLikelyDirectVideoUrl(url: string, contentType: string | undefined): boolean {
  if (contentType?.toLowerCase().startsWith("video/")) return true;
  try {
    return /\.(?:mp4|m4v|webm|mov)(?:$|[?#])/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

export function getYouTubeNativeEmbedVideoUrl(embed: APIEmbed): string | undefined {
  const contentType = embed.video?.content_type;
  for (const candidate of [embed.video?.proxy_url, embed.video?.url]) {
    const url = safeHttpsUrl(candidate);
    if (url && isLikelyDirectVideoUrl(url, contentType)) return url;
  }
  return undefined;
}

export function buildYouTubeNativeEmbedPayload(
  embed: APIEmbed,
  fallbackUrl?: string,
  mediaUrlOverride?: string,
): YouTubePreviewPayload {
  const url = safeHttpsUrl(embed.url) ?? safeHttpsUrl(fallbackUrl) ?? "https://www.youtube.com";
  const mediaUrl = safeMediaGalleryUrl(mediaUrlOverride)
    ?? getYouTubeNativeEmbedVideoUrl(embed)
    ?? safeHttpsUrl(embed.image?.url)
    ?? safeHttpsUrl(embed.thumbnail?.url);
  const body = [
    embed.provider?.name,
    embed.author?.name ? `投稿者: ${embed.author.name}` : null,
    embed.description ? compactText(embed.description, 3500) : null,
  ].filter((line): line is string => Boolean(line)).join("\n");
  const card = new ComponentCardBuilder()
    .setTitle(compactText(embed.title ?? "YouTube", 256))
    .setURL(url)
    .setDescription(body || "YouTube動画");
  card.setImage(mediaUrl);
  card.setThumbnail(embed.author?.icon_url);
  return { ...componentCardsPayload([card], [buildLinkRowBuilder(url)]), allowedMentions: { parse: [], repliedUser: false } };
}

export function buildYouTubePreviewPayload(
  preview: YouTubePreview,
  options: YouTubePreviewPayloadOptions = {},
): YouTubePreviewPayload {
  if (options.fallback) {
    const gallery = buildMediaGallery(fallbackMediaUrl(options), preview.title);
    const container: APIContainerComponent = {
      type: ComponentType.Container,
      components: [
        { type: ComponentType.TextDisplay, content: buildBodyText(preview) },
        ...(gallery ? [gallery] : []),
        buildLinkRow(preview),
      ],
    };
    return {
      embeds: [],
      flags: MessageFlags.IsComponentsV2,
      components: [container],
      allowedMentions: { parse: [], repliedUser: false },
    };
  }
  const mediaUrl = safeMediaGalleryUrl(options.mediaUrl) ?? safeHttpsUrl(preview.thumbnailUrl);
  const channelIcon = safeHttpsUrl(preview.channelIconUrl);
  const gallery = buildMediaGallery(mediaUrl, preview.title);
  const components: APIComponentInContainer[] = [
    buildBodyComponent(preview, channelIcon),
    ...(gallery ? [gallery] : []),
    buildLinkRow(preview),
  ];
  const container: APIContainerComponent = {
    type: ComponentType.Container,
    components,
  };
  return {
    embeds: [],
    flags: MessageFlags.IsComponentsV2,
    components: [container],
    allowedMentions: { parse: [], repliedUser: false },
    ...(options.files?.length ? { files: options.files } : {}),
  };
}

export function replaceYouTubePreviewMedia(
  components: readonly unknown[],
  mediaUrl?: string,
  options: { fallback?: boolean } = {},
): APIMessageTopLevelComponent[] {
  const next = structuredClone(components) as Array<Record<string, unknown>>;
  const transformChildren = (children: unknown[]): Array<Record<string, unknown>> => children.flatMap((child) => {
    if (!child || typeof child !== "object") return [];
    const component = child as Record<string, unknown>;
    if (options.fallback && component.type === ComponentType.Section) {
      return Array.isArray(component.components) ? transformChildren(component.components) : [];
    }
    if (Array.isArray(component.components)) {
      component.components = transformChildren(component.components);
    }
    return [component];
  });
  const containers: Array<Record<string, unknown>> = [];
  const removeGalleries = (component: Record<string, unknown>): void => {
    if (!Array.isArray(component.components)) return;
    const children = transformChildren(component.components).filter((child) => child.type !== ComponentType.MediaGallery);
    component.components = children;
    if (component.type === ComponentType.Container) containers.push(component);
    for (const child of children) removeGalleries(child);
  };
  for (const component of next) removeGalleries(component);
  const container = containers[0];
  if (container && mediaUrl && Array.isArray(container.components)) {
    const children = container.components as Array<Record<string, unknown>>;
    const index = children.findIndex((child) => child.type === ComponentType.ActionRow);
    children.splice(index < 0 ? children.length : index, 0, buildMediaGallery(mediaUrl, "YouTube video")! as unknown as Record<string, unknown>);
  }
  return next as unknown as APIMessageTopLevelComponent[];
}

export function buildYouTubeFallbackReply(urls: readonly string[]): MessageCreateOptions {
  return {
    content: urls.join("\n"),
    allowedMentions: { parse: [], repliedUser: false },
  };
}

export function buildYouTubeComponentsOnlyFallbackPayload(url: string): YouTubePreviewPayload {
  const safeUrl = safeHttpsUrl(url) ?? "https://www.youtube.com";
  const card = new ComponentCardBuilder()
    .setTitle("YouTube動画")
    .setURL(safeUrl)
    .setDescription("動画プレビューを取得できませんでした。ボタンからYouTubeで開けます。");
  return {
    ...componentCardsPayload([card], [buildLinkRowBuilder(safeUrl)]),
    allowedMentions: { parse: [], repliedUser: false },
  };
}

function mediaResolverTargetUrl(target: YouTubeReplyTarget, preview: YouTubePreview): string | null {
  if (target.kind !== "video") return null;
  if (!["video", "oembed"].includes(preview.kind)) return null;
  const previewTarget = parseYouTubeUrl(preview.url);
  if (previewTarget?.kind === "video") return previewTarget.canonicalUrl;
  const canonicalTarget = parseYouTubeUrl(target.canonicalUrl);
  return canonicalTarget?.kind === "video" ? canonicalTarget.canonicalUrl : null;
}

async function resolvePreviewMediaUrl(
  target: YouTubeReplyTarget,
  preview: YouTubePreview,
  options: YouTubePreviewBuildOptions,
): Promise<ResolvedPreviewMedia | undefined> {
  const resolverTargetUrl = mediaResolverTargetUrl(target, preview);
  if (!resolverTargetUrl) return undefined;

  const mediaResolver = options.mediaResolver ?? resolveYouTubeVideoMedia;
  try {
    const mediaResult = await mediaResolver(resolverTargetUrl, {
      timeoutMs: options.requestTimeoutMs,
      maxBytes: options.attachmentSizeLimitBytes,
    });
    if (mediaResult.status === "ok") {
      const attachment = await downloadPreviewMediaAttachment(mediaResult.mediaUrl, options);
      if (attachment.status === "ok") {
        return {
          kind: "attachment",
          mediaUrl: `attachment://${MEDIA_ATTACHMENT_FILENAME}`,
          files: [attachment.file],
        };
      }
      if (attachment.reason === "media_too_large") {
        return {
          kind: "external",
          mediaUrl: mediaResult.mediaUrl,
        };
      }
      options.log?.warn?.(
        { url: resolverTargetUrl, mediaUrl: mediaResult.mediaUrl, reason: attachment.reason },
        "youtube preview media attachment fallback",
      );
      return undefined;
    }
    if (mediaResult.reason !== "disabled") {
      options.log?.warn?.(
        { url: resolverTargetUrl, reason: mediaResult.reason },
        "youtube preview media resolver fallback",
      );
    }
  } catch (err) {
    options.log?.warn?.(
      { err, url: resolverTargetUrl },
      "youtube preview media resolver error",
    );
  }
  return undefined;
}

async function downloadPreviewMediaAttachment(
  mediaUrl: string,
  options: YouTubePreviewBuildOptions,
): Promise<{ status: "ok"; file: AttachmentBuilder } | { status: "fallback"; reason: string }> {
  const url = safeHttpsUrl(mediaUrl);
  if (!url) return { status: "fallback", reason: "invalid_media_url" };

  const fetcher = options.fetcher ?? fetch;
  const requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const attachmentSizeLimitBytes = options.attachmentSizeLimitBytes ?? MEDIA_ATTACHMENT_MAX_BYTES;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetcher(url, {
      signal: controller.signal,
      headers: { Accept: "video/mp4,video/*;q=0.9,*/*;q=0.1" },
    });
    if (!response.ok) return { status: "fallback", reason: `http_${response.status}` };

    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (contentType && !contentType.startsWith("video/")) {
      return { status: "fallback", reason: "invalid_content_type" };
    }

    const contentLength = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(contentLength) && contentLength > attachmentSizeLimitBytes) {
      await response.body?.cancel().catch(() => undefined);
      return { status: "fallback", reason: "media_too_large" };
    }

    const reader = response.body?.getReader();
    if (!reader) {
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength > attachmentSizeLimitBytes) return { status: "fallback", reason: "media_too_large" };
      return { status: "ok", file: new AttachmentBuilder(buffer, { name: MEDIA_ATTACHMENT_FILENAME }) };
    }

    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > attachmentSizeLimitBytes) {
        await reader.cancel().catch(() => undefined);
        return { status: "fallback", reason: "media_too_large" };
      }
      chunks.push(Buffer.from(value));
    }
    return { status: "ok", file: new AttachmentBuilder(Buffer.concat(chunks), { name: MEDIA_ATTACHMENT_FILENAME }) };
  } catch (err) {
    const reason = err instanceof Error && err.name === "AbortError" ? "timeout" : "download_error";
    return { status: "fallback", reason };
  } finally {
    clearTimeout(timer);
  }
}

export async function buildYouTubeReplyPayloads(
  targets: readonly YouTubeReplyTarget[],
  options: YouTubePreviewBuildOptions = {},
): Promise<MessageCreateOptions[]> {
  return await Promise.all(targets.map(async (target): Promise<MessageCreateOptions> => {
    if (target.kind === "fallback") {
      return options.componentsOnly
        ? buildYouTubeComponentsOnlyFallbackPayload(target.canonicalUrl)
        : buildYouTubeFallbackReply([target.canonicalUrl]);
    }
    const result = await fetchYouTubePreview(target, options);
    if (result.status === "ok") {
      if (options.mediaMode) {
        return buildYouTubePreviewPayload(result.preview, {
          fallback: true,
          mediaMode: options.mediaMode,
          mediaUrl: options.mediaUrlOverride,
        });
      }
      const mediaUrlOverride = safeMediaGalleryUrl(options.mediaUrlOverride);
      const media = mediaUrlOverride
        ? { kind: "external" as const, mediaUrl: mediaUrlOverride }
        : await resolvePreviewMediaUrl(target, result.preview, options);
      return buildYouTubePreviewPayload(
        result.preview,
        media ? { mediaUrl: media.mediaUrl, files: media.files } : {},
      );
    }
    return options.componentsOnly
      ? buildYouTubeComponentsOnlyFallbackPayload(target.canonicalUrl)
      : buildYouTubeFallbackReply([target.canonicalUrl]);
  }));
}
