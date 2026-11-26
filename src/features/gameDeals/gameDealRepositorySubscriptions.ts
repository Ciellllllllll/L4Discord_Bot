import { randomUUID } from "node:crypto";
import { nowIso } from "../../core/db/nowIso.js";
import type {
  GameDealPlatform,
  GameDealSubscription,
  GameDealSubscriptionHit,
} from "./gameDealTypes.js";
import { type NotificationRow, type SubRow, toSub } from "./gameDealRepositoryShared.js";
import { GameDealRepositoryChannels } from "./gameDealRepositoryChannels.js";

// ゲームセール通知の購読と通知履歴。

export class GameDealRepositorySubscriptions extends GameDealRepositoryChannels {
  async addSubscription(input: {
    guildId: string;
    channelId: string;
    userId: string;
    platform: GameDealPlatform;
    targetId: string;
    url: string;
    title?: string | null;
  }): Promise<GameDealSubscription> {
    const now = nowIso();
    const id = randomUUID();
    const result = await this.pool.query<SubRow>(
      `
      INSERT INTO game_deal_subscriptions
        (id, guild_id, channel_id, user_id, platform, target_id, url, title, created_at, updated_at)
      VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
      RETURNING id, guild_id, channel_id, user_id, platform, target_id, url, title, last_state_key, active
    `,
      [id, input.guildId, input.channelId, input.userId, input.platform, input.targetId, input.url, input.title ?? null, now],
    );
    return toSub(result.rows[0]);
  }

  async listActiveSubscriptions(): Promise<GameDealSubscription[]> {
    const result = await this.pool.query<SubRow>(`
      SELECT id, guild_id, channel_id, user_id, platform, target_id, url, title, last_state_key, active
      FROM game_deal_subscriptions
      WHERE active = true
    `);
    return result.rows.map(toSub);
  }

  async listActiveSubscriptionsForUser(guildId: string, userId: string): Promise<GameDealSubscription[]> {
    const result = await this.pool.query<SubRow>(
      `
      SELECT id, guild_id, channel_id, user_id, platform, target_id, url, title, last_state_key, active
      FROM game_deal_subscriptions
      WHERE active = true AND guild_id = $1 AND user_id = $2
      ORDER BY updated_at DESC
    `,
      [guildId, userId],
    );
    return result.rows.map(toSub);
  }

  async updateSubscriptionSeen(hit: GameDealSubscriptionHit): Promise<{ shouldNotify: boolean }> {
    const shouldNotify = hit.subscription.lastStateKey !== hit.stateKey;
    await this.pool.query(
      `
      UPDATE game_deal_subscriptions
      SET title = $1,
          last_state_key = $2,
          last_notified_at = CASE WHEN $3 THEN $4 ELSE last_notified_at END,
          updated_at = $4
      WHERE id = $5
    `,
      [hit.title, hit.stateKey, shouldNotify, nowIso(), hit.subscription.id],
    );
    return { shouldNotify };
  }

  async createNotification(subscriptionId: string, userId: string): Promise<string> {
    const id = randomUUID();
    await this.pool.query(
      `
      INSERT INTO game_deal_subscription_notifications (id, subscription_id, user_id, created_at)
      VALUES ($1, $2, $3, $4)
    `,
      [id, subscriptionId, userId, nowIso()],
    );
    return id;
  }

  async createTargetNotification(input: {
    guildId: string;
    platform: GameDealPlatform;
    targetId: string;
    subscriptionId: string;
    userId: string;
  }): Promise<string> {
    const id = randomUUID();
    await this.pool.query(
      `
      INSERT INTO game_deal_subscription_notifications
        (id, subscription_id, user_id, guild_id, target_platform, target_id, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `,
      [id, input.subscriptionId, input.userId, input.guildId, input.platform, input.targetId, nowIso()],
    );
    return id;
  }

  async setNotificationMessage(notificationId: string, messageId: string): Promise<void> {
    await this.pool.query("UPDATE game_deal_subscription_notifications SET message_id = $1 WHERE id = $2", [
      messageId,
      notificationId,
    ]);
  }

  async getNotification(notificationId: string): Promise<{
    subscriptionId: string;
    userId: string;
    actionPressed: string | null;
    guildId: string | null;
    targetPlatform: GameDealPlatform | null;
    targetId: string | null;
  } | null> {
    const result = await this.pool.query<NotificationRow>(
      `
      SELECT subscription_id, user_id, action_pressed, guild_id, target_platform, target_id
      FROM game_deal_subscription_notifications
      WHERE id = $1
    `,
      [notificationId],
    );
    const row = result.rows[0];
    return row
      ? {
          subscriptionId: row.subscription_id,
          userId: row.user_id,
          actionPressed: row.action_pressed,
          guildId: row.guild_id,
          targetPlatform: row.target_platform,
          targetId: row.target_id,
        }
      : null;
  }

  async markNotificationPressed(notificationId: string, action: string): Promise<void> {
    await this.pool.query(
      "UPDATE game_deal_subscription_notifications SET action_pressed = $1, pressed_at = $2 WHERE id = $3",
      [action, nowIso(), notificationId],
    );
  }

  async deactivateSubscription(subscriptionId: string): Promise<void> {
    await this.pool.query("UPDATE game_deal_subscriptions SET active = false, updated_at = $1 WHERE id = $2", [
      nowIso(),
      subscriptionId,
    ]);
  }

  async deactivateSubscriptionForTargetUser(input: {
    guildId: string;
    userId: string;
    platform: GameDealPlatform;
    targetId: string;
  }): Promise<number> {
    const result = await this.pool.query(
      `
      UPDATE game_deal_subscriptions
      SET active = false, updated_at = $1
      WHERE guild_id = $2
        AND user_id = $3
        AND platform = $4
        AND target_id = $5
        AND active = true
    `,
      [nowIso(), input.guildId, input.userId, input.platform, input.targetId],
    );
    return result.rowCount ?? 0;
  }
}
