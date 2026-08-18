import { ClientType, Innertube, Platform } from "youtubei.js";
import type { Types } from "youtubei.js";
import { setTimeout as delay } from "node:timers/promises";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const CACHE_TTL_MS = 5 * 60 * 1000;
const QUALITY_ORDER = ["720p", "480p", "360p", "240p", "144p"] as const;
const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"]);
const YOUTU_BE_HOSTS = new Set(["youtu.be", "www.youtu.be"]);

export type YouTubeStreamingRequest = {
  type: "video+audio";
  format: "mp4";
  quality: string;
};

export type YouTubeStreamingFormat = {
  url?: string;
  mime_type?: string;
  height?: number;
  has_audio?: boolean;
  has_video?: boolean;
  content_length?: number;
};

export type YouTubeStreamingClient = {
  getStreamingData: (
    videoId: string,
    options: YouTubeStreamingRequest,
  ) => Promise<YouTubeStreamingFormat>;
};

export type YouTubeClientFactory = () => Promise<YouTubeStreamingClient>;

export type ResolveYouTubeVideoMediaOptions = {
  timeoutMs?: number;
  maxBytes?: number;
  nowMs?: () => number;
  clientFactory?: YouTubeClientFactory;
  bypassCache?: boolean;
};

export type ResolveYouTubeVideoMediaResult =
  | { status: "ok"; mediaUrl: string }
  | { status: "fallback"; reason: string };

type CacheEntry = {
  expiresAt: number;
  result: ResolveYouTubeVideoMediaResult;
};

const cache = new Map<string, CacheEntry>();
let defaultClientPromise: Promise<YouTubeStreamingClient> | undefined;
let evaluatorInstalled = false;

function stripTrailingUrlPunctuation(urlText: string): string {
  let out = urlText.trim();
  while (/[).,!?;:\]}>'"、。・]$/.test(out)) {
    out = out.slice(0, -1);
  }
  return out;
}

function extractYouTubeVideoId(urlText: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(stripTrailingUrlPunctuation(urlText));
  } catch {
    return null;
  }

  if (parsed.protocol !== "https:") return null;
  const host = parsed.hostname.toLowerCase();
  if (YOUTU_BE_HOSTS.has(host)) {
    const id = parsed.pathname.split("/").filter(Boolean)[0];
    return id || null;
  }
  if (!YOUTUBE_HOSTS.has(host)) return null;

  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts[0] === "watch") return parsed.searchParams.get("v") || null;
  if (["shorts", "live", "embed", "v"].includes(parts[0] ?? "")) return parts[1] || null;
  return null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function installJavaScriptEvaluator(): void {
  if (evaluatorInstalled) return;

  Platform.shim.eval = (data: Types.BuildScriptResult, env: Record<string, Types.VMPrimative>) => {
    const argumentNames = Object.keys(env);
    const evaluate = new Function(...argumentNames, data.output) as (...values: unknown[]) => unknown;
    return evaluate(...Object.values(env)) as Record<string, unknown> | undefined;
  };
  evaluatorInstalled = true;
}

async function createDefaultClient(): Promise<YouTubeStreamingClient> {
  installJavaScriptEvaluator();
  return await Innertube.create({
    lang: "ja",
    location: "JP",
    client_type: ClientType.ANDROID,
  });
}

async function getDefaultClient(): Promise<YouTubeStreamingClient> {
  defaultClientPromise ??= createDefaultClient();
  try {
    return await defaultClientPromise;
  } catch (err) {
    defaultClientPromise = undefined;
    throw err;
  }
}

function makeCacheKey(videoId: string, maxBytes: number): string {
  return `${videoId}:${maxBytes}`;
}

class TimeoutError extends Error {
  constructor() {
    super("YouTube InnerTube request timed out");
    this.name = "TimeoutError";
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    delay(timeoutMs, undefined, { ref: false }).then(() => { throw new TimeoutError(); }),
  ]);
}

function isTimeoutError(err: unknown): boolean {
  return err instanceof TimeoutError
    || (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError"));
}

function isSuitableFormat(format: YouTubeStreamingFormat, maxBytes: number): format is YouTubeStreamingFormat & { url: string } {
  const url = stringValue(format.url);
  if (!url || !url.startsWith("https:") || url.toLowerCase().includes(".m3u8")) return false;
  const mimeType = stringValue(format.mime_type)?.toLowerCase() ?? "";
  if (!mimeType.startsWith("video/mp4")) return false;
  if (format.has_video !== true || format.has_audio !== true) return false;
  const height = numberValue(format.height);
  if (height === null || height > 720) return false;
  const contentLength = numberValue(format.content_length);
  if (contentLength !== null && contentLength > maxBytes) return false;
  return true;
}

function makeCacheResult(
  cacheKey: string,
  now: number,
  result: ResolveYouTubeVideoMediaResult,
): ResolveYouTubeVideoMediaResult {
  cache.set(cacheKey, { expiresAt: now + CACHE_TTL_MS, result });
  return result;
}

export async function resolveYouTubeVideoMedia(
  url: string,
  options: ResolveYouTubeVideoMediaOptions = {},
): Promise<ResolveYouTubeVideoMediaResult> {
  const videoId = extractYouTubeVideoId(url);
  if (!videoId) return { status: "fallback", reason: "invalid_url" };

  const now = options.nowMs?.() ?? Date.now();
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const cacheKey = makeCacheKey(videoId, maxBytes);
  const cached = cache.get(cacheKey);
  if (!options.bypassCache && cached && cached.expiresAt > now) return cached.result;
  if (cached) cache.delete(cacheKey);

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  let client: YouTubeStreamingClient;
  try {
    const factory = options.clientFactory ?? getDefaultClient;
    client = await withTimeout(factory(), Math.max(1, deadline - Date.now()));
  } catch (err) {
    return makeCacheResult(cacheKey, now, {
      status: "fallback",
      reason: isTimeoutError(err) ? "timeout" : "inner_tube_error",
    });
  }

  let sawFormat = false;
  let lastError: unknown;
  for (const quality of QUALITY_ORDER) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return makeCacheResult(cacheKey, now, { status: "fallback", reason: "timeout" });
    }

    try {
      const format = await withTimeout(client.getStreamingData(videoId, {
        type: "video+audio",
        format: "mp4",
        quality,
      }), remainingMs);
      sawFormat = true;
      if (isSuitableFormat(format, maxBytes)) {
        return makeCacheResult(cacheKey, now, { status: "ok", mediaUrl: format.url });
      }
    } catch (err) {
      if (isTimeoutError(err)) {
        return makeCacheResult(cacheKey, now, { status: "fallback", reason: "timeout" });
      }
      lastError = err;
    }
  }

  return makeCacheResult(cacheKey, now, {
    status: "fallback",
    reason: sawFormat || !lastError ? "no_suitable_format" : "inner_tube_error",
  });
}

export function isGoogleVideoMediaUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    return parsed.protocol === "https:"
      && (host === "googlevideo.com" || host.endsWith(".googlevideo.com"));
  } catch {
    return false;
  }
}

export async function resolveYouTubeVideoMediaWithRetry(
  url: string,
  options: ResolveYouTubeVideoMediaOptions = {},
  deps: {
    resolver?: typeof resolveYouTubeVideoMedia;
    wait?: (delayMs: number) => Promise<void>;
  } = {},
): Promise<ResolveYouTubeVideoMediaResult> {
  const resolver = deps.resolver ?? resolveYouTubeVideoMedia;
  const wait = deps.wait ?? ((delayMs) => delay(delayMs));
  let lastResult: ResolveYouTubeVideoMediaResult = { status: "fallback", reason: "inner_tube_error" };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await resolver(url, attempt === 0 ? options : { ...options, bypassCache: true });
      lastResult = result.status === "ok" && !isGoogleVideoMediaUrl(result.mediaUrl)
        ? { status: "fallback", reason: "invalid_google_url" }
        : result;
      if (lastResult.status === "ok") return lastResult;
    } catch {
      lastResult = { status: "fallback", reason: "inner_tube_error" };
    }
    if (attempt === 0) await wait(500);
  }
  return lastResult;
}
