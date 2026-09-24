import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { MessageFlags, type Client, type GuildTextBasedChannel, type Message } from "discord.js";
import type { BotContext } from "../../bot/context.js";
import {
  sendYouTubeWatcherNotification,
  type YouTubeWatcherNotificationResult,
  type YouTubeWatcherPostMedia,
} from "../linkPreviews/youtube/adhdYouTubeExpansion.js";
import { replacePreviewMedia } from "../linkPreviews/shared/previewRenderer.js";
import { youtubeAttachmentSizeLimitForPremiumTier } from "../linkPreviews/youtube/youtubeMediaAttachment.js";
import {
  resolveYouTubeVideoMedia,
  resolveYouTubeVideoMediaWithRetry,
} from "../utilities/youtubeVideoMedia.js";
import { fetchYouTubeChannelFeed, type YouTubeFeedEntry } from "./youtubeRss.js";
import { fetchYouTubeChannelVideos, resolveYouTubeWatcherEntries } from "./youtubeWatcherFallback.js";
import { cacheYouTubeVideoForPost, createYouTubeVideoCacheMaintenanceForContext, saveYouTubeVideoCacheReferenceForPost, YouTubeVideoCacheReferenceRecoveryError } from "./youtubeVideoCache.service.js";
import { persistYouTubeVideo, youtubeVideoPublicUrl } from "./youtubeWatcher.videoStore.js";
import { PostgresYouTubeWatcherRepository, youtubeGoogleVideoPendingError, type YouTubeVideoCacheReferenceRecoveryCandidate, type YouTubeWatchSubscription } from "./youtubeWatcher.repository.js";

export type YouTubeWatcherController = { scanNow(): Promise<void>; stop(): void };
export const YOUTUBE_VIDEO_CACHE_REFERENCE_RECOVERY_PENDING = "youtube_video_cache_reference_recovery_pending";

type YouTubeWatcherCacheRepository = Pick<PostgresYouTubeWatcherRepository, "withVideoCacheLock">;

type YouTubeWatcherCacheMaintenance = {
  fallbackVideos(videoIds: readonly string[]): Promise<void>;
  restoreCachedVideo(videoId: string, mediaUrl: string): Promise<void>;
};

export async function cacheYouTubeWatcherVideo(
  ctx: Pick<BotContext, "config" | "log">,
  entry: YouTubeFeedEntry,
  repo: YouTubeWatcherCacheRepository,
  deps: {
    persistVideo?: typeof persistYouTubeVideo;
    resolveMedia?: (url: string) => Promise<{ status: "ok"; mediaUrl: string } | { status: "fallback"; reason: string }>;
    mediaResolver?: typeof resolveYouTubeVideoMedia;
    attachmentSizeLimitBytes?: number;
    maintenance: YouTubeWatcherCacheMaintenance;
  },
): Promise<YouTubeWatcherPostMedia> {
  return cacheYouTubeVideoForPost(ctx as Pick<BotContext, "config" | "log" | "client" | "mainPgPool">, {
    videoId: entry.videoId,
    videoUrl: entry.videoUrl,
  }, { repo, ...deps });
}

export async function repairOneYouTubeWatcherMessage(
  ctx: Pick<BotContext, "client" | "config" | "log">,
  repo: Pick<PostgresYouTubeWatcherRepository, "listMediaRepairCandidates" | "finalizeMediaRepair">,
  deps: { persistVideo?: typeof persistYouTubeVideo } = {},
): Promise<void> {
  // 互換 export。起動時修復はキャッシュ保守サービスが参照テーブルだけを編集する。
  void ctx;
  void repo;
  void deps;
}

async function fetchTarget(client: Client, id: string): Promise<GuildTextBasedChannel | null> {
  const channel = await client.channels.fetch(id).catch(() => null);
  if (!channel || !("guildId" in channel) || !channel.isTextBased() || channel.isDMBased() || !channel.isSendable()) return null;
  if (channel.isThread() && (channel.archived || channel.locked)) return null;
  return channel;
}

export async function saveYouTubeWatcherVideoCacheReference(
  ctx: Pick<BotContext, "config" | "log">,
  repo: Pick<PostgresYouTubeWatcherRepository, "upsertVideoCacheReference" | "updateVideoCacheReferenceMedia" | "withVideoCacheLock">,
  target: Pick<GuildTextBasedChannel, "guildId" | "id">,
  entry: YouTubeFeedEntry,
  notification: YouTubeWatcherNotificationResult,
  deps: { resolveMedia?: (url: string) => Promise<{ status: "ok"; mediaUrl: string } | { status: "fallback"; reason: string }> } = {},
): Promise<YouTubeWatcherPostMedia | undefined> {
  if (!notification.media) return undefined;
  return saveYouTubeVideoCacheReferenceForPost(ctx, repo, {
    guildId: target.guildId,
    channelId: target.id,
  }, {
    videoId: entry.videoId,
    videoUrl: entry.videoUrl,
  }, {
    message: notification.message,
    media: notification.media,
  }, deps);
}

export function shouldMarkYouTubeWatcherPostFailed(sentToDiscord: boolean, error: unknown): boolean {
  return !sentToDiscord || (error instanceof YouTubeVideoCacheReferenceRecoveryError && error.messageDeleted);
}

export async function saveYouTubeWatcherReferenceRecoveryPending(
  repo: Pick<PostgresYouTubeWatcherRepository, "savePost">,
  subscriptionId: string,
  entry: YouTubeFeedEntry,
  notification: Pick<YouTubeWatcherNotificationResult, "message">,
): Promise<void> {
  await repo.savePost(subscriptionId, entry, {
    status: "pending",
    messageId: notification.message.id,
    error: YOUTUBE_VIDEO_CACHE_REFERENCE_RECOVERY_PENDING,
  });
}

function isUnknownDiscordResourceError(error: unknown): boolean {
  const code = error && typeof error === "object" ? (error as { code?: number }).code : undefined;
  return code === 10003 || code === 10008;
}

async function resolveYouTubeWatcherRecoveryMedia(
  ctx: Pick<BotContext, "config" | "log">,
  candidate: YouTubeVideoCacheReferenceRecoveryCandidate,
  deps: {
    videoExists?: (videoId: string) => Promise<boolean>;
    resolveMedia?: (url: string) => Promise<{ status: "ok"; mediaUrl: string } | { status: "fallback"; reason: string }>;
  },
): Promise<YouTubeWatcherPostMedia> {
  const publicUrl = ctx.config.ADHD_VIDEO_PUBLIC_BASE_URL
    ? youtubeVideoPublicUrl(ctx.config.ADHD_VIDEO_PUBLIC_BASE_URL, candidate.entry.videoId)
    : null;
  const videoExists = deps.videoExists ?? ((videoId) => access(
    join(ctx.config.ADHD_VIDEO_FILES_DIR, `${videoId}.mp4`),
    constants.F_OK,
  ).then(() => true).catch(() => false));
  if (publicUrl && await videoExists(candidate.entry.videoId)) {
    return { mediaMode: "vps", mediaUrl: publicUrl, lastError: null };
  }
  try {
    const resolved = await (deps.resolveMedia ?? ((url) => resolveYouTubeVideoMediaWithRetry(url, {
      timeoutMs: ctx.config.YOUTUBE_REQUEST_TIMEOUT_MS,
      maxBytes: Number.MAX_SAFE_INTEGER,
    })))(candidate.entry.videoUrl);
    if (resolved.status === "ok") {
      const resolvedUrl = new URL(resolved.mediaUrl);
      const hostname = resolvedUrl.hostname.toLowerCase();
      if (resolvedUrl.protocol === "https:" && (hostname === "googlevideo.com" || hostname.endsWith(".googlevideo.com"))) {
        return { mediaMode: "google", mediaUrl: resolved.mediaUrl, lastError: null };
      }
      return { mediaMode: "none", lastError: youtubeGoogleVideoPendingError("invalid_google_url") };
    }
    return { mediaMode: "none", lastError: youtubeGoogleVideoPendingError(resolved.reason) };
  } catch (error) {
    ctx.log.warn({ err: error, videoId: candidate.entry.videoId }, "youtube cache reference recovery media resolution failed");
    return { mediaMode: "none", lastError: youtubeGoogleVideoPendingError("inner_tube_error") };
  }
}

export async function recoverYouTubeWatcherVideoCacheReferenceCandidate(
  ctx: Pick<BotContext, "config" | "log" | "client">,
  repo: Pick<PostgresYouTubeWatcherRepository, "savePost">,
  cacheRepo: Pick<PostgresYouTubeWatcherRepository, "upsertVideoCacheReference" | "updateVideoCacheReferenceMedia" | "withVideoCacheLock">,
  candidate: YouTubeVideoCacheReferenceRecoveryCandidate,
  deps: {
    videoExists?: (videoId: string) => Promise<boolean>;
    resolveMedia?: (url: string) => Promise<{ status: "ok"; mediaUrl: string } | { status: "fallback"; reason: string }>;
  } = {},
): Promise<void> {
  const save = (status: "pending" | "sent" | "failed", error?: string, durableMediaUrl?: string | null) => repo.savePost(candidate.subscriptionId, candidate.entry, {
    status,
    messageId: candidate.discordMessageId,
    ...(error ? { error } : {}),
    ...(durableMediaUrl !== undefined ? { durableMediaUrl } : {}),
  });
  let channel: Awaited<ReturnType<typeof ctx.client.channels.fetch>>;
  try {
    channel = await ctx.client.channels.fetch(candidate.discordChannelId);
  } catch (error) {
    await save(isUnknownDiscordResourceError(error) ? "failed" : "pending", YOUTUBE_VIDEO_CACHE_REFERENCE_RECOVERY_PENDING);
    return;
  }
  if (!channel || !("messages" in channel)) {
    await save("failed", YOUTUBE_VIDEO_CACHE_REFERENCE_RECOVERY_PENDING);
    return;
  }
  let message: Message;
  try {
    message = await channel.messages.fetch(candidate.discordMessageId);
  } catch (error) {
    await save(isUnknownDiscordResourceError(error) ? "failed" : "pending", YOUTUBE_VIDEO_CACHE_REFERENCE_RECOVERY_PENDING);
    return;
  }
  if (message.author.id !== ctx.client.user?.id || !Array.isArray(message.components)) {
    await save("failed", YOUTUBE_VIDEO_CACHE_REFERENCE_RECOVERY_PENDING);
    return;
  }
  try {
    const media = await resolveYouTubeWatcherRecoveryMedia(ctx, candidate, deps);
    const displayMediaUrl = media.mediaMode === "none" ? undefined : media.mediaUrl;
    try {
      await message.edit({
        components: replacePreviewMedia(
          message.components.map((component) => component.toJSON()),
          displayMediaUrl,
          { fallback: true },
        ),
        flags: MessageFlags.IsComponentsV2,
        allowedMentions: { parse: [], repliedUser: false },
      });
    } catch (error) {
      await save(isUnknownDiscordResourceError(error) ? "failed" : "pending", YOUTUBE_VIDEO_CACHE_REFERENCE_RECOVERY_PENDING);
      return;
    }
    const savedMedia = await saveYouTubeVideoCacheReferenceForPost(ctx, cacheRepo, {
      guildId: candidate.guildId,
      channelId: candidate.discordChannelId,
    }, {
      videoId: candidate.entry.videoId,
      videoUrl: candidate.entry.videoUrl,
    }, { message, media }, deps);
    await save("sent", undefined, savedMedia.mediaMode === "vps" ? savedMedia.mediaUrl ?? null : null);
  } catch (error) {
    if (error instanceof YouTubeVideoCacheReferenceRecoveryError && error.messageDeleted) {
      await save("failed", error.message);
      return;
    }
    await save("pending", YOUTUBE_VIDEO_CACHE_REFERENCE_RECOVERY_PENDING);
  }
}

export async function scanYouTubeWatcher(ctx: BotContext): Promise<void> {
  const client = await ctx.mainPgPool.connect();
  let locked = false;
  try {
  const lock = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(hashtext('youtube_watcher_scan')) AS locked");
  locked = lock.rows[0]?.locked === true;
   if (!locked) return;
   const repo = new PostgresYouTubeWatcherRepository(client);
   const cacheRepo = new PostgresYouTubeWatcherRepository(ctx.mainPgPool);
   const cacheMaintenance = ctx.config.BOT_PROFILE === "production"
     ? createYouTubeVideoCacheMaintenanceForContext(ctx)
     : null;
   if (ctx.config.BOT_PROFILE === "production") {
     for (const candidate of await repo.listVideoCacheReferenceRecoveryCandidates(25)) {
       await recoverYouTubeWatcherVideoCacheReferenceCandidate(ctx, repo, cacheRepo, candidate).catch((error) => {
         ctx.log.warn({ err: error, videoId: candidate.entry.videoId }, "youtube cache reference recovery save failed");
       });
     }
   }
  for (const subscription of await repo.list(ctx.config.GUILD_ID, true)) {
    const history = await repo.notificationHistory(subscription.id);
    // RSS を優先し、RSS が取れないときだけ代替手段（youtubei.js の動画一覧）で補う
    const feed = await resolveYouTubeWatcherEntries(subscription.youtubeChannelId, history.sent, {
      failedVideoIds: history.failed,
      fetchFeed: (channelId) => fetchYouTubeChannelFeed(channelId, { timeoutMs: ctx.config.ADHD_RSS_REQUEST_TIMEOUT_MS }),
      fetchFallback: (channelId) => fetchYouTubeChannelVideos(channelId, { timeoutMs: ctx.config.ADHD_RSS_REQUEST_TIMEOUT_MS }),
    });
    if (!feed.ok) {
      await repo.setError(subscription.id, feed.error);
      ctx.log.warn({ subscriptionId: subscription.id, error: feed.error }, "youtube watcher RSS scan failed");
      continue;
    }
    if (feed.usedFallback) {
      ctx.log.warn({ subscriptionId: subscription.id, notice: feed.notice, entries: feed.entries.length }, "youtube watcher RSS failed; used fallback");
    }
    const target = await fetchTarget(ctx.client, subscription.discordChannelId);
    if (!target) {
      const error = "通知先チャンネルまたはスレッドへ送信できません。";
      await repo.setError(subscription.id, error);
      ctx.log.warn({ subscriptionId: subscription.id }, "youtube watcher target is unavailable");
      continue;
    }
    let lastPostError: string | null = null;
    for (const entry of feed.entries) {
      let sentToDiscord = false;
      let notification: YouTubeWatcherNotificationResult | undefined;
      try {
        await repo.savePost(subscription.id, entry, { status: "pending" });
        notification = await sendYouTubeWatcherNotification(ctx, target, entry, {
          cacheForPost: cacheMaintenance
            ? (candidate, mediaResolver) => cacheYouTubeWatcherVideo(ctx, candidate, cacheRepo, {
              maintenance: cacheMaintenance,
              mediaResolver,
              attachmentSizeLimitBytes: youtubeAttachmentSizeLimitForPremiumTier(target.guild?.premiumTier),
            })
            : undefined,
        });
        sentToDiscord = true;
        const savedMedia = await saveYouTubeWatcherVideoCacheReference(ctx, cacheRepo, target, entry, notification);
        const durableMediaUrl = savedMedia?.mediaMode === "vps" ? savedMedia.mediaUrl ?? null : null;
        await repo.savePost(subscription.id, entry, { status: "sent", messageId: notification.message.id, durableMediaUrl });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof YouTubeVideoCacheReferenceRecoveryError && !error.messageDeleted && notification) {
          await saveYouTubeWatcherReferenceRecoveryPending(repo, subscription.id, entry, notification);
        } else if (shouldMarkYouTubeWatcherPostFailed(sentToDiscord, error)) {
          await repo.savePost(subscription.id, entry, { status: "failed", error: message });
        }
        lastPostError = message;
        ctx.log.warn({ err: error, subscriptionId: subscription.id, videoId: entry.videoId }, "youtube watcher post failed");
      }
    }
    // 代替手段を使ったときは、投稿に失敗していなくても RSS の失敗を「最終エラー」に残す
    await repo.setError(subscription.id, lastPostError ?? feed.notice ?? null);
  }
  } finally {
    if (locked) {
      const released = await client.query<{ unlocked: boolean }>("SELECT pg_advisory_unlock(hashtext('youtube_watcher_scan')) AS unlocked")
        .catch((err) => { ctx.log.warn({ err }, "youtube watcher scan lock release failed"); return null; });
      if (released && released.rows[0]?.unlocked !== true) ctx.log.warn("youtube watcher scan lock was not held by its connection");
    }
    client.release();
  }
}

export function startYouTubeWatcher(ctx: BotContext): YouTubeWatcherController | null {
  if (!ctx.config.ADHD_WATCHER_ENABLED) return null;
  let stopped = false;
  let running: Promise<void> | null = null;
  const scanNow = async () => {
    if (stopped || running) return running ?? undefined;
    running = scanYouTubeWatcher(ctx).catch((err) => ctx.log.warn({ err }, "youtube watcher scan failed")).finally(() => { running = null; });
    return running;
  };
  void scanNow();
  const interval = setInterval(() => void scanNow(), ctx.config.ADHD_POLL_INTERVAL_MS);
  return { scanNow, stop: () => { stopped = true; clearInterval(interval); } };
}

export function youtubeSubscriptionSummary(subscription: YouTubeWatchSubscription): string {
  return `${subscription.enabled ? "有効" : "無効"} ${subscription.sourceUrl} → <#${subscription.discordChannelId}>${subscription.lastError ? `\n最終エラー: ${subscription.lastError.slice(0, 120)}` : ""}`;
}
