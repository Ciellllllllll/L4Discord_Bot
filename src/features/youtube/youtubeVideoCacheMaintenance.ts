import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { MessageFlags } from "discord.js";
import type { CoreDeps } from "../../core/deps.js";
import { isDiscordMissingResourceError as isUnknownDiscordResourceError } from "../../core/discordErrors.js";
import { replacePreviewMedia } from "../../core/previewMedia.js";
import {
  isGoogleVideoMediaUrl as isGoogleVideoUrl,
  resolveYouTubeVideoMediaWithRetry,
} from "./youtubeVideoMedia.js";
import { cleanupYouTubeVideoCache } from "./youtubeWatcher.videoStore.js";
import { PostgresYouTubeVideoCacheRepository, YOUTUBE_GOOGLEVIDEO_PENDING_PREFIX, youtubeGoogleVideoPendingError, type YouTubeVideoCacheMediaMode, type YouTubeVideoCacheReference } from "./youtubeVideoCache.repository.js";
import type {
  CacheReferenceRepository,
  EditableMessage,
  MaintenanceDependencies,
  YouTubeVideoCacheMaintenanceController,
} from "./youtubeVideoCacheTypes.js";

// YouTube 動画キャッシュの定期メンテナンス (取得・修復)。
export type { YouTubeVideoCacheMaintenanceController } from "./youtubeVideoCacheTypes.js";

export class YouTubeVideoCacheReferenceRecoveryError extends Error {
  constructor(readonly messageDeleted: boolean, cause: unknown) {
    super("youtube video cache reference recovery failed");
    this.name = "YouTubeVideoCacheReferenceRecoveryError";
    this.cause = cause;
  }
}

export type YouTubeVideoCachePostMaintenance = Pick<
  ReturnType<typeof createYouTubeVideoCacheMaintenanceService>,
  "fallbackVideos" | "restoreCachedVideo"
>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createYouTubeVideoCacheMaintenanceForContext(
  ctx: Pick<CoreDeps, "config" | "log" | "client" | "mainPgPool">,
) {
  const repo = new PostgresYouTubeVideoCacheRepository(ctx.mainPgPool);
  return createYouTubeVideoCacheMaintenanceService({
    repo,
    client: ctx.client as never,
    resolveMedia: (url) => resolveYouTubeVideoMediaWithRetry(url, {
      timeoutMs: ctx.config.YOUTUBE_REQUEST_TIMEOUT_MS,
      maxBytes: Number.MAX_SAFE_INTEGER,
    }),
    cleanup: () => cleanupYouTubeVideoCache({
      directory: ctx.config.ADHD_VIDEO_FILES_DIR,
      cacheMaxBytes: ctx.config.ADHD_VIDEO_CACHE_MAX_BYTES,
      retentionDays: ctx.config.ADHD_VIDEO_RETENTION_DAYS,
    }),
    videoExists: async (videoId) => access(join(ctx.config.ADHD_VIDEO_FILES_DIR, `${videoId}.mp4`), constants.F_OK)
      .then(() => true)
      .catch(() => false),
    enableVpsMaintenance: ctx.config.BOT_PROFILE === "production",
    onError: (error) => ctx.log.warn({ err: error }, "youtube video cache maintenance failed"),
  });
}

export function createYouTubeVideoCacheMaintenanceService(deps: MaintenanceDependencies) {
  const referenceRetryError = (reference: YouTubeVideoCacheReference, error: unknown): string => (
    reference.lastError?.startsWith(YOUTUBE_GOOGLEVIDEO_PENDING_PREFIX)
      ? youtubeGoogleVideoPendingError(errorMessage(error))
      : errorMessage(error)
  );
  const editReference = async (
    reference: YouTubeVideoCacheReference,
    mediaUrl: string | undefined,
    nextMode: YouTubeVideoCacheMediaMode,
    nextError: string | null,
    cacheRepo: CacheReferenceRepository = deps.repo,
  ): Promise<void> => {
    let channel: Awaited<ReturnType<typeof deps.client.channels.fetch>>;
    try {
      channel = await deps.client.channels.fetch(reference.channelId);
    } catch (error) {
      if (isUnknownDiscordResourceError(error)) await cacheRepo.deleteVideoCacheReference(reference.messageId);
      else await cacheRepo.updateVideoCacheReferenceMedia(reference.messageId, reference.mediaMode, referenceRetryError(reference, error));
      return;
    }
    if (!channel?.messages) {
      await cacheRepo.deleteVideoCacheReference(reference.messageId);
      return;
    }

    let message: EditableMessage;
    try {
      message = await channel.messages.fetch(reference.messageId);
    } catch (error) {
      if (isUnknownDiscordResourceError(error)) await cacheRepo.deleteVideoCacheReference(reference.messageId);
      else await cacheRepo.updateVideoCacheReferenceMedia(reference.messageId, reference.mediaMode, referenceRetryError(reference, error));
      return;
    }
    const messageComponents = message.components;
    if (message.author?.id !== deps.client.user?.id || !Array.isArray(messageComponents)) {
      await cacheRepo.deleteVideoCacheReference(reference.messageId);
      return;
    }

    const edit = async () => {
      const components = messageComponents.map((component) => component.toJSON?.() ?? component);
      const displayMediaUrl = nextMode === "none" ? undefined : mediaUrl;
      await message.edit({
        components: replacePreviewMedia(components, displayMediaUrl, { fallback: true, description: "YouTube video" }),
        flags: MessageFlags.IsComponentsV2,
        allowedMentions: { parse: [], repliedUser: false },
      });
    };
    if (nextMode === "vps") {
      try {
        await cacheRepo.updateVideoCacheReferenceMedia(reference.messageId, "vps", null);
      } catch {
        return;
      }
      try {
        await edit();
      } catch (error) {
        if (isUnknownDiscordResourceError(error)) {
          await cacheRepo.deleteVideoCacheReference(reference.messageId);
          return;
        }
        await cacheRepo.updateVideoCacheReferenceMedia(reference.messageId, reference.mediaMode, referenceRetryError(reference, error)).catch(() => undefined);
      }
      return;
    }
    try {
      await edit();
    } catch (error) {
      if (isUnknownDiscordResourceError(error)) {
        await cacheRepo.deleteVideoCacheReference(reference.messageId);
        return;
      }
      await cacheRepo.updateVideoCacheReferenceMedia(reference.messageId, reference.mediaMode, referenceRetryError(reference, error)).catch(() => undefined);
      return;
    }
    await cacheRepo.updateVideoCacheReferenceMedia(reference.messageId, nextMode, nextError).catch(() => undefined);
  };

  const fallbackVideo = async (videoId: string, cacheRepo: CacheReferenceRepository = deps.repo): Promise<void> => {
    const references = await cacheRepo.listVpsVideoCacheReferences(videoId);
    if (references.length === 0) return;
    let resolved: Awaited<ReturnType<MaintenanceDependencies["resolveMedia"]>>;
    try {
      resolved = await deps.resolveMedia(references[0]!.youtubeUrl);
    } catch (error) {
      resolved = { status: "fallback", reason: errorMessage(error) };
    }
    const mediaUrl = resolved.status === "ok" && isGoogleVideoUrl(resolved.mediaUrl) ? resolved.mediaUrl : undefined;
    const mediaMode: YouTubeVideoCacheMediaMode = mediaUrl ? "google" : "none";
    const lastError = mediaUrl ? null : youtubeGoogleVideoPendingError(resolved.status === "ok" ? "invalid_google_url" : resolved.reason);
    for (const reference of references) {
      await editReference(reference, mediaUrl, mediaMode, lastError, cacheRepo);
    }
  };

  const fallbackVideos = async (videoIds: readonly string[], cacheRepo: CacheReferenceRepository = deps.repo): Promise<void> => {
    for (const videoId of new Set(videoIds)) await fallbackVideo(videoId, cacheRepo);
  };

  const restoreCachedVideo = async (videoId: string, mediaUrl: string, cacheRepo: CacheReferenceRepository = deps.repo): Promise<void> => {
    const references = (await cacheRepo.listVideoCacheReferences(videoId))
      .filter((reference) => reference.mediaMode === "google" || reference.mediaMode === "none");
    for (const reference of references) {
      await editReference(reference, mediaUrl, "vps", null, cacheRepo);
    }
  };

  const missingVpsVideoIds = async (cacheRepo: CacheReferenceRepository = deps.repo): Promise<string[]> => {
    const references = await cacheRepo.listVpsVideoCacheReferences();
    const missingVideoIds: string[] = [];
    for (const videoId of new Set(references.map((reference) => reference.videoId))) {
      if (!(await deps.videoExists(videoId))) missingVideoIds.push(videoId);
    }
    return missingVideoIds;
  };

  const repairMissingVpsVideos = async (): Promise<void> => {
    await fallbackVideos(await missingVpsVideoIds());
  };

  const retryPendingGoogleVideos = async (cacheRepo: CacheReferenceRepository = deps.repo): Promise<void> => {
    if (!cacheRepo.listDueGoogleVideoRetries) return;
    const cutoff = new Date((deps.now?.() ?? new Date()).getTime() - 24 * 60 * 60 * 1000);
    const references = await cacheRepo.listDueGoogleVideoRetries(cutoff, 100);
    const byVideo = new Map<string, YouTubeVideoCacheReference[]>();
    for (const reference of references) {
      const group = byVideo.get(reference.videoId) ?? [];
      group.push(reference);
      byVideo.set(reference.videoId, group);
    }
    for (const group of byVideo.values()) {
      let resolved: Awaited<ReturnType<MaintenanceDependencies["resolveMedia"]>>;
      try {
        resolved = await deps.resolveMedia(group[0]!.youtubeUrl);
      } catch (error) {
        resolved = { status: "fallback", reason: errorMessage(error) };
      }
      const mediaUrl = resolved.status === "ok" && isGoogleVideoUrl(resolved.mediaUrl)
        ? resolved.mediaUrl
        : undefined;
      if (!mediaUrl) {
        const reason = resolved.status === "ok" ? "invalid_google_url" : resolved.reason;
        for (const reference of group) {
          await cacheRepo.updateVideoCacheReferenceMedia(
            reference.messageId,
            "none",
            youtubeGoogleVideoPendingError(reason),
          );
        }
        continue;
      }
      for (const reference of group) {
        await editReference(reference, mediaUrl, "google", null, cacheRepo);
      }
    }
  };

  const withLock = async <T>(run: (repo: CacheReferenceRepository) => Promise<T>): Promise<T> => {
    if (deps.withLock) return deps.withLock(run);
    if (deps.repo.withVideoCacheLock) return deps.repo.withVideoCacheLock(run);
    return run(deps.repo);
  };
  const withRetryLock = async <T>(run: (repo: CacheReferenceRepository) => Promise<T>): Promise<T> => {
    if (deps.withRetryLock) return deps.withRetryLock(run);
    if (deps.repo.withGoogleVideoRetryLock) return deps.repo.withGoogleVideoRetryLock(run);
    return run(deps.repo);
  };
  const runMaintenance = async (): Promise<void> => {
    if (deps.enableVpsMaintenance !== false) {
      await withLock(async (lockedRepo) => {
        const result = await deps.cleanup();
        await fallbackVideos([...result.evictedVideoIds, ...await missingVpsVideoIds(lockedRepo)], lockedRepo);
      });
    }
    await withRetryLock(async (lockedRepo) => {
      await retryPendingGoogleVideos(lockedRepo);
    });
  };
  const runCleanup = runMaintenance;

  let startPromise: Promise<YouTubeVideoCacheMaintenanceController> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let stopped = false;
  const runScheduled = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    try {
      await runMaintenance();
    } catch (error) {
      deps.onError?.(error);
    } finally {
      running = false;
    }
  };
  const start = (): Promise<YouTubeVideoCacheMaintenanceController> => {
    if (startPromise) return startPromise;
    startPromise = Promise.resolve().then(() => {
      const setRepeated = deps.setInterval ?? setInterval;
      const clearRepeated = deps.clearInterval ?? clearInterval;
      timer = setRepeated(() => { void runScheduled(); }, 60 * 60 * 1000);
      void runScheduled();
      return {
        stop: () => {
          if (stopped) return;
          stopped = true;
          if (timer) clearRepeated(timer);
        },
      };
    });
    return startPromise;
  };

  return { fallbackVideos, repairMissingVpsVideos, restoreCachedVideo, retryPendingGoogleVideos, runCleanup, runMaintenance, start };
}
