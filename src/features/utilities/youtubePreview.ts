import { URL } from "node:url";

const TRIM_TAIL_CHARS = ".,!?;:)]}>,、。」』）";
const REQUEST_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 30 * 60 * 1000;
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

export type YouTubePreviewBuildOptions = {
  fetcher?: (url: string, init?: RequestInit) => Promise<Response>;
  apiKey?: string;
  requestTimeoutMs?: number;
  nowMs?: () => number;
};

type CacheEntry = {
  expiresAt: number;
  result: YouTubePreviewResult;
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
    return fetched.ok ? normalizeYouTubeVideoResponse(fetched.value, target.canonicalUrl) : { status: "fallback", reason: fetched.reason };
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
  const result = apiKey
    ? await fetchWithDataApi(target, apiKey, fetcher, requestTimeoutMs)
    : await fetchWithOEmbed(target, fetcher, requestTimeoutMs);

  previewCache.set(cacheKey, {
    expiresAt: now + CACHE_TTL_MS,
    result,
  });
  return result;
}
