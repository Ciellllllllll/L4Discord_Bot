import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { MessageFlags, type APIEmbed, type Client, type GuildTextBasedChannel, type Message } from "discord.js";
import type { BotContext } from "../../bot/context.js";
import { ComponentCardBuilder, componentCardsPayload } from "../panels/componentCard.js";
import { buildYouTubeNativeEmbedPayload, buildYouTubeReplyPayloads, getYouTubeNativeEmbedVideoUrl, replaceYouTubePreviewMedia } from "../utilities/youtubePreview.js";
import { resolveYouTubeVideoMedia } from "../utilities/youtubeVideoMedia.js";
import { fetchYouTubeChannelFeed, type YouTubeFeedEntry } from "./youtubeRss.js";
import { cacheYouTubeVideoForPost, createYouTubeVideoCacheMaintenanceForContext, saveYouTubeVideoCacheReferenceForPost, YouTubeVideoCacheReferenceRecoveryError, type YouTubeVideoCachePostMedia } from "./youtubeVideoCache.service.js";
import { persistYouTubeVideo, youtubeVideoPublicUrl } from "./youtubeWatcher.videoStore.js";
import { PostgresYouTubeWatcherRepository, toUnnotifiedEntries, type YouTubeVideoCacheReferenceRecoveryCandidate, type YouTubeWatchSubscription } from "./youtubeWatcher.repository.js";

export type YouTubeWatcherController = { scanNow(): Promise<void>; stop(): void };
export const YOUTUBE_VIDEO_CACHE_REFERENCE_RECOVERY_PENDING = "youtube_video_cache_reference_recovery_pending";

export type YouTubeWatcherPostMedia = YouTubeVideoCachePostMedia;

export type YouTubeWatcherNotificationResult = {
  message: Message;
  media?: YouTubeWatcherPostMedia;
};

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
    maintenance: YouTubeWatcherCacheMaintenance;
  },
): Promise<YouTubeWatcherPostMedia> {
  return cacheYouTubeVideoForPost(ctx as Pick<BotContext, "config" | "log" | "client" | "mainPgPool">, {
    videoId: entry.videoId,
    videoUrl: entry.videoUrl,
  }, { repo, ...deps });
}

export function buildYouTubeNotificationPayload(entry: YouTubeFeedEntry, nativeEmbed?: APIEmbed, mediaUrlOverride?: string) {
  if (nativeEmbed) return buildYouTubeNativeEmbedPayload(nativeEmbed, entry.videoUrl, mediaUrlOverride);
  const card = new ComponentCardBuilder()
    .setTitle(entry.title.slice(0, 256))
    .setURL(entry.videoUrl)
    .setDescription(`${entry.channelTitle}\n公開: <t:${Math.floor(Date.parse(entry.publishedAt) / 1000)}:F>`);
  card.setThumbnail(entry.thumbnailUrl);
  card.setImage(mediaUrlOverride);
  return { ...componentCardsPayload([card]), allowedMentions: { parse: [] } };
}

const NATIVE_EMBED_WAIT_MS = 3_000;
const DEFAULT_ATTACHMENT_SIZE_LIMIT_BYTES = 10 * 1024 * 1024;
const BOOST_TIER_2_ATTACHMENT_SIZE_LIMIT_BYTES = 50 * 1000 * 1000;
const BOOST_TIER_3_ATTACHMENT_SIZE_LIMIT_BYTES = 100 * 1000 * 1000;

export function youtubeWatcherAttachmentSizeLimit(target: GuildTextBasedChannel): number {
  const premiumTier = (target as unknown as { guild?: { premiumTier?: number } }).guild?.premiumTier;
  if (premiumTier === 3) return BOOST_TIER_3_ATTACHMENT_SIZE_LIMIT_BYTES;
  if (premiumTier === 2) return BOOST_TIER_2_ATTACHMENT_SIZE_LIMIT_BYTES;
  return DEFAULT_ATTACHMENT_SIZE_LIMIT_BYTES;
}

function toApiEmbed(value: unknown): APIEmbed | null {
  if (!value || typeof value !== "object") return null;
  const object = value as { toJSON?: () => unknown };
  const json = typeof object.toJSON === "function" ? object.toJSON() : value;
  return json && typeof json === "object" ? json as APIEmbed : null;
}

function nativeEmbedFromMessage(message: Pick<Message, "embeds">): APIEmbed | null {
  for (const value of message.embeds) {
    const embed = toApiEmbed(value);
    if (embed?.type === "video" || embed?.video) return embed;
  }
  return null;
}

export async function probeYouTubeNativeEmbed(
  target: GuildTextBasedChannel,
  entry: YouTubeFeedEntry,
  client: Client,
): Promise<APIEmbed | null> {
  const probe = await target.send({ content: entry.videoUrl, allowedMentions: { parse: [] } });
  try {
    const immediate = nativeEmbedFromMessage(probe);
    if (immediate) return immediate;

    const events = client as unknown as {
      on?: (event: string, listener: (oldMessage: unknown, newMessage: unknown) => void) => unknown;
      off?: (event: string, listener: (oldMessage: unknown, newMessage: unknown) => void) => unknown;
    };
    if (!events.on || !events.off) return null;

    return await new Promise<APIEmbed | null>((resolve) => {
      let settled = false;
      const finish = (embed: APIEmbed | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        events.off?.("messageUpdate", onUpdate);
        resolve(embed);
      };
      const onUpdate = (_oldMessage: unknown, newMessage: unknown) => {
        if (!newMessage || typeof newMessage !== "object" || (newMessage as { id?: string }).id !== probe.id) return;
        const embed = nativeEmbedFromMessage(newMessage as Pick<Message, "embeds">);
        if (embed) finish(embed);
      };
      const timer = setTimeout(() => finish(null), NATIVE_EMBED_WAIT_MS);
      events.on?.("messageUpdate", onUpdate);
    });
  } finally {
    await probe.delete().catch(() => undefined);
  }
}

export async function buildYouTubeWatcherPayload(
  ctx: Pick<BotContext, "client" | "config" | "log">,
  target: GuildTextBasedChannel,
  entry: YouTubeFeedEntry,
  options: { skipNativeEmbed?: boolean; media?: YouTubeWatcherPostMedia } = {},
) {
  const media = options.media;
  if (media && media.mediaMode !== "vps") {
    try {
      const [fallback] = await buildYouTubeReplyPayloads([{
        kind: "video",
        originalUrl: entry.videoUrl,
        canonicalUrl: entry.videoUrl,
        id: entry.videoId,
      }], {
        apiKey: ctx.config.YOUTUBE_DATA_API_KEY,
        requestTimeoutMs: ctx.config.YOUTUBE_REQUEST_TIMEOUT_MS,
        componentsOnly: true,
        mediaMode: media.mediaMode,
        mediaUrlOverride: media.mediaUrl,
        log: ctx.log,
      });
      if (fallback && (fallback as { flags?: number }).flags === MessageFlags.IsComponentsV2) {
        return {
          ...fallback,
          components: replaceYouTubePreviewMedia(fallback.components ?? [], media.mediaUrl, { fallback: true }),
        };
      }
    } catch (error) {
      ctx.log.warn({ err: error, videoId: entry.videoId }, "youtube fallback media payload build failed");
    }
    return buildYouTubeNotificationPayload({ ...entry, thumbnailUrl: null }, undefined, undefined);
  }
  const durableMediaUrl = media?.mediaUrl;

  let nativeEmbed: APIEmbed | null = null;
  if (!options.skipNativeEmbed) {
    try {
      nativeEmbed = await probeYouTubeNativeEmbed(target, entry, ctx.client);
    } catch (error) {
      ctx.log.warn({ err: error, videoId: entry.videoId }, "youtube native embed probe failed");
    }
  }

  if (nativeEmbed && (durableMediaUrl || getYouTubeNativeEmbedVideoUrl(nativeEmbed))) {
    return buildYouTubeNotificationPayload(entry, nativeEmbed, durableMediaUrl);
  }

  try {
    const [fallback] = await buildYouTubeReplyPayloads([{
      kind: "video",
      originalUrl: entry.videoUrl,
      canonicalUrl: entry.videoUrl,
      id: entry.videoId,
    }], {
      apiKey: ctx.config.YOUTUBE_DATA_API_KEY,
      requestTimeoutMs: ctx.config.YOUTUBE_REQUEST_TIMEOUT_MS,
      attachmentSizeLimitBytes: youtubeWatcherAttachmentSizeLimit(target),
      componentsOnly: true,
      mediaUrlOverride: durableMediaUrl,
      log: ctx.log,
    });
    if (fallback && (fallback as { flags?: number }).flags === MessageFlags.IsComponentsV2) {
      if (!durableMediaUrl || JSON.stringify(fallback).includes(durableMediaUrl)) return fallback;
    }
  } catch (error) {
    ctx.log.warn({ err: error, videoId: entry.videoId }, "youtube fallback media resolution failed");
  }

  return buildYouTubeNotificationPayload(entry, nativeEmbed ?? undefined, durableMediaUrl);
}

export async function sendYouTubeWatcherNotification(
  ctx: Pick<BotContext, "client" | "config" | "log">,
  target: GuildTextBasedChannel,
  entry: YouTubeFeedEntry,
  deps: { buildPayload?: typeof buildYouTubeWatcherPayload; cacheForPost?: (entry: YouTubeFeedEntry) => Promise<YouTubeWatcherPostMedia> } = {},
): Promise<YouTubeWatcherNotificationResult> {
  const buildPayload = deps.buildPayload ?? buildYouTubeWatcherPayload;
  const media = await deps.cacheForPost?.(entry);
  const payload = await buildPayload(ctx, target, entry, { media });
  try {
    return { message: await target.send(payload), media };
  } catch (error) {
    ctx.log.warn({ err: error, videoId: entry.videoId }, "youtube native notification send failed; retrying without native Embed");
    return { message: await target.send(await buildPayload(ctx, target, entry, { skipNativeEmbed: true, media })), media };
  }
}

export function replaceYouTubeWatcherMediaUrl(
  components: readonly unknown[],
  mediaUrl: string,
): ReturnType<typeof replaceYouTubePreviewMedia> {
  // 互換export。fallback変換には使用せず、共通の媒体置換だけへ委譲する。
  return replaceYouTubePreviewMedia(components, mediaUrl);
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
    const resolved = await (deps.resolveMedia ?? ((url) => resolveYouTubeVideoMedia(url, {
      timeoutMs: ctx.config.YOUTUBE_REQUEST_TIMEOUT_MS,
      maxBytes: Number.MAX_SAFE_INTEGER,
    })))(candidate.entry.videoUrl);
    if (resolved.status === "ok") {
      const resolvedUrl = new URL(resolved.mediaUrl);
      const hostname = resolvedUrl.hostname.toLowerCase();
      if (resolvedUrl.protocol === "https:" && (hostname === "googlevideo.com" || hostname.endsWith(".googlevideo.com"))) {
        return { mediaMode: "google", mediaUrl: resolved.mediaUrl, lastError: null };
      }
    }
  } catch (error) {
    ctx.log.warn({ err: error, videoId: candidate.entry.videoId }, "youtube cache reference recovery media resolution failed");
  }
  return { mediaMode: "none", lastError: null };
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
    try {
      await message.edit({
        components: replaceYouTubePreviewMedia(
          message.components.map((component) => component.toJSON()),
          media.mediaUrl,
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
    const feed = await fetchYouTubeChannelFeed(subscription.youtubeChannelId, { timeoutMs: ctx.config.ADHD_RSS_REQUEST_TIMEOUT_MS });
    if (!feed.ok) {
      await repo.setError(subscription.id, feed.error);
      ctx.log.warn({ subscriptionId: subscription.id, error: feed.error }, "youtube watcher RSS scan failed");
      continue;
    }
    const target = await fetchTarget(ctx.client, subscription.discordChannelId);
    if (!target) {
      const error = "通知先チャンネルまたはスレッドへ送信できません。";
      await repo.setError(subscription.id, error);
      ctx.log.warn({ subscriptionId: subscription.id }, "youtube watcher target is unavailable");
      continue;
    }
    const sent = await repo.sentVideoIds(subscription.id);
    let lastPostError: string | null = null;
    for (const entry of toUnnotifiedEntries(feed.entries, sent)) {
      let sentToDiscord = false;
      let notification: YouTubeWatcherNotificationResult | undefined;
      try {
        await repo.savePost(subscription.id, entry, { status: "pending" });
        notification = await sendYouTubeWatcherNotification(ctx, target, entry, {
          cacheForPost: cacheMaintenance
            ? (candidate) => cacheYouTubeWatcherVideo(ctx, candidate, cacheRepo, { maintenance: cacheMaintenance })
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
    await repo.setError(subscription.id, lastPostError);
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
