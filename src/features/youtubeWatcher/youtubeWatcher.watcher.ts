import { type Client, type GuildTextBasedChannel } from "discord.js";
import type { BotContext } from "../../bot/context.js";
import { ComponentCardBuilder, componentCardsPayload } from "../panels/componentCard.js";
import { fetchYouTubeChannelFeed, type YouTubeFeedEntry } from "./youtubeRss.js";
import { PostgresYouTubeWatcherRepository, toUnnotifiedEntries, type YouTubeWatchSubscription } from "./youtubeWatcher.repository.js";

export type YouTubeWatcherController = { scanNow(): Promise<void>; stop(): void };

export function buildYouTubeNotificationPayload(entry: YouTubeFeedEntry) {
  const card = new ComponentCardBuilder()
    .setTitle(entry.title.slice(0, 256))
    .setURL(entry.videoUrl)
    .setDescription(`${entry.channelTitle}\n公開: <t:${Math.floor(Date.parse(entry.publishedAt) / 1000)}:F>`);
  card.setThumbnail(entry.thumbnailUrl);
  return { ...componentCardsPayload([card]), allowedMentions: { parse: [] } };
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
        const message = await target.send(buildYouTubeNotificationPayload(entry));
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
