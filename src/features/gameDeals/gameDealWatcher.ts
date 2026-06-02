import type { ButtonInteraction, Client, SendableChannels } from "discord.js";
import { MessageFlags } from "discord.js";
import type { BotContext } from "../../bot/context.js";
import { buildSubscriptionButtons, buildSubscriptionDealEmbed } from "./gameDealEmbeds.js";
import { GameDealRepository } from "./gameDealRepository.js";
import { checkSubscription, scanCurrentFreeGamesDetailed } from "./gameDealScanner.js";
import type { GameDealFreeItem, GameDealSubscriptionHit } from "./gameDealTypes.js";

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;

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

function subscriptionNotifyKey(hit: GameDealSubscriptionHit): string {
  return [
    hit.subscription.guildId,
    hit.subscription.channelId,
    hit.subscription.platform,
    hit.subscription.targetId,
    hit.stateKey,
  ].join(":");
}

export async function scanAndNotifyGameDeals(ctx: BotContext): Promise<void> {
  const repo = new GameDealRepository(ctx.sqlite);
  repo.markScanStarted();
  repo.updateDealStatus({ lastScanAt: new Date().toISOString() });
  const configuredChannelId = configuredGameDealChannelId(ctx);
  let detectedCount = 0;
  try {
    const channels = repo.listEnabledNotifyChannels();
    if (channels.length > 0 && configuredChannelId) {
      const scan = await scanCurrentFreeGamesDetailed(ctx);
      const freeItems = scan.items;
      detectedCount += freeItems.length;
      const notifyItems = freeItems.filter((item) => repo.upsertFreeSeen(item, true).shouldNotify);
      for (const config of channels) {
        const channel = await fetchTextChannel(ctx.client, configuredChannelId);
        if (!channel) {
          ctx.log.warn({ guildId: config.guildId, channelId: configuredChannelId }, "game deal notify channel unavailable");
          repo.disableNotifyChannel(config.guildId);
          continue;
        }
        const roleMention = gameDealRoleMention(ctx);
        if (notifyItems.length > 0 && roleMention) {
          await channel
            .send({ content: roleMention, allowedMentions: gameDealAllowedRoleMentions(ctx) })
            .catch((err) => ctx.log.warn({ err }, "game deal free role mention send failed"));
        }
        for (const chunk of chunkItems(notifyItems)) {
          if (chunk.some((item) => item.components && item.components.length > 0)) {
            for (const item of chunk) {
              await channel
                .send({
                  embeds: [item.embed],
                  components: item.components ?? [],
                  allowedMentions: { parse: [] },
                })
                .catch((err) => ctx.log.warn({ err }, "game deal free notification send failed"));
              repo.markFreeNotified(item.dedupeKey);
            }
          } else {
            await channel
              .send({
                embeds: chunk.map((item) => item.embed),
                allowedMentions: { parse: [] },
              })
              .catch((err) => ctx.log.warn({ err }, "game deal free notification send failed"));
            for (const item of chunk) repo.markFreeNotified(item.dedupeKey);
          }
        }
      }
    }

    const subNotifyGroups = new Map<string, SubscriptionNotifyGroup>();
    for (const sub of repo.listActiveSubscriptions()) {
      const hit = await checkSubscription(ctx, sub).catch((err) => {
        ctx.log.warn({ err, subscriptionId: sub.id }, "game deal subscription check failed");
        return null;
      });
      if (!hit) continue;
      detectedCount += 1;
      if (!repo.updateSubscriptionSeen(hit).shouldNotify) continue;
      const key = subscriptionNotifyKey(hit);
      const group = subNotifyGroups.get(key);
      if (group) {
        group.userIds.add(sub.userId);
        group.subscriptionIds.push(sub.id);
      } else {
        subNotifyGroups.set(key, {
          hit,
          userIds: new Set([sub.userId]),
          subscriptionIds: [sub.id],
        });
      }
    }

    for (const group of subNotifyGroups.values()) {
      const { hit } = group;
      if (!configuredChannelId) {
        ctx.log.warn({ subscriptionIds: group.subscriptionIds }, "game deal subscription notification skipped because GAME_DEAL_CHANNEL_ID is not configured");
        continue;
      }
      const channel = await fetchTextChannel(ctx.client, configuredChannelId);
      if (!channel) continue;
      const users = [...group.userIds];
      const notificationId = repo.createTargetNotification({
        guildId: hit.subscription.guildId,
        platform: hit.subscription.platform,
        targetId: hit.subscription.targetId,
        subscriptionId: group.subscriptionIds[0]!,
        userId: users[0]!,
      });
      const sent = await channel
        .send({
          content: `${users.map((userId) => `<@${userId}>`).join(" ")} 登録したゲームが割引されています!`,
          embeds: [buildSubscriptionDealEmbed(hit)],
          components: [buildSubscriptionButtons(notificationId)],
          allowedMentions: { users },
        })
        .catch((err) => {
          ctx.log.warn({ err, subscriptionIds: group.subscriptionIds }, "game deal subscription notification send failed");
          return null;
        });
      if (sent) repo.setNotificationMessage(notificationId, sent.id);
    }
    const successAt = new Date().toISOString();
    repo.markScanSuccess(detectedCount, successAt);
    repo.updateDealStatus({ lastScanAt: successAt, lastSuccessAt: successAt, lastError: null, lastDetectedCount: detectedCount });
  } catch (err) {
    repo.markScanError(err instanceof Error ? err.message : String(err));
    repo.updateDealStatus({ lastError: err instanceof Error ? err.message : String(err) });
    ctx.log.warn({ err }, "game deal watcher scan failed");
  }
}

export function startGameDealWatcher(ctx: BotContext, intervalMs = DEFAULT_INTERVAL_MS): NodeJS.Timeout {
  let running = false;
  const tick = async () => {
    if (running) {
      ctx.log.warn("game deal watcher tick skipped because previous scan is still running");
      return;
    }
    running = true;
    try {
      await scanAndNotifyGameDeals(ctx);
    } finally {
      running = false;
    }
  };
  ctx.log.info({ intervalMs }, "game deal watcher started");
  setTimeout(() => void tick().catch((err) => ctx.log.warn({ err }, "game deal startup scan failed")), 8_000);
  return setInterval(() => void tick().catch((err) => ctx.log.warn({ err }, "game deal watcher tick failed")), intervalMs);
}

export async function handleGameDealButton(interaction: ButtonInteraction, ctx: BotContext): Promise<boolean> {
  const [domain, action, notificationId] = interaction.customId.split(":");
  if (domain !== "gameDeals" || !action || !notificationId) return false;
  const repo = new GameDealRepository(ctx.sqlite);
  const row = repo.getNotification(notificationId);
  if (!row) {
    await interaction.reply({ content: "この通知は処理できません。", flags: MessageFlags.Ephemeral });
    return true;
  }
  if (action === "purchase" && row.guildId && row.targetPlatform && row.targetId) {
    const changes = repo.deactivateSubscriptionForTargetUser({
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
  repo.markNotificationPressed(notificationId, action);
  if (action === "stop") {
    repo.deactivateSubscription(row.subscriptionId);
  }
  await interaction.update({ components: [] });
  return true;
}
