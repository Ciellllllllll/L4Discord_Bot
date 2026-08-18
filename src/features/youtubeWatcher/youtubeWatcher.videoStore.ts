import { constants, createWriteStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { access, mkdir, open, readdir, rename, rm, stat, statfs as nodeStatfs } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { resolveYouTubeVideoMedia } from "../utilities/youtubeVideoMedia.js";

export type PersistedYouTubeVideo =
  | { status: "cached"; mediaUrl: string; evictedVideoIds: string[] }
  | { status: "fallback"; reason: string; googleVideoUrl?: string; evictedVideoIds: string[] };

export type YouTubeVideoCacheFile = {
  videoId: string;
  size: number;
  mtimeMs: number;
};

type StatFsResult = { bavail: number | bigint; bsize: number | bigint };

export type PersistYouTubeVideoOptions = {
  directory: string;
  publicBaseUrl: string;
  timeoutMs: number;
  minFreeBytes: number;
  cacheMaxBytes?: number;
  retentionDays?: number;
  now?: () => number;
  moveFile?: (fromPath: string, toPath: string) => Promise<void>;
  removeFile?: (path: string) => Promise<void>;
  commitEviction?: (markerPath: string) => Promise<void>;
  fetcher?: typeof fetch;
  mediaResolver?: typeof resolveYouTubeVideoMedia;
  statfs?: (path: string) => Promise<StatFsResult>;
};

export type YouTubeVideoCacheCleanupOptions = Pick<
  PersistYouTubeVideoOptions,
  "directory" | "cacheMaxBytes" | "retentionDays" | "now" | "moveFile" | "removeFile" | "commitEviction"
>;

const DEFAULT_CACHE_MAX_BYTES = 20 * 1024 * 1024 * 1024;
const DEFAULT_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const STALE_PART_MS = 60 * 60 * 1000;

export function planYouTubeVideoCacheCleanup(
  files: readonly YouTubeVideoCacheFile[],
  options: { nowMs: number; retentionDays: number; maxBytes: number; incomingBytes: number },
): { canStore: boolean; evictedVideoIds: string[] } {
  const expiryMs = options.nowMs - options.retentionDays * DAY_MS;
  const expired = files.filter((file) => file.mtimeMs <= expiryMs);
  const retained = files.filter((file) => file.mtimeMs > expiryMs);
  if (options.incomingBytes > options.maxBytes) {
    return { canStore: false, evictedVideoIds: expired.map((file) => file.videoId) };
  }

  let totalBytes = retained.reduce((total, file) => total + file.size, options.incomingBytes);
  const evictedVideoIds = expired.map((file) => file.videoId);
  for (const file of [...retained].sort((a, b) => a.mtimeMs - b.mtimeMs || a.videoId.localeCompare(b.videoId))) {
    if (totalBytes <= options.maxBytes) break;
    totalBytes -= file.size;
    evictedVideoIds.push(file.videoId);
  }
  return { canStore: totalBytes <= options.maxBytes, evictedVideoIds };
}

export function youtubeVideoPublicUrl(baseUrl: string, videoId: string): string | null {
  try {
    const base = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
    if (base.protocol !== "https:") return null;
    return new URL(`${encodeURIComponent(videoId)}.mp4`, base).toString();
  } catch {
    return null;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

type CachedFile = YouTubeVideoCacheFile & { path: string };

async function readCachedVideos(directory: string): Promise<CachedFile[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    if (!entry.isFile() || !entry.name.endsWith(".mp4")) return null;
    const path = join(directory, entry.name);
    const metadata = await stat(path).catch(() => null);
    if (!metadata?.isFile()) return null;
    return { videoId: entry.name.slice(0, -4), size: metadata.size, mtimeMs: metadata.mtimeMs, path };
  }));
  return files.filter((file): file is CachedFile => file !== null);
}

async function removeStaleParts(directory: string, nowMs: number): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isFile() || !entry.name.endsWith(".part")) return;
    const path = join(directory, entry.name);
    const metadata = await stat(path).catch(() => null);
    if (metadata?.isFile() && metadata.mtimeMs <= nowMs - STALE_PART_MS) {
      await rm(path, { force: true });
    }
  }));
}

async function createEvictionMarker(markerPath: string): Promise<void> {
  const marker = await open(markerPath, "wx");
  await marker.close();
}

const restoreName = /^\.restore-([0-9a-f-]{36})-(.+)$/;
const markerName = /^\.eviction-([0-9a-f-]{36})\.committed$/;

async function recoverEvictions(
  directory: string,
  moveFile: (fromPath: string, toPath: string) => Promise<void>,
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  const committed = new Set(entries.flatMap((entry) => {
    const match = entry.isFile() ? markerName.exec(entry.name) : null;
    return match ? [match[1]] : [];
  }));
  await Promise.all(entries.map(async (entry) => {
    const match = entry.isFile() ? restoreName.exec(entry.name) : null;
    if (!match) return;
    const stagedPath = join(directory, entry.name);
    if (committed.has(match[1])) {
      await rm(stagedPath, { force: true }).catch(() => undefined);
      return;
    }
    const originalPath = join(directory, `${match[2]}.mp4`);
    if (await pathExists(originalPath)) {
      await rm(stagedPath, { force: true }).catch(() => undefined);
    } else {
      await moveFile(stagedPath, originalPath).catch(() => undefined);
    }
  }));
  const remaining = await readdir(directory);
  await Promise.all([...committed].map(async (token) => {
    if (!remaining.some((name) => name.startsWith(`.restore-${token}-`))) {
      await rm(join(directory, `.eviction-${token}.committed`), { force: true }).catch(() => undefined);
    }
  }));
}

async function evictVideos(
  files: readonly CachedFile[],
  videoIds: readonly string[],
  moveFile: (fromPath: string, toPath: string) => Promise<void> = rename,
  removeFile: (path: string) => Promise<void> = (path) => rm(path, { force: true }),
  commitEviction: (markerPath: string) => Promise<void> = createEvictionMarker,
): Promise<string[]> {
  const pathsByVideoId = new Map(files.map((file) => [file.videoId, file.path]));
  const staged: Array<{ originalPath: string; stagedPath: string }> = [];
  const token = randomUUID();
  for (const videoId of videoIds) {
    const originalPath = pathsByVideoId.get(videoId);
    if (!originalPath) continue;
    const stagedPath = join(dirname(originalPath), `.restore-${token}-${videoId}`);
    try {
      await moveFile(originalPath, stagedPath);
      staged.push({ originalPath, stagedPath });
    } catch (error) {
      await Promise.all(staged.reverse().map(({ originalPath: rollbackPath, stagedPath: rollbackStagedPath }) =>
        moveFile(rollbackStagedPath, rollbackPath).catch(() => undefined),
      ));
      throw error;
    }
  }
  if (staged.length === 0) return [];
  const markerPath = join(dirname(staged[0].originalPath), `.eviction-${token}.committed`);
  try {
    await commitEviction(markerPath);
  } catch (error) {
    await Promise.all(staged.reverse().map(({ originalPath, stagedPath }) =>
      moveFile(stagedPath, originalPath).catch(() => undefined),
    ));
    throw error;
  }
  const removed = await Promise.all(staged.map(async ({ stagedPath }) => {
    try {
      await removeFile(stagedPath);
      return true;
    } catch {
      return false;
    }
  }));
  if (removed.every(Boolean)) await rm(markerPath, { force: true }).catch(() => undefined);
  return videoIds.filter((videoId) => pathsByVideoId.has(videoId));
}

export async function cleanupYouTubeVideoCache(
  options: YouTubeVideoCacheCleanupOptions,
): Promise<{ evictedVideoIds: string[] }> {
  const nowMs = options.now?.() ?? Date.now();
  const cacheMaxBytes = options.cacheMaxBytes ?? DEFAULT_CACHE_MAX_BYTES;
  const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const moveFile = options.moveFile ?? rename;
  await mkdir(options.directory, { recursive: true });
  await recoverEvictions(options.directory, moveFile);
  await removeStaleParts(options.directory, nowMs);
  const files = await readCachedVideos(options.directory);
  const plan = planYouTubeVideoCacheCleanup(files, {
    nowMs,
    retentionDays,
    maxBytes: cacheMaxBytes,
    incomingBytes: 0,
  });
  return {
    evictedVideoIds: await evictVideos(
      files,
      plan.evictedVideoIds,
      moveFile,
      options.removeFile,
      options.commitEviction,
    ),
  };
}

function fallback(reason: string, evictedVideoIds: string[], googleVideoUrl?: string): PersistedYouTubeVideo {
  return { status: "fallback", reason, ...(googleVideoUrl ? { googleVideoUrl } : {}), evictedVideoIds };
}

function isMp4ContentType(contentType: string | null): boolean {
  return contentType?.split(";", 1)[0].trim().toLowerCase() === "video/mp4";
}

async function fetchWithTimeout(
  fetcher: typeof fetch,
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  return fetcher(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

async function verifyPublicVideo(
  mediaUrl: string,
  fetcher: typeof fetch,
  timeoutMs: number,
  expectedSize: number,
): Promise<{ status: "cached"; mediaUrl: string } | { status: "fallback"; reason: string }> {
  let head: Response;
  try {
    head = await fetchWithTimeout(fetcher, mediaUrl, { method: "HEAD" }, timeoutMs);
  } catch {
    return { status: "fallback", reason: "public_unavailable" };
  }
  if (!head.ok) return { status: "fallback", reason: `public_http_${head.status}` };
  if (!isMp4ContentType(head.headers.get("content-type"))) {
    return { status: "fallback", reason: "invalid_public_content_type" };
  }
  if (head.headers.get("accept-ranges")?.toLowerCase() !== "bytes") {
    return { status: "fallback", reason: "public_byte_ranges_unavailable" };
  }
  let range: Response;
  try {
    range = await fetchWithTimeout(fetcher, mediaUrl, { headers: { Range: "bytes=0-0" } }, timeoutMs);
  } catch {
    return { status: "fallback", reason: "public_range_unavailable" };
  }
  if (range.status !== 206) return { status: "fallback", reason: `public_range_http_${range.status}` };
  if (!isMp4ContentType(range.headers.get("content-type"))) {
    return { status: "fallback", reason: "invalid_public_content_type" };
  }
  const match = /^bytes 0-0\/([1-9]\d*)$/i.exec(range.headers.get("content-range")?.trim() ?? "");
  const total = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(total) || total <= 0) {
    return { status: "fallback", reason: "invalid_public_content_range" };
  }
  if (total !== expectedSize) return { status: "fallback", reason: "public_size_mismatch" };
  return { status: "cached", mediaUrl };
}

export async function persistYouTubeVideo(
  input: { videoId: string; videoUrl: string },
  options: PersistYouTubeVideoOptions,
): Promise<PersistedYouTubeVideo> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(input.videoId)) {
    return fallback("invalid_video_id", []);
  }
  const mediaUrl = youtubeVideoPublicUrl(options.publicBaseUrl, input.videoId);
  if (!mediaUrl) return fallback("invalid_public_base_url", []);

  const fetcher = options.fetcher ?? fetch;
  const finalPath = join(options.directory, `${input.videoId}.mp4`);
  const partPath = `${finalPath}.part`;
  const nowMs = options.now?.() ?? Date.now();
  const cacheMaxBytes = options.cacheMaxBytes ?? DEFAULT_CACHE_MAX_BYTES;
  const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const moveFile = options.moveFile ?? rename;
  const initialCleanup = await cleanupYouTubeVideoCache({
    directory: options.directory,
    // 保存前は保持期限・中断残骸だけを整理する。容量evictionは新規動画の
    // 公開確認後に限り、失敗した保存で既存動画を失わないようにする。
    cacheMaxBytes: Number.MAX_SAFE_INTEGER,
    retentionDays,
    now: () => nowMs,
    moveFile,
    removeFile: options.removeFile,
    commitEviction: options.commitEviction,
  });
  const evictedVideoIds = initialCleanup.evictedVideoIds;
  if (await pathExists(finalPath)) {
    const verified = await verifyPublicVideo(mediaUrl, fetcher, options.timeoutMs, (await stat(finalPath)).size);
    if (verified.status === "cached") return { ...verified, evictedVideoIds };
    const resolver = options.mediaResolver ?? resolveYouTubeVideoMedia;
    const resolved = await resolver(input.videoUrl, {
      timeoutMs: options.timeoutMs,
      maxBytes: Number.MAX_SAFE_INTEGER,
    });
    return resolved.status === "ok"
      ? fallback(verified.reason, evictedVideoIds, resolved.mediaUrl)
      : fallback(verified.reason, evictedVideoIds);
  }

  const resolver = options.mediaResolver ?? resolveYouTubeVideoMedia;
  const resolved = await resolver(input.videoUrl, {
    timeoutMs: options.timeoutMs,
    maxBytes: Number.MAX_SAFE_INTEGER,
  });
  if (resolved.status !== "ok") {
    return fallback(`media_resolver_${resolved.reason}`, evictedVideoIds);
  }

  const downloadSignal = AbortSignal.timeout(options.timeoutMs);
  let response: Response;
  try {
    response = await fetcher(resolved.mediaUrl, {
      headers: { Accept: "video/mp4,video/*;q=0.9,*/*;q=0.1" },
      signal: downloadSignal,
    });
  } catch {
    return fallback("download_error", evictedVideoIds, resolved.mediaUrl);
  }
  const cancelDownload = async (): Promise<void> => {
    await response.body?.cancel().catch(() => undefined);
  };
  if (!response.ok) {
    await cancelDownload();
    return fallback(`source_http_${response.status}`, evictedVideoIds, resolved.mediaUrl);
  }
  if (!isMp4ContentType(response.headers.get("content-type"))) {
    await cancelDownload();
    return fallback("invalid_source_content_type", evictedVideoIds, resolved.mediaUrl);
  }
  const contentLength = Number(response.headers.get("content-length"));
  if (!Number.isSafeInteger(contentLength) || contentLength <= 0) {
    await cancelDownload();
    return fallback("missing_source_content_length", evictedVideoIds, resolved.mediaUrl);
  }
  if (!response.body) {
    return fallback("missing_source_body", evictedVideoIds, resolved.mediaUrl);
  }

  const cachedFiles = await readCachedVideos(options.directory);
  const capacityPlan = planYouTubeVideoCacheCleanup(cachedFiles, {
    nowMs,
    retentionDays,
    maxBytes: cacheMaxBytes,
    incomingBytes: contentLength,
  });
  if (!capacityPlan.canStore) {
    await cancelDownload();
    return fallback("video_exceeds_cache_capacity", evictedVideoIds, resolved.mediaUrl);
  }

  const getStatFs = options.statfs ?? nodeStatfs;
  const disk = await getStatFs(options.directory);
  const freeBytes = Number(disk.bavail) * Number(disk.bsize);
  if (!Number.isFinite(freeBytes) || freeBytes < contentLength + options.minFreeBytes) {
    await cancelDownload();
    return fallback("insufficient_disk_space", evictedVideoIds, resolved.mediaUrl);
  }

  await rm(partPath, { force: true });
  try {
    let receivedBytes = 0;
    const enforceContentLength = new Transform({
      transform(chunk, _encoding, callback) {
        receivedBytes += Buffer.byteLength(chunk);
        callback(receivedBytes > contentLength ? new Error("source exceeds content-length") : null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(response.body as never),
      enforceContentLength,
      createWriteStream(partPath, { flags: "wx" }),
      { signal: downloadSignal },
    );
    if ((await stat(partPath)).size !== contentLength) {
      return fallback("incomplete_download", evictedVideoIds, resolved.mediaUrl);
    }
    await rename(partPath, finalPath);
  } catch {
    return fallback("download_error", evictedVideoIds, resolved.mediaUrl);
  } finally {
    await rm(partPath, { force: true }).catch(() => undefined);
  }

  const localSize = (await stat(finalPath)).size;
  const verified = await verifyPublicVideo(mediaUrl, fetcher, options.timeoutMs, localSize);
  if (verified.status === "cached") {
    try {
      evictedVideoIds.push(...await evictVideos(
        cachedFiles,
        capacityPlan.evictedVideoIds,
        moveFile,
        options.removeFile,
        options.commitEviction,
      ));
      return { ...verified, evictedVideoIds };
    } catch {
      await rm(finalPath, { force: true }).catch(() => undefined);
      return fallback("cache_eviction_error", evictedVideoIds, resolved.mediaUrl);
    }
  }
  await rm(finalPath, { force: true }).catch(() => undefined);
  return fallback(verified.reason, evictedVideoIds, resolved.mediaUrl);
}
