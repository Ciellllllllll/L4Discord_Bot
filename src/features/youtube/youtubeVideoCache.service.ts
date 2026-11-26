import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { MessageFlags } from "discord.js";
import type { CoreDeps } from "../../core/deps.js";
import { isDiscordMissingResourceError as isUnknownDiscordResourceError } from "../../core/discordErrors.js";
import { replacePreviewMedia } from "../../core/previewMedia.js";
import {
  isGoogleVideoMediaUrl as isGoogleVideoUrl,
  resolveYouTubeVideoMedia,
  resolveYouTubeVideoMediaWithRetry,
} from "./youtubeVideoMedia.js";
import { persistYouTubeVideo, youtubeVideoPublicUrl } from "./youtubeWatcher.videoStore.js";
import { YOUTUBE_GOOGLEVIDEO_PENDING_PREFIX, youtubeGoogleVideoPendingError, type YouTubeVideoCacheMediaMode, type YouTubeVideoCacheReference as RepositoryReference } from "./youtubeVideoCache.repository.js";
import { PostgresYouTubeVideoCacheRepository } from "./youtubeVideoCache.repository.js";
import {
  createYouTubeVideoCacheMaintenanceForContext,
  YouTubeVideoCacheReferenceRecoveryError,
  type YouTubeVideoCachePostMaintenance,
} from "./youtubeVideoCacheMaintenance.js";

// YouTube 動画キャッシュの保存と Discord 投稿の差し替え。

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

export async function cacheYouTubeVideoForPost(
  ctx: Pick<CoreDeps, "config" | "log" | "client" | "mainPgPool">,
  input: { videoId: string; videoUrl: string },
  deps: {
    repo?: Pick<PostgresYouTubeVideoCacheRepository, "withVideoCacheLock">;
    maintenance?: YouTubeVideoCachePostMaintenance;
    persistVideo?: typeof persistYouTubeVideo;
    resolveMedia?: (url: string) => Promise<{ status: "ok"; mediaUrl: string } | { status: "fallback"; reason: string }>;
    mediaResolver?: typeof resolveYouTubeVideoMedia;
    attachmentSizeLimitBytes?: number;
  } = {},
): Promise<YouTubeVideoCachePostMedia> {
  if (ctx.config.BOT_PROFILE !== "production") return { mediaMode: "none", lastError: null };

  const repo = deps.repo ?? new PostgresYouTubeVideoCacheRepository(ctx.mainPgPool);
  const maintenance = deps.maintenance ?? createYouTubeVideoCacheMaintenanceForContext(ctx);
  const baseMediaResolver = deps.mediaResolver ?? resolveYouTubeVideoMedia;
  let mediaResolution: ReturnType<typeof resolveYouTubeVideoMediaWithRetry> | undefined;
  const mediaResolver: typeof resolveYouTubeVideoMedia = (url, options) => {
    mediaResolution ??= resolveYouTubeVideoMediaWithRetry(url, options, { resolver: baseMediaResolver });
    return mediaResolution;
  };
  const resolveMedia = deps.resolveMedia ?? (deps.attachmentSizeLimitBytes === undefined
    ? ((url) => mediaResolver(url, {
      timeoutMs: ctx.config.YOUTUBE_REQUEST_TIMEOUT_MS,
      maxBytes: Number.MAX_SAFE_INTEGER,
    }))
    : ((url) => resolveYouTubeVideoMediaWithRetry(url, {
      timeoutMs: ctx.config.YOUTUBE_REQUEST_TIMEOUT_MS,
      maxBytes: deps.attachmentSizeLimitBytes,
    }, { resolver: baseMediaResolver })));
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
      if (deps.attachmentSizeLimitBytes === undefined
        && persisted.googleVideoUrl
        && isGoogleVideoUrl(persisted.googleVideoUrl)) {
        return { mediaMode: "google", mediaUrl: persisted.googleVideoUrl, lastError: persisted.reason };
      }
      return await fallback(persisted.reason);
    });
  } catch (error) {
    ctx.log.warn({ err: error, videoId: input.videoId }, "youtube video cache persistence failed");
    return fallback("cache_persist_error");
  }
}

export async function saveYouTubeVideoCacheReferenceForPost(
  ctx: Pick<CoreDeps, "config" | "log">,
  repo: Pick<PostgresYouTubeVideoCacheRepository, "upsertVideoCacheReference" | "withVideoCacheLock">,
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
    cacheRepo: Pick<PostgresYouTubeVideoCacheRepository, "upsertVideoCacheReference">,
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
