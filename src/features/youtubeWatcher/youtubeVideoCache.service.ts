import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { MessageFlags } from "discord.js";
import type { BotContext } from "../../bot/context.js";
import { replacePreviewMedia } from "../linkPreviews/shared/previewRenderer.js";
import {
  resolveYouTubeVideoMedia,
  resolveYouTubeVideoMediaWithRetry,
} from "../utilities/youtubeVideoMedia.js";
import { cleanupYouTubeVideoCache, persistYouTubeVideo, youtubeVideoPublicUrl } from "./youtubeWatcher.videoStore.js";
import { PostgresYouTubeWatcherRepository, YOUTUBE_GOOGLEVIDEO_PENDING_PREFIX, youtubeGoogleVideoPendingError, type YouTubeVideoCacheMediaMode, type YouTubeVideoCacheReference as RepositoryReference } from "./youtubeWatcher.repository.js";

export type YouTubeVideoCacheReference = Omit<RepositoryReference, "createdAt" | "updatedAt">;

export type YouTubeVideoCachePostMedia = {
  mediaMode: YouTubeVideoCacheMediaMode;
  mediaUrl?: string;
  lastError: string | null;
  resolvedGoogleVideoUrl?: string;
};

export function youtubeVideoThumbnailUrl(videoId: string): string {
  return `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg`;
}

type CacheReferenceRepository = {
  listVpsVideoCacheReferences(videoId?: string): Promise<YouTubeVideoCacheReference[]>;
  listVideoCacheReferences(videoId: string, mediaMode?: YouTubeVideoCacheMediaMode): Promise<YouTubeVideoCacheReference[]>;
  updateVideoCacheReferenceMedia(messageId: string, mediaMode: YouTubeVideoCacheMediaMode, lastError: string | null): Promise<void>;
  deleteVideoCacheReference(messageId: string): Promise<void>;
  listDueGoogleVideoRetries?(cutoff: Date, limit: number): Promise<YouTubeVideoCacheReference[]>;
};

type CacheReferenceLockingRepository = CacheReferenceRepository & {
  withVideoCacheLock?<T>(run: (repo: CacheReferenceRepository) => Promise<T>): Promise<T>;
  withGoogleVideoRetryLock?<T>(run: (repo: CacheReferenceRepository) => Promise<T>): Promise<T>;
};

type EditableMessage = {
  author?: { id?: string };
  components?: readonly { toJSON?: () => unknown }[];
  edit(payload: unknown): Promise<unknown>;
};

type MaintenanceDependencies = {
  repo: CacheReferenceLockingRepository;
  client: {
    user?: { id?: string } | null;
    channels: { fetch(channelId: string): Promise<{ messages?: { fetch(messageId: string): Promise<EditableMessage> } } | null> };
  };
  resolveMedia(url: string): Promise<{ status: "ok"; mediaUrl: string } | { status: "fallback"; reason: string }>;
  cleanup(): Promise<{ evictedVideoIds: string[] }>;
  videoExists(videoId: string): Promise<boolean>;
  withLock?<T>(run: (repo: CacheReferenceRepository) => Promise<T>): Promise<T>;
  withRetryLock?<T>(run: (repo: CacheReferenceRepository) => Promise<T>): Promise<T>;
  setInterval?(callback: () => void, delay: number): NodeJS.Timeout;
  clearInterval?(timer: NodeJS.Timeout): void;
  onError?(error: unknown): void;
  enableVpsMaintenance?: boolean;
  now?: () => Date;
};

export type YouTubeVideoCacheMaintenanceController = { stop(): void };

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

function isUnknownDiscordResourceError(error: unknown): boolean {
  const code = error && typeof error === "object" ? (error as { code?: number }).code : undefined;
  return code === 10003 || code === 10008;
}

function isGoogleVideoUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return parsed.protocol === "https:" && (host === "googlevideo.com" || host.endsWith(".googlevideo.com"));
  } catch {
    return false;
  }
}

export function createYouTubeVideoCacheMaintenanceForContext(
  ctx: Pick<BotContext, "config" | "log" | "client" | "mainPgPool">,
) {
  const repo = new PostgresYouTubeWatcherRepository(ctx.mainPgPool);
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

export async function cacheYouTubeVideoForPost(
  ctx: Pick<BotContext, "config" | "log" | "client" | "mainPgPool">,
  input: { videoId: string; videoUrl: string },
  deps: {
    repo?: Pick<PostgresYouTubeWatcherRepository, "withVideoCacheLock">;
    maintenance?: YouTubeVideoCachePostMaintenance;
    persistVideo?: typeof persistYouTubeVideo;
    resolveMedia?: (url: string) => Promise<{ status: "ok"; mediaUrl: string } | { status: "fallback"; reason: string }>;
    mediaResolver?: typeof resolveYouTubeVideoMedia;
  } = {},
): Promise<YouTubeVideoCachePostMedia> {
  if (ctx.config.BOT_PROFILE !== "production") return { mediaMode: "none", lastError: null };

  const repo = deps.repo ?? new PostgresYouTubeWatcherRepository(ctx.mainPgPool);
  const maintenance = deps.maintenance ?? createYouTubeVideoCacheMaintenanceForContext(ctx);
  const baseMediaResolver = deps.mediaResolver ?? resolveYouTubeVideoMedia;
  let mediaResolution: ReturnType<typeof resolveYouTubeVideoMediaWithRetry> | undefined;
  const mediaResolver: typeof resolveYouTubeVideoMedia = (url, options) => {
    mediaResolution ??= resolveYouTubeVideoMediaWithRetry(url, options, { resolver: baseMediaResolver });
    return mediaResolution;
  };
  const resolveMedia = deps.resolveMedia ?? ((url) => mediaResolver(url, {
    timeoutMs: ctx.config.YOUTUBE_REQUEST_TIMEOUT_MS,
    maxBytes: Number.MAX_SAFE_INTEGER,
  }));
  const fallback = async (lastError: string): Promise<YouTubeVideoCachePostMedia> => {
    try {
      const resolved = await resolveMedia(input.videoUrl);
      if (resolved.status === "ok" && isGoogleVideoUrl(resolved.mediaUrl)) {
        return { mediaMode: "google", mediaUrl: resolved.mediaUrl, lastError };
      }
      return { mediaMode: "none", lastError: youtubeGoogleVideoPendingError(resolved.status === "ok" ? "invalid_google_url" : resolved.reason) };
    } catch (error) {
      ctx.log.warn({ err: error, videoId: input.videoId }, "youtube cache fallback media resolution failed");
      return { mediaMode: "none", lastError: youtubeGoogleVideoPendingError("inner_tube_error") };
    }
  };

  if (!ctx.config.ADHD_VIDEO_PUBLIC_BASE_URL) return fallback("invalid_public_base_url");

  try {
    return await repo.withVideoCacheLock(async (lockedRepo) => {
      const persisted = await (deps.persistVideo ?? persistYouTubeVideo)(input, {
        directory: ctx.config.ADHD_VIDEO_FILES_DIR,
        publicBaseUrl: ctx.config.ADHD_VIDEO_PUBLIC_BASE_URL!,
        timeoutMs: ctx.config.YOUTUBE_REQUEST_TIMEOUT_MS,
        minFreeBytes: ctx.config.ADHD_VIDEO_MIN_FREE_BYTES,
        cacheMaxBytes: ctx.config.ADHD_VIDEO_CACHE_MAX_BYTES,
        retentionDays: ctx.config.ADHD_VIDEO_RETENTION_DAYS,
        mediaResolver,
      });
      try {
        await maintenance.fallbackVideos(persisted.evictedVideoIds, lockedRepo);
      } catch (error) {
        ctx.log.warn({ err: error, videoId: input.videoId }, "youtube evicted video fallback failed");
      }
      if (persisted.status === "cached") {
        try {
          await maintenance.restoreCachedVideo(input.videoId, persisted.mediaUrl, lockedRepo);
        } catch (error) {
          ctx.log.warn({ err: error, videoId: input.videoId }, "youtube cached video restore failed");
        }
        const resolved = mediaResolution ? await mediaResolution : undefined;
        return {
          mediaMode: "vps",
          mediaUrl: persisted.mediaUrl,
          lastError: null,
          ...(resolved?.status === "ok" && isGoogleVideoUrl(resolved.mediaUrl)
            ? { resolvedGoogleVideoUrl: resolved.mediaUrl }
            : {}),
        };
      }
      return persisted.googleVideoUrl && isGoogleVideoUrl(persisted.googleVideoUrl)
        ? { mediaMode: "google", mediaUrl: persisted.googleVideoUrl, lastError: persisted.reason }
        : await fallback(persisted.reason);
    });
  } catch (error) {
    ctx.log.warn({ err: error, videoId: input.videoId }, "youtube video cache persistence failed");
    return fallback("cache_persist_error");
  }
}

export async function saveYouTubeVideoCacheReferenceForPost(
  ctx: Pick<BotContext, "config" | "log">,
  repo: Pick<PostgresYouTubeWatcherRepository, "upsertVideoCacheReference" | "withVideoCacheLock">,
  target: { guildId: string; channelId: string },
  input: { videoId: string; videoUrl: string },
  notification: {
    message: {
      id: string;
      components: readonly { toJSON(): unknown }[];
      edit(payload: unknown): Promise<unknown>;
      delete?(): Promise<unknown>;
    };
    media: YouTubeVideoCachePostMedia;
  },
  deps: {
    resolveMedia?: (url: string) => Promise<{ status: "ok"; mediaUrl: string } | { status: "fallback"; reason: string }>;
    videoExists?: (videoId: string) => Promise<boolean>;
  } = {},
): Promise<YouTubeVideoCachePostMedia> {
  const resolveFallbackUncached = async (): Promise<YouTubeVideoCachePostMedia> => {
    if (notification.media.mediaMode === "google" && notification.media.mediaUrl) {
      return { ...notification.media, lastError: "reference_save_error" };
    }
    if (notification.media.resolvedGoogleVideoUrl && isGoogleVideoUrl(notification.media.resolvedGoogleVideoUrl)) {
      return {
        mediaMode: "google",
        mediaUrl: notification.media.resolvedGoogleVideoUrl,
        lastError: "reference_save_error",
      };
    }
    if (notification.media.mediaMode === "none"
      && notification.media.lastError?.startsWith(YOUTUBE_GOOGLEVIDEO_PENDING_PREFIX)) {
      return notification.media;
    }
    try {
      const resolved = await (deps.resolveMedia ?? ((url) => resolveYouTubeVideoMediaWithRetry(url, {
        timeoutMs: ctx.config.YOUTUBE_REQUEST_TIMEOUT_MS,
        maxBytes: Number.MAX_SAFE_INTEGER,
      })))(input.videoUrl);
      if (resolved.status === "ok" && isGoogleVideoUrl(resolved.mediaUrl)) {
        return { mediaMode: "google", mediaUrl: resolved.mediaUrl, lastError: "reference_save_error" };
      }
      if (resolved.status === "fallback") {
        return { mediaMode: "none", lastError: youtubeGoogleVideoPendingError(resolved.reason) };
      }
    } catch (resolveError) {
      ctx.log.warn({ err: resolveError, videoId: input.videoId }, "youtube reference fallback media resolution failed");
      return { mediaMode: "none", lastError: youtubeGoogleVideoPendingError("inner_tube_error") };
    }
    return { mediaMode: "none", lastError: youtubeGoogleVideoPendingError("invalid_google_url") };
  };
  let fallbackPromise: Promise<YouTubeVideoCachePostMedia> | undefined;
  const resolveFallback = (): Promise<YouTubeVideoCachePostMedia> => (
    fallbackPromise ??= resolveFallbackUncached()
  );
  const editMedia = async (media: YouTubeVideoCachePostMedia): Promise<void> => {
    const displayMediaUrl = media.mediaMode === "none" ? undefined : media.mediaUrl;
    await notification.message.edit({
      components: replacePreviewMedia(
        notification.message.components.map((component) => component.toJSON()),
        displayMediaUrl,
        { fallback: media.mediaMode !== "vps", description: "YouTube video" },
      ),
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { parse: [], repliedUser: false },
    });
  };
  const upsert = async (
    cacheRepo: Pick<PostgresYouTubeWatcherRepository, "upsertVideoCacheReference">,
    media: YouTubeVideoCachePostMedia,
  ): Promise<void> => {
    await cacheRepo.upsertVideoCacheReference({
      messageId: notification.message.id,
      videoId: input.videoId,
      guildId: target.guildId,
      channelId: target.channelId,
      youtubeUrl: input.videoUrl,
      mediaMode: media.mediaMode,
      lastError: media.lastError,
    });
  };
  const sameDisplayedMedia = (left: YouTubeVideoCachePostMedia, right: YouTubeVideoCachePostMedia): boolean => (
    left.mediaMode === right.mediaMode && left.mediaUrl === right.mediaUrl
  );
  const videoExists = deps.videoExists ?? (async (videoId: string) => {
    const directory = ctx.config.ADHD_VIDEO_FILES_DIR;
    if (!directory) return false;
    return access(join(directory, `${videoId}.mp4`), constants.F_OK).then(() => true).catch(() => false);
  });

  return await repo.withVideoCacheLock(async (lockedRepo) => {
    const cacheRepo = lockedRepo ?? repo;
    const publicMediaUrl = ctx.config.ADHD_VIDEO_PUBLIC_BASE_URL
      ? youtubeVideoPublicUrl(ctx.config.ADHD_VIDEO_PUBLIC_BASE_URL, input.videoId)
      : null;
    const cachedFileExists = ctx.config.BOT_PROFILE === "debug"
      ? false
      : await videoExists(input.videoId);
    let desiredMedia: YouTubeVideoCachePostMedia = cachedFileExists && publicMediaUrl
      ? { mediaMode: "vps", mediaUrl: publicMediaUrl, lastError: null }
      : notification.media;
    if (!cachedFileExists && notification.media.mediaMode === "vps") {
      const fallbackMedia = await resolveFallback();
      desiredMedia = fallbackMedia.mediaMode === "google"
        ? { ...fallbackMedia, lastError: "vps_file_missing" }
        : fallbackMedia;
    }

    let displayedMedia = notification.media;
    if (!sameDisplayedMedia(displayedMedia, desiredMedia)) {
      try {
        await editMedia(desiredMedia);
        displayedMedia = desiredMedia;
      } catch (error) {
        if (isUnknownDiscordResourceError(error)) {
          throw new YouTubeVideoCacheReferenceRecoveryError(true, error);
        }
        ctx.log.warn({ err: error, videoId: input.videoId }, "youtube video cache reference media edit failed");
        desiredMedia = displayedMedia;
      }
    }

    const recoverReference = async (media: YouTubeVideoCachePostMedia, recoveryError: unknown): Promise<YouTubeVideoCachePostMedia> => {
      try {
        await upsert(cacheRepo, media);
        return media;
      } catch (retryError) {
        let messageDeleted = false;
        try {
          if (notification.message.delete) {
            await notification.message.delete();
            messageDeleted = true;
          }
        } catch (deleteError) {
          messageDeleted = isUnknownDiscordResourceError(deleteError);
        }
        throw new YouTubeVideoCacheReferenceRecoveryError(messageDeleted, retryError ?? recoveryError);
      }
    };

    try {
      await upsert(cacheRepo, desiredMedia);
      return desiredMedia;
    } catch (error) {
      ctx.log.warn({ err: error, videoId: input.videoId }, "youtube video cache reference save failed");
      const fallbackMedia = await resolveFallback();
      if (!sameDisplayedMedia(displayedMedia, fallbackMedia)) {
        try {
          await editMedia(fallbackMedia);
          displayedMedia = fallbackMedia;
        } catch (editError) {
          if (isUnknownDiscordResourceError(editError)) {
            throw new YouTubeVideoCacheReferenceRecoveryError(true, editError);
          }
          ctx.log.warn({ err: editError, videoId: input.videoId }, "youtube reference fallback edit failed");
          return await recoverReference(displayedMedia, error);
        }
      }
      return await recoverReference(fallbackMedia, error);
    }
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
