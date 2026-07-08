import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { URL } from "node:url";
import { parseYouTubeUrl } from "./youtubePreview.js";

const execFile = promisify(execFileCallback);
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const CACHE_TTL_MS = 5 * 60 * 1000;

type YtDlpFormat = {
  url?: unknown;
  ext?: unknown;
  vcodec?: unknown;
  acodec?: unknown;
  height?: unknown;
  tbr?: unknown;
  filesize?: unknown;
};

type CacheEntry = {
  expiresAt: number;
  result: ResolveYouTubeVideoMediaResult;
};

export type YtDlpRunner = (
  command: string,
  args: readonly string[],
  options: { timeoutMs: number; maxBuffer: number },
) => Promise<{ stdout: string }>;

export type ResolveYouTubeVideoMediaOptions = {
  enabled?: boolean;
  ytdlpPath?: string;
  timeoutMs?: number;
  nowMs?: () => number;
  runner?: YtDlpRunner;
};

export type ResolveYouTubeVideoMediaResult =
  | { status: "ok"; mediaUrl: string }
  | { status: "fallback"; reason: string };

const cache = new Map<string, CacheEntry>();

function stripTrailingUrlPunctuation(urlText: string): string {
  let out = urlText.trim();
  while (/[).,!?;:\]}>'"、。・]$/.test(out)) {
    out = out.slice(0, -1);
  }
  return out;
}

function canonicalizeYouTubeVideoUrl(urlText: string): string | null {
  const parsedTarget = parseYouTubeUrl(stripTrailingUrlPunctuation(urlText));
  if (!parsedTarget || parsedTarget.kind !== "video") return null;
  try {
    const parsed = new URL(parsedTarget.originalUrl);
    if (parsed.protocol !== "https:") return null;
    return parsedTarget.canonicalUrl;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
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

function formatScore(format: YtDlpFormat): number | null {
  const height = numberValue(format.height);
  if (height === null) return null;
  if (height > 720) return null;
  if (stringValue(format.ext) !== "mp4") return null;
  const vcodec = stringValue(format.vcodec);
  const acodec = stringValue(format.acodec);
  if (!vcodec || !acodec) return null;
  if (vcodec === "none" || acodec === "none") return null;
  const url = stringValue(format.url);
  if (!url || !url.startsWith("https:")) return null;
  if (url.toLowerCase().includes(".m3u8")) return null;
  return height;
}

function compareFormats(a: YtDlpFormat, b: YtDlpFormat): number {
  const aHeight = numberValue(a.height) ?? 0;
  const bHeight = numberValue(b.height) ?? 0;
  if (aHeight !== bHeight) return bHeight - aHeight;

  const aTbr = numberValue(a.tbr) ?? 0;
  const bTbr = numberValue(b.tbr) ?? 0;
  if (aTbr !== bTbr) return bTbr - aTbr;

  const aSize = numberValue(a.filesize) ?? 0;
  const bSize = numberValue(b.filesize) ?? 0;
  if (aSize !== bSize) return bSize - aSize;

  return 0;
}

function selectMediaUrl(raw: unknown): string | null {
  const formats = asArray(asRecord(raw)?.formats).filter((format): format is YtDlpFormat => Boolean(asRecord(format)));
  const candidates = formats
    .filter((format) => formatScore(format) !== null)
    .sort(compareFormats);
  const best = candidates[0];
  return best ? stringValue(best.url) : null;
}

function makeCacheKey(canonicalUrl: string): string {
  return canonicalUrl;
}

function isTimeoutError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const record = err as { code?: unknown; name?: unknown; message?: unknown; killed?: unknown };
  return record.code === "ETIMEDOUT"
    || record.code === "ERR_CHILD_PROCESS_TIMEOUT"
    || record.name === "AbortError"
    || record.killed === true
    || (typeof record.message === "string" && record.message.toLowerCase().includes("timeout"));
}

async function runYtDlp(
  command: string,
  args: readonly string[],
  options: { timeoutMs: number; maxBuffer: number },
): Promise<{ stdout: string }> {
  const result = await execFile(command, args, {
    timeout: options.timeoutMs,
    maxBuffer: options.maxBuffer,
    windowsHide: true,
  });
  return { stdout: result.stdout };
}

export async function resolveYouTubeVideoMedia(
  url: string,
  options: ResolveYouTubeVideoMediaOptions = {},
): Promise<ResolveYouTubeVideoMediaResult> {
  if (options.enabled === false) return { status: "fallback", reason: "disabled" };

  const canonicalUrl = canonicalizeYouTubeVideoUrl(url);
  if (!canonicalUrl) return { status: "fallback", reason: "invalid_url" };

  const now = options.nowMs?.() ?? Date.now();
  const cached = cache.get(makeCacheKey(canonicalUrl));
  if (cached && cached.expiresAt > now) return cached.result;
  if (cached) cache.delete(makeCacheKey(canonicalUrl));

  const runner = options.runner ?? runYtDlp;
  const command = options.ytdlpPath?.trim() || "yt-dlp";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let result: ResolveYouTubeVideoMediaResult;
  try {
    const response = await runner(command, [
      "--dump-single-json",
      "--no-playlist",
      "--skip-download",
      "--no-warnings",
      canonicalUrl,
    ], {
      timeoutMs,
      maxBuffer: MAX_BUFFER_BYTES,
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.stdout) as unknown;
    } catch {
      result = { status: "fallback", reason: "invalid_json" };
      cache.set(makeCacheKey(canonicalUrl), { expiresAt: now + CACHE_TTL_MS, result });
      return result;
    }
    const mediaUrl = selectMediaUrl(parsed);
    if (!mediaUrl) {
      result = { status: "fallback", reason: "no_suitable_format" };
    } else {
      result = { status: "ok", mediaUrl };
    }
  } catch (err) {
    const reason = isTimeoutError(err) ? "timeout" : "cli_error";
    result = { status: "fallback", reason };
  }

  cache.set(makeCacheKey(canonicalUrl), { expiresAt: now + CACHE_TTL_MS, result });
  return result;
}
