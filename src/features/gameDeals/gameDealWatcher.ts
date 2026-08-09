import type { ButtonInteraction, Client, SendableChannels } from "discord.js";
import { MessageFlags } from "discord.js";
import type { BotContext } from "../../bot/context.js";
import { componentCardsPayload } from "../panels/componentCard.js";
import { buildSubscriptionButtons, buildSubscriptionDealEmbed } from "./gameDealEmbeds.js";
import { checkSubscriptions, scanCurrentFreeGamesDetailed } from "./gameDealScanner.js";
import { createGameDealRepository } from "./postgresGameDealRepository.js";
import { scanSteamNowFullDiscountItems } from "./steamFreeScanner.js";
import type { GameDealFreeItem, GameDealSubscriptionHit } from "./gameDealTypes.js";

const DEFAULT_TICK_INTERVAL_MS = 60 * 1000;
const DEFAULT_STOP_GRACE_MS = 10_000;

export type GameDealWatcherController = {
  stop(): Promise<void>;
};

type GameDealWatcherControllerOptions = {
  intervalMs: number;
  startDelayMs: number;
  stopGraceMs: number;
  tick(signal: AbortSignal): Promise<void>;
  onTickError?(error: unknown): void;
  setTimeout?(callback: () => void, delay: number): NodeJS.Timeout;
  clearTimeout?(timer: NodeJS.Timeout): void;
  setInterval?(callback: () => void, delay: number): NodeJS.Timeout;
  clearInterval?(timer: NodeJS.Timeout): void;
};

export function createGameDealWatcherController(options: GameDealWatcherControllerOptions): GameDealWatcherController {
  const setDelayed = options.setTimeout ?? setTimeout;
  const clearDelayed = options.clearTimeout ?? clearTimeout;
  const setRepeated = options.setInterval ?? setInterval;
  const clearRepeated = options.clearInterval ?? clearInterval;
  let stopped = false;
  let running = false;
  let activeController: AbortController | null = null;
  let inFlight: Promise<void> | null = null;

  const runTick = () => {
    if (stopped || running) return;
    running = true;
    activeController = new AbortController();
    const currentController = activeController;
    inFlight = Promise.resolve()
      .then(() => options.tick(currentController.signal))
      .catch((error) => options.onTickError?.(error))
      .finally(() => {
        if (activeController === currentController) activeController = null;
        running = false;
        inFlight = null;
      });
  };

  const startupTimer = options.startDelayMs <= 0
    ? undefined
    : setDelayed(runTick, options.startDelayMs);
  if (options.startDelayMs <= 0) queueMicrotask(runTick);
  const intervalTimer = setRepeated(runTick, options.intervalMs);

  return {
    async stop(): Promise<void> {
      if (stopped) {
        if (inFlight) await inFlight;
        return;
      }
      stopped = true;
      if (startupTimer) clearDelayed(startupTimer);
      clearRepeated(intervalTimer);
      const current = inFlight;
      if (!current) return;
      let graceExpired = false;
      let graceTimer: NodeJS.Timeout | undefined;
      await Promise.race([
        current,
        new Promise<void>((resolve) => {
          graceTimer = setDelayed(() => {
            graceExpired = true;
            activeController?.abort();
            resolve();
          }, options.stopGraceMs);
        }),
      ]);
      if (graceTimer) clearDelayed(graceTimer);
      if (graceExpired) await current;
    },
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Game deal watcher stopped", "AbortError");
}

function chunkItems(items: GameDealFreeItem[], size = 10): GameDealFreeItem[][] {
  const chunks: GameDealFreeItem[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

async function fetchTextChannel(client: Client, channelId: string): Promise<SendableChannels | null> {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased() || channel.isDMBased() || !channel.isSendable()) return null;
  return channel;
}

function configuredGameDealChannelId(ctx: BotContext): string | null {
  return ctx.config.GAME_DEAL_CHANNEL_ID?.trim() || null;
}

function configuredGameDealRoleId(ctx: BotContext): string | null {
  return ctx.config.GAME_DEAL_NOTIFY_ROLE_ID?.trim() || null;
}

function gameDealRoleMention(ctx: BotContext): string | undefined {
  const roleId = configuredGameDealRoleId(ctx);
  return roleId ? `<@&${roleId}>` : undefined;
}

function gameDealAllowedRoleMentions(ctx: BotContext): { roles?: string[]; parse: [] } {
  const roleId = configuredGameDealRoleId(ctx);
  return roleId ? { roles: [roleId], parse: [] } : { parse: [] };
}

type SubscriptionNotifyGroup = {
  hit: GameDealSubscriptionHit;
  userIds: Set<string>;
  subscriptionIds: string[];
};

type SubscriptionSeenRepository = {
  updateSubscriptionSeen(hit: GameDealSubscriptionHit): Promise<{ shouldNotify: boolean }>;
};

function subscriptionNotifyKey(hit: GameDealSubscriptionHit): string {
  return [
    hit.subscription.guildId,
    hit.subscription.channelId,
    hit.subscription.platform,
    hit.subscription.targetId,
    hit.stateKey,
  ].join(":");
}

export async function groupSubscriptionNotificationHits(
  hits: GameDealSubscriptionHit[],
  repo: SubscriptionSeenRepository,
  signal?: AbortSignal,
): Promise<{ detectedCount: number; groups: Map<string, SubscriptionNotifyGroup> }> {
  const groups = new Map<string, SubscriptionNotifyGroup>();
  let detectedCount = 0;
  for (const hit of hits) {
    throwIfAborted(signal);
    detectedCount += 1;
    if (!(await repo.updateSubscriptionSeen(hit)).shouldNotify) continue;
    const key = subscriptionNotifyKey(hit);
    const group = groups.get(key);
    if (group) {
      group.userIds.add(hit.subscription.userId);
      group.subscriptionIds.push(hit.subscription.id);
    } else {
      groups.set(key, {
        hit,
        userIds: new Set([hit.subscription.userId]),
        subscriptionIds: [hit.subscription.id],
      });
    }
  }
  return { detectedCount, groups };
}

export async function scanAndNotifyGameDeals(ctx: BotContext): Promise<void> {
  const steamNowItems = await scanSteamNowFullDiscountItems(ctx, undefined, { onlyUnnotified: true });
  const scan = await scanCurrentFreeGamesDetailed(ctx);
  await notifyFreeGameDealItems(ctx, [...steamNowItems, ...scan.items.filter((item) => item.platform === "epic")]);
}

async function notifyFreeGameDealItems(ctx: BotContext, freeItems: GameDealFreeItem[], signal?: AbortSignal): Promise<number> {
  const repo = createGameDealRepository(ctx);
  const configuredChannelId = configuredGameDealChannelId(ctx);
  if (freeItems.length === 0) return 0;
  if (!configuredChannelId) {
    ctx.log.warn(
      { botProfile: ctx.config.BOT_PROFILE, itemCount: freeItems.length },
      "game deal free notification skipped because profile GAME_DEAL_CHANNEL_ID is not configured",
    );
    return 0;
  }
  const channels = await repo.listEnabledNotifyChannels();
  if (channels.length === 0) {
    ctx.log.warn({ itemCount: freeItems.length }, "game deal free notification skipped because no guild has enabled notify channel");
    return 0;
  }
  const notifyItems: GameDealFreeItem[] = [];
  for (const item of freeItems) {
    throwIfAborted(signal);
    if (item.platform === "steam") {
      notifyItems.push(item);
      continue;
    }
    if ((await repo.upsertFreeSeen(item, true)).shouldNotify) {
      notifyItems.push(item);
    }
  }
  if (notifyItems.length === 0) return 0;
  let sentCount = 0;
  const channel = await fetchTextChannel(ctx.client, configuredChannelId);
  if (!channel) {
    ctx.log.warn({ channelId: configuredChannelId }, "game deal notify channel unavailable");
    return 0;
  }
  const roleMention = gameDealRoleMention(ctx);
  if (roleMention) {
    throwIfAborted(signal);
    await channel
      .send({ content: roleMention, allowedMentions: gameDealAllowedRoleMentions(ctx) })
      .catch((err) => ctx.log.warn({ err }, "game deal free role mention send failed"));
  }
  for (const chunk of chunkItems(notifyItems)) {
    throwIfAborted(signal);
    if (chunk.some((item) => item.components && item.components.length > 0)) {
      for (const item of chunk) {
        throwIfAborted(signal);
        const sent = await channel
          .send({
            ...componentCardsPayload([item.embed], item.components ?? []),
            allowedMentions: { parse: [] },
          })
          .catch((err) => {
            ctx.log.warn({ err }, "game deal free notification send failed");
            return null;
        });
        if (sent) {
          throwIfAborted(signal);
          sentCount += 1;
          if (item.platform === "steam") await repo.markSteamFreeEventNotified(item.dedupeKey);
          else await repo.markFreeNotified(item.dedupeKey);
        }
      }
    } else {
      const sent = await channel
        .send({
          ...componentCardsPayload(chunk.map((item) => item.embed)),
          allowedMentions: { parse: [] },
        })
        .catch((err) => {
          ctx.log.warn({ err }, "game deal free notification send failed");
          return null;
        });
      if (sent) {
        throwIfAborted(signal);
        sentCount += chunk.length;
        for (const item of chunk) {
          if (item.platform === "steam") await repo.markSteamFreeEventNotified(item.dedupeKey);
          else await repo.markFreeNotified(item.dedupeKey);
        }
      }
    }
  }
  return sentCount;
}

async function scanAndNotifySubscriptions(ctx: BotContext, signal?: AbortSignal): Promise<number> {
  const repo = createGameDealRepository(ctx);
  const configuredChannelId = configuredGameDealChannelId(ctx);
  let detectedCount = 0;

  const subscriptions = await repo.listActiveSubscriptions();
  const hits = await checkSubscriptions(ctx, subscriptions, { signal }).catch((err) => {
    if (signal?.aborted) throw err;
    ctx.log.warn({ err }, "game deal subscription check failed");
    return [] as GameDealSubscriptionHit[];
  });
  const grouped = await groupSubscriptionNotificationHits(hits, repo, signal);
  detectedCount = grouped.detectedCount;

  for (const group of grouped.groups.values()) {
    throwIfAborted(signal);
    const { hit } = group;
    if (!configuredChannelId) {
      ctx.log.warn(
        { botProfile: ctx.config.BOT_PROFILE, subscriptionIds: group.subscriptionIds },
        "game deal subscription notification skipped because profile GAME_DEAL_CHANNEL_ID is not configured",
      );
      continue;
    }
    const channel = await fetchTextChannel(ctx.client, configuredChannelId);
    if (!channel) continue;
    const users = [...group.userIds];
    const notificationId = await repo.createTargetNotification({
      guildId: hit.subscription.guildId,
      platform: hit.subscription.platform,
      targetId: hit.subscription.targetId,
      subscriptionId: group.subscriptionIds[0]!,
      userId: users[0]!,
    });
    await channel
      .send({
        content: `${users.map((userId) => `<@${userId}>`).join(" ")} 登録したゲームが割引されています!`,
        allowedMentions: { users },
      })
      .catch((err) => {
        ctx.log.warn({ err, subscriptionIds: group.subscriptionIds }, "game deal subscription mention send failed");
      });
    const sent = await channel
      .send({
        ...componentCardsPayload([buildSubscriptionDealEmbed(hit)], [buildSubscriptionButtons(notificationId)]),
        allowedMentions: { parse: [] },
      })
      .catch((err) => {
        ctx.log.warn({ err, subscriptionIds: group.subscriptionIds }, "game deal subscription notification send failed");
        return null;
      });
    if (sent) await repo.setNotificationMessage(notificationId, sent.id);
  }
  return detectedCount;
}

export function startGameDealWatcher(ctx: BotContext, intervalMs = DEFAULT_TICK_INTERVAL_MS): GameDealWatcherController {
  let lastSteamNowAt = 0;
  let lastEpicAt = 0;
  let lastSubscriptionAt = 0;
  const tick = async (signal: AbortSignal) => {
    throwIfAborted(signal);
    const repo = createGameDealRepository(ctx);
    await repo.markScanStarted();
    await repo.updateDealStatus({ lastScanAt: new Date().toISOString() });
    let detectedCount = 0;
    let notifiedCount = 0;
    try {
      const now = Date.now();
      throwIfAborted(signal);
      if (now - lastSteamNowAt >= ctx.config.GAME_DEAL_STEAM_NOW_INTERVAL_MS) {
        lastSteamNowAt = now;
        const steamNowItems = await scanSteamNowFullDiscountItems(ctx, undefined, { onlyUnnotified: true, signal }).catch((err) => {
          if (!signal.aborted) ctx.log.warn({ err }, "steam now full discount scheduled scan failed");
          return [];
        });
        detectedCount += steamNowItems.length;
        notifiedCount += await notifyFreeGameDealItems(ctx, steamNowItems, signal);
      }
      throwIfAborted(signal);
      if (now - lastEpicAt >= ctx.config.GAME_DEAL_EPIC_INTERVAL_MS) {
        lastEpicAt = now;
        const scan = await scanCurrentFreeGamesDetailed(ctx, { signal }).catch((err) => {
          if (!signal.aborted) ctx.log.warn({ err }, "epic scheduled scan failed");
          return { items: [], sources: [] };
        });
        const epicItems = scan.items.filter((item) => item.platform === "epic");
        detectedCount += epicItems.length;
        notifiedCount += await notifyFreeGameDealItems(ctx, epicItems, signal);
      }
      throwIfAborted(signal);
      if (now - lastSubscriptionAt >= ctx.config.GAME_DEAL_SUBSCRIPTION_INTERVAL_MS) {
        lastSubscriptionAt = now;
        detectedCount += await scanAndNotifySubscriptions(ctx, signal);
      }
      throwIfAborted(signal);
      const successAt = new Date().toISOString();
      await repo.markScanSuccess(detectedCount, successAt);
      await repo.updateDealStatus({ lastScanAt: successAt, lastSuccessAt: successAt, lastError: null, lastDetectedCount: detectedCount });
      ctx.log.info({ detectedCount, notifiedCount }, "game deal watcher tick completed");
    } catch (err) {
      if (signal.aborted) {
        ctx.log.info("game deal watcher stopped");
        return;
      }
      await repo.markScanError(err instanceof Error ? err.message : String(err));
      await repo.updateDealStatus({ lastError: err instanceof Error ? err.message : String(err) });
      ctx.log.warn({ err }, "game deal watcher tick failed");
    }
  };
  ctx.log.debug(
    {
      intervalMs,
      botProfile: ctx.config.BOT_PROFILE,
      gameDealChannelId: configuredGameDealChannelId(ctx),
      gameDealNotifyRoleId: configuredGameDealRoleId(ctx),
    },
    "game deal watcher started",
  );
  return createGameDealWatcherController({
    intervalMs,
    startDelayMs: 8_000,
    stopGraceMs: DEFAULT_STOP_GRACE_MS,
    tick,
    onTickError: (err) => ctx.log.warn({ err }, "game deal watcher tick failed"),
  });
}

export async function handleGameDealButton(interaction: ButtonInteraction, ctx: BotContext): Promise<boolean> {
  const [domain, action, notificationId] = interaction.customId.split(":");
  if (domain !== "gameDeals" || !action || !notificationId) return false;
  const repo = createGameDealRepository(ctx);
  const row = await repo.getNotification(notificationId);
  if (!row) {
    await interaction.reply({ content: "この通知は処理できません。", flags: MessageFlags.Ephemeral });
    return true;
  }
  if (action === "purchase" && row.guildId && row.targetPlatform && row.targetId) {
    const changes = await repo.deactivateSubscriptionForTargetUser({
      guildId: row.guildId,
      userId: interaction.user.id,
      platform: row.targetPlatform,
      targetId: row.targetId,
    });
    await interaction.reply({
      content: changes > 0 ? "購入済みとして、このゲームの今後の通知を停止しました。" : "このゲームはあなたの監視リストにありません。",
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }
  if (interaction.user.id !== row.userId) {
    await interaction.reply({ content: "このボタンは登録したユーザーのみ使用できます。", flags: MessageFlags.Ephemeral });
    return true;
  }
  if (row.actionPressed) {
    await interaction.reply({ content: "この通知は既に処理済みです。", flags: MessageFlags.Ephemeral });
    return true;
  }
  await repo.markNotificationPressed(notificationId, action);
  if (action === "stop") {
    await repo.deactivateSubscription(row.subscriptionId);
  }
  await interaction.update({ components: [] });
  return true;
}
