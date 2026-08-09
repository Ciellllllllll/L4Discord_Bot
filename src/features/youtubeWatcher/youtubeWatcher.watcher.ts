import { MessageFlags, type APIEmbed, type Client, type GuildTextBasedChannel, type Message } from "discord.js";
import type { BotContext } from "../../bot/context.js";
import { ComponentCardBuilder, componentCardsPayload } from "../panels/componentCard.js";
import { buildYouTubeNativeEmbedPayload, buildYouTubeReplyPayloads, getYouTubeNativeEmbedVideoUrl } from "../utilities/youtubePreview.js";
import { fetchYouTubeChannelFeed, type YouTubeFeedEntry } from "./youtubeRss.js";
import { PostgresYouTubeWatcherRepository, toUnnotifiedEntries, type YouTubeWatchSubscription } from "./youtubeWatcher.repository.js";

export type YouTubeWatcherController = { scanNow(): Promise<void>; stop(): void };

export function buildYouTubeNotificationPayload(entry: YouTubeFeedEntry, nativeEmbed?: APIEmbed) {
  if (nativeEmbed) return buildYouTubeNativeEmbedPayload(nativeEmbed, entry.videoUrl);
  const card = new ComponentCardBuilder()
    .setTitle(entry.title.slice(0, 256))
    .setURL(entry.videoUrl)
    .setDescription(`${entry.channelTitle}\n公開: <t:${Math.floor(Date.parse(entry.publishedAt) / 1000)}:F>`);
  card.setThumbnail(entry.thumbnailUrl);
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
  options: { skipNativeEmbed?: boolean } = {},
) {
  let nativeEmbed: APIEmbed | null = null;
  if (!options.skipNativeEmbed) {
    try {
      nativeEmbed = await probeYouTubeNativeEmbed(target, entry, ctx.client);
    } catch (error) {
      ctx.log.warn({ err: error, videoId: entry.videoId }, "youtube native embed probe failed");
    }
  }

  if (nativeEmbed && getYouTubeNativeEmbedVideoUrl(nativeEmbed)) {
    return buildYouTubeNotificationPayload(entry, nativeEmbed);
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
      log: ctx.log,
    });
    if (fallback && (fallback as { flags?: number }).flags === MessageFlags.IsComponentsV2) return fallback;
  } catch (error) {
    ctx.log.warn({ err: error, videoId: entry.videoId }, "youtube fallback media resolution failed");
  }

  return buildYouTubeNotificationPayload(entry, nativeEmbed ?? undefined);
}

export async function sendYouTubeWatcherNotification(
  ctx: Pick<BotContext, "client" | "config" | "log">,
  target: GuildTextBasedChannel,
  entry: YouTubeFeedEntry,
  deps: { buildPayload?: typeof buildYouTubeWatcherPayload } = {},
) {
  const buildPayload = deps.buildPayload ?? buildYouTubeWatcherPayload;
  const payload = await buildPayload(ctx, target, entry);
  try {
    return await target.send(payload);
  } catch (error) {
    ctx.log.warn({ err: error, videoId: entry.videoId }, "youtube native notification send failed; retrying without native Embed");
    return await target.send(await buildPayload(ctx, target, entry, { skipNativeEmbed: true }));
  }
}

async function fetchTarget(client: Client, id: string): Promise<GuildTextBasedChannel | null> {
  const channel = await client.channels.fetch(id).catch(() => null);
  if (!channel || !("guildId" in channel) || !channel.isTextBased() || channel.isDMBased() || !channel.isSendable()) return null;
  if (channel.isThread() && (channel.archived || channel.locked)) return null;
  return channel;
}

export async function scanYouTubeWatcher(ctx: BotContext): Promise<void> {
  const client = await ctx.mainPgPool.connect();
  let locked = false;
  try {
  const lock = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(hashtext('youtube_watcher_scan')) AS locked");
  locked = lock.rows[0]?.locked === true;
  if (!locked) return;
  const repo = new PostgresYouTubeWatcherRepository(client);
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
      try {
        await repo.savePost(subscription.id, entry, { status: "pending" });
        const message = await sendYouTubeWatcherNotification(ctx, target, entry);
        sentToDiscord = true;
        await repo.savePost(subscription.id, entry, { status: "sent", messageId: message.id });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!sentToDiscord) await repo.savePost(subscription.id, entry, { status: "failed", error: message });
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
