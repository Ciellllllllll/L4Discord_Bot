import type DatabaseLib from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { sqliteTimestamp } from "../../core/db/sqliteTimestamp.js";
import type {
  DealWatchItem,
  GameDealNotifyChannel,
  GameDealPlatform,
  GameDealStatus,
  GameDealSubscription,
  GameDealSubscriptionHit,
} from "./gameDealTypes.js";
import type { CheapSharkDeal } from "./cheapSharkTypes.js";

type ChannelRow = {
  guild_id: string;
  channel_id: string;
  enabled: number;
};

type StatusRow = {
  last_scan_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  last_detected_count: number;
  last_steam_search_status: string | null;
  last_steam_search_error: string | null;
  steam_search_cooldown_until: string | null;
};

type SubRow = {
  id: string;
  guild_id: string;
  channel_id: string;
  user_id: string;
  platform: GameDealPlatform;
  target_id: string;
  url: string;
  title: string | null;
  last_state_key: string | null;
  active: number;
};

type DealWatchRow = {
  id: number;
  guild_id: string;
  channel_id: string | null;
  steam_app_id: string;
  title: string | null;
  last_deal_id: string | null;
  last_sale_price: number | null;
  last_normal_price: number | null;
  last_savings: number | null;
  last_change: number | null;
  last_checked_at: string | null;
  last_notified_at: string | null;
  enabled: number;
};

export function ensureGameDealSchema(db: DatabaseLib.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS game_deal_notify_channels (
      guild_id TEXT PRIMARY KEY NOT NULL,
      channel_id TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS game_deal_detected_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      title TEXT NOT NULL,
      dedupe_key TEXT NOT NULL UNIQUE,
      first_detected_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      notified_at TEXT,
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS game_deal_watcher_status (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_scan_at TEXT,
      last_success_at TEXT,
      last_error TEXT,
      last_detected_count INTEGER NOT NULL DEFAULT 0
    );

    INSERT OR IGNORE INTO game_deal_watcher_status (id, last_detected_count)
    VALUES (1, 0);

    CREATE TABLE IF NOT EXISTS game_deal_subscriptions (
      id TEXT PRIMARY KEY NOT NULL,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      target_id TEXT NOT NULL,
      url TEXT NOT NULL,
      title TEXT,
      last_state_key TEXT,
      last_notified_at TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_game_deal_subscriptions_active
      ON game_deal_subscriptions (active, guild_id);

    CREATE TABLE IF NOT EXISTS game_deal_subscription_notifications (
      id TEXT PRIMARY KEY NOT NULL,
      subscription_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      message_id TEXT,
      action_pressed TEXT,
      pressed_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS deal_watch_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      channel_id TEXT,
      steam_app_id TEXT NOT NULL,
      title TEXT,
      last_deal_id TEXT,
      last_sale_price REAL,
      last_normal_price REAL,
      last_savings REAL,
      last_change INTEGER,
      last_checked_at TEXT,
      last_notified_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      UNIQUE(guild_id, steam_app_id)
    );

    CREATE TABLE IF NOT EXISTS deal_detected_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      detected_type TEXT NOT NULL,
      deal_id TEXT,
      steam_app_id TEXT,
      title TEXT NOT NULL,
      sale_price REAL,
      normal_price REAL,
      savings REAL,
      last_change INTEGER,
      cheapshark_url TEXT,
      steam_url TEXT,
      image_url TEXT,
      dedupe_key TEXT NOT NULL UNIQUE,
      first_detected_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      notified_at TEXT,
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS game_deal_status (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_scan_at TEXT,
      last_success_at TEXT,
      last_error TEXT,
      last_detected_count INTEGER NOT NULL DEFAULT 0,
      cheapshark_cooldown_until TEXT
    );

    INSERT OR IGNORE INTO game_deal_status (id, last_detected_count)
    VALUES (1, 0);
  `);
  ensureColumn(db, "game_deal_watcher_status", "last_steam_search_status", "TEXT");
  ensureColumn(db, "game_deal_watcher_status", "last_steam_search_error", "TEXT");
  ensureColumn(db, "game_deal_watcher_status", "steam_search_cooldown_until", "TEXT");
}

function ensureColumn(db: DatabaseLib.Database, table: string, column: string, definition: string): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!rows.some((row) => row.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function toChannel(row: ChannelRow): GameDealNotifyChannel {
  return { guildId: row.guild_id, channelId: row.channel_id, enabled: row.enabled === 1 };
}

function toSub(row: SubRow): GameDealSubscription {
  return {
    id: row.id,
    guildId: row.guild_id,
    channelId: row.channel_id,
    userId: row.user_id,
    platform: row.platform,
    targetId: row.target_id,
    url: row.url,
    title: row.title,
    lastStateKey: row.last_state_key,
    active: row.active === 1,
  };
}

function toDealWatch(row: DealWatchRow): DealWatchItem {
  return {
    id: row.id,
    guildId: row.guild_id,
    channelId: row.channel_id,
    steamAppId: row.steam_app_id,
    title: row.title,
    lastDealId: row.last_deal_id,
    lastSalePrice: row.last_sale_price,
    lastNormalPrice: row.last_normal_price,
    lastSavings: row.last_savings,
    lastChange: row.last_change,
    lastCheckedAt: row.last_checked_at,
    lastNotifiedAt: row.last_notified_at,
    enabled: row.enabled === 1,
  };
}

export class GameDealRepository {
  constructor(private readonly db: DatabaseLib.Database) {
    ensureGameDealSchema(db);
  }

  getNotifyChannel(guildId: string): GameDealNotifyChannel | null {
    const row = this.db
      .prepare<[string], ChannelRow>("SELECT guild_id, channel_id, enabled FROM game_deal_notify_channels WHERE guild_id = ?")
      .get(guildId);
    return row ? toChannel(row) : null;
  }

  listEnabledNotifyChannels(): GameDealNotifyChannel[] {
    return this.db
      .prepare<[], ChannelRow>("SELECT guild_id, channel_id, enabled FROM game_deal_notify_channels WHERE enabled = 1")
      .all()
      .map(toChannel);
  }

  enableNotifyChannel(guildId: string, channelId: string): { alreadyEnabledInChannel: boolean } {
    const now = sqliteTimestamp();
    const existing = this.getNotifyChannel(guildId);
    if (existing?.enabled && existing.channelId === channelId) return { alreadyEnabledInChannel: true };
    this.db
      .prepare(
        `
        INSERT INTO game_deal_notify_channels (guild_id, channel_id, enabled, created_at, updated_at)
        VALUES (@guildId, @channelId, 1, @now, @now)
        ON CONFLICT(guild_id) DO UPDATE SET
          channel_id = excluded.channel_id,
          enabled = 1,
          updated_at = excluded.updated_at
      `,
      )
      .run({ guildId, channelId, now });
    return { alreadyEnabledInChannel: false };
  }

  disableNotifyChannel(guildId: string): void {
    this.db
      .prepare("UPDATE game_deal_notify_channels SET enabled = 0, updated_at = ? WHERE guild_id = ?")
      .run(sqliteTimestamp(), guildId);
  }

  getStatus(): GameDealStatus {
    const row = this.db
      .prepare<[], StatusRow>(
        `
        SELECT last_scan_at, last_success_at, last_error, last_detected_count,
               last_steam_search_status, last_steam_search_error, steam_search_cooldown_until
        FROM game_deal_watcher_status
        WHERE id = 1
      `,
      )
      .get();
    return {
      lastScanAt: row?.last_scan_at ?? null,
      lastSuccessAt: row?.last_success_at ?? null,
      lastError: row?.last_error ?? null,
      lastDetectedCount: row?.last_detected_count ?? 0,
      lastSteamSearchStatus: row?.last_steam_search_status ?? null,
      lastSteamSearchError: row?.last_steam_search_error ?? null,
      steamSearchCooldownUntil: row?.steam_search_cooldown_until ?? null,
    };
  }

  markScanStarted(now = sqliteTimestamp()): void {
    this.db
      .prepare(
        `
        INSERT INTO game_deal_watcher_status (id, last_scan_at, last_detected_count)
        VALUES (1, ?, 0)
        ON CONFLICT(id) DO UPDATE SET last_scan_at = excluded.last_scan_at
      `,
      )
      .run(now);
  }

  markScanSuccess(count: number, now = sqliteTimestamp()): void {
    this.db
      .prepare(
        `
        INSERT INTO game_deal_watcher_status (id, last_scan_at, last_success_at, last_error, last_detected_count)
        VALUES (1, ?, ?, NULL, ?)
        ON CONFLICT(id) DO UPDATE SET
          last_scan_at = excluded.last_scan_at,
          last_success_at = excluded.last_success_at,
          last_error = NULL,
          last_detected_count = excluded.last_detected_count
      `,
      )
      .run(now, now, count);
  }

  markScanError(error: string, now = sqliteTimestamp()): void {
    this.db
      .prepare(
        `
        INSERT INTO game_deal_watcher_status (id, last_scan_at, last_error, last_detected_count)
        VALUES (1, ?, ?, 0)
        ON CONFLICT(id) DO UPDATE SET
          last_scan_at = excluded.last_scan_at,
          last_error = excluded.last_error
      `,
      )
      .run(now, error.slice(0, 1000));
  }

  getSteamSearchCooldownUntil(): string | null {
    const row = this.db
      .prepare<[], { steam_search_cooldown_until: string | null }>(
        "SELECT steam_search_cooldown_until FROM game_deal_watcher_status WHERE id = 1",
      )
      .get();
    return row?.steam_search_cooldown_until ?? null;
  }

  updateSteamSearchStatus(input: { status: string; error: string | null; cooldownUntil: string | null }): void {
    this.db
      .prepare(
        `
        INSERT INTO game_deal_watcher_status
          (id, last_detected_count, last_steam_search_status, last_steam_search_error, steam_search_cooldown_until)
        VALUES (1, 0, @status, @error, @cooldownUntil)
        ON CONFLICT(id) DO UPDATE SET
          last_steam_search_status = excluded.last_steam_search_status,
          last_steam_search_error = excluded.last_steam_search_error,
          steam_search_cooldown_until = excluded.steam_search_cooldown_until
      `,
      )
      .run({
        status: input.status,
        error: input.error?.slice(0, 1000) ?? null,
        cooldownUntil: input.cooldownUntil,
      });
  }

  upsertFreeSeen(input: { platform: GameDealPlatform; title: string; dedupeKey: string }, markNotified: boolean): { shouldNotify: boolean } {
    const now = sqliteTimestamp();
    const row = this.db
      .prepare<[string], { notified_at: string | null }>("SELECT notified_at FROM game_deal_detected_items WHERE dedupe_key = ?")
      .get(input.dedupeKey);
    const shouldNotify = markNotified && (!row || !row.notified_at);
    if (!row) {
      this.db
        .prepare(
          `
          INSERT INTO game_deal_detected_items
            (platform, title, dedupe_key, first_detected_at, last_seen_at, notified_at, active)
          VALUES (@platform, @title, @dedupeKey, @now, @now, @notifiedAt, 1)
        `,
        )
        .run({ ...input, now, notifiedAt: shouldNotify ? now : null });
      return { shouldNotify };
    }
    this.db
      .prepare(
        `
        UPDATE game_deal_detected_items
        SET title = @title,
            last_seen_at = @now,
            notified_at = CASE WHEN @shouldNotify = 1 THEN @now ELSE notified_at END,
            active = 1
        WHERE dedupe_key = @dedupeKey
      `,
      )
      .run({ ...input, now, shouldNotify: shouldNotify ? 1 : 0 });
    return { shouldNotify };
  }

  markFreeNotified(dedupeKey: string): void {
    this.db.prepare("UPDATE game_deal_detected_items SET notified_at = ? WHERE dedupe_key = ?").run(sqliteTimestamp(), dedupeKey);
  }

  addSubscription(input: {
    guildId: string;
    channelId: string;
    userId: string;
    platform: GameDealPlatform;
    targetId: string;
    url: string;
    title?: string | null;
  }): GameDealSubscription {
    const now = sqliteTimestamp();
    const id = randomUUID();
    this.db
      .prepare(
        `
        INSERT INTO game_deal_subscriptions
          (id, guild_id, channel_id, user_id, platform, target_id, url, title, created_at, updated_at)
        VALUES
          (@id, @guildId, @channelId, @userId, @platform, @targetId, @url, @title, @now, @now)
      `,
      )
      .run({ ...input, id, title: input.title ?? null, now });
    return {
      id,
      guildId: input.guildId,
      channelId: input.channelId,
      userId: input.userId,
      platform: input.platform,
      targetId: input.targetId,
      url: input.url,
      title: input.title ?? null,
      lastStateKey: null,
      active: true,
    };
  }

  listActiveSubscriptions(): GameDealSubscription[] {
    return this.db
      .prepare<[], SubRow>(
        `
        SELECT id, guild_id, channel_id, user_id, platform, target_id, url, title, last_state_key, active
        FROM game_deal_subscriptions
        WHERE active = 1
      `,
      )
      .all()
      .map(toSub);
  }

  listActiveSubscriptionsForUser(guildId: string, userId: string): GameDealSubscription[] {
    return this.db
      .prepare<[string, string], SubRow>(
        `
        SELECT id, guild_id, channel_id, user_id, platform, target_id, url, title, last_state_key, active
        FROM game_deal_subscriptions
        WHERE active = 1 AND guild_id = ? AND user_id = ?
        ORDER BY updated_at DESC
      `,
      )
      .all(guildId, userId)
      .map(toSub);
  }

  updateSubscriptionSeen(hit: GameDealSubscriptionHit): { shouldNotify: boolean } {
    const shouldNotify = hit.subscription.lastStateKey !== hit.stateKey;
    this.db
      .prepare(
        `
        UPDATE game_deal_subscriptions
        SET title = @title,
            last_state_key = @stateKey,
            last_notified_at = CASE WHEN @shouldNotify = 1 THEN @now ELSE last_notified_at END,
            updated_at = @now
        WHERE id = @id
      `,
      )
      .run({
        id: hit.subscription.id,
        title: hit.title,
        stateKey: hit.stateKey,
        shouldNotify: shouldNotify ? 1 : 0,
        now: sqliteTimestamp(),
      });
    return { shouldNotify };
  }

  createNotification(subscriptionId: string, userId: string): string {
    const id = randomUUID();
    this.db
      .prepare(
        `
        INSERT INTO game_deal_subscription_notifications (id, subscription_id, user_id, created_at)
        VALUES (?, ?, ?, ?)
      `,
      )
      .run(id, subscriptionId, userId, sqliteTimestamp());
    return id;
  }

  setNotificationMessage(notificationId: string, messageId: string): void {
    this.db
      .prepare("UPDATE game_deal_subscription_notifications SET message_id = ? WHERE id = ?")
      .run(messageId, notificationId);
  }

  getNotification(notificationId: string): { subscriptionId: string; userId: string; actionPressed: string | null } | null {
    const row = this.db
      .prepare<[string], { subscription_id: string; user_id: string; action_pressed: string | null }>(
        "SELECT subscription_id, user_id, action_pressed FROM game_deal_subscription_notifications WHERE id = ?",
      )
      .get(notificationId);
    return row ? { subscriptionId: row.subscription_id, userId: row.user_id, actionPressed: row.action_pressed } : null;
  }

  markNotificationPressed(notificationId: string, action: string): void {
    this.db
      .prepare("UPDATE game_deal_subscription_notifications SET action_pressed = ?, pressed_at = ? WHERE id = ?")
      .run(action, sqliteTimestamp(), notificationId);
  }

  deactivateSubscription(subscriptionId: string): void {
    this.db
      .prepare("UPDATE game_deal_subscriptions SET active = 0, updated_at = ? WHERE id = ?")
      .run(sqliteTimestamp(), subscriptionId);
  }

  upsertDetectedDeal(input: { source: string; detectedType: string; deal: CheapSharkDeal; dedupeKey: string; markNotified: boolean }): { shouldNotify: boolean } {
    const now = sqliteTimestamp();
    const row = this.db
      .prepare<[string], { notified_at: string | null }>("SELECT notified_at FROM deal_detected_items WHERE dedupe_key = ?")
      .get(input.dedupeKey);
    const shouldNotify = input.markNotified && (!row || !row.notified_at);
    if (!row) {
      this.db
        .prepare(
          `
          INSERT INTO deal_detected_items (
            source, detected_type, deal_id, steam_app_id, title, sale_price, normal_price, savings,
            last_change, cheapshark_url, steam_url, image_url, dedupe_key, first_detected_at,
            last_seen_at, notified_at, active
          )
          VALUES (
            @source, @detectedType, @dealId, @steamAppId, @title, @salePrice, @normalPrice, @savings,
            @lastChange, @cheapSharkUrl, @steamUrl, @imageUrl, @dedupeKey, @now, @now, @notifiedAt, 1
          )
        `,
        )
        .run({
          source: input.source,
          detectedType: input.detectedType,
          dealId: input.deal.dealId,
          steamAppId: input.deal.steamAppId,
          title: input.deal.title,
          salePrice: input.deal.salePrice,
          normalPrice: input.deal.normalPrice,
          savings: input.deal.savings,
          lastChange: input.deal.lastChange,
          cheapSharkUrl: input.deal.cheapSharkUrl,
          steamUrl: input.deal.steamUrl,
          imageUrl: input.deal.thumb,
          dedupeKey: input.dedupeKey,
          now,
          notifiedAt: shouldNotify ? now : null,
        });
      return { shouldNotify };
    }
    this.db
      .prepare(
        `
        UPDATE deal_detected_items
        SET last_seen_at = @now,
            notified_at = CASE WHEN @shouldNotify = 1 THEN @now ELSE notified_at END,
            active = 1
        WHERE dedupe_key = @dedupeKey
      `,
      )
      .run({ now, shouldNotify: shouldNotify ? 1 : 0, dedupeKey: input.dedupeKey });
    return { shouldNotify };
  }

  addDealWatch(input: { guildId: string; channelId: string; steamAppId: string; deal: CheapSharkDeal | null }): { created: boolean; item: DealWatchItem } {
    const existing = this.getDealWatch(input.guildId, input.steamAppId);
    if (existing?.enabled) return { created: false, item: existing };
    const now = sqliteTimestamp();
    this.db
      .prepare(
        `
        INSERT INTO deal_watch_items (
          guild_id, channel_id, steam_app_id, title, last_deal_id, last_sale_price, last_normal_price,
          last_savings, last_change, last_checked_at, created_at, updated_at, enabled
        )
        VALUES (
          @guildId, @channelId, @steamAppId, @title, @lastDealId, @lastSalePrice, @lastNormalPrice,
          @lastSavings, @lastChange, @now, @now, @now, 1
        )
        ON CONFLICT(guild_id, steam_app_id) DO UPDATE SET
          channel_id = excluded.channel_id,
          title = excluded.title,
          last_deal_id = excluded.last_deal_id,
          last_sale_price = excluded.last_sale_price,
          last_normal_price = excluded.last_normal_price,
          last_savings = excluded.last_savings,
          last_change = excluded.last_change,
          last_checked_at = excluded.last_checked_at,
          updated_at = excluded.updated_at,
          enabled = 1
      `,
      )
      .run({
        guildId: input.guildId,
        channelId: input.channelId,
        steamAppId: input.steamAppId,
        title: input.deal?.title ?? null,
        lastDealId: input.deal?.dealId ?? null,
        lastSalePrice: input.deal?.salePrice ?? null,
        lastNormalPrice: input.deal?.normalPrice ?? null,
        lastSavings: input.deal?.savings ?? null,
        lastChange: input.deal?.lastChange ?? null,
        now,
      });
    return { created: true, item: this.getDealWatch(input.guildId, input.steamAppId)! };
  }

  getDealWatch(guildId: string, steamAppId: string): DealWatchItem | null {
    const row = this.db
      .prepare<[string, string], DealWatchRow>(
        `
        SELECT id, guild_id, channel_id, steam_app_id, title, last_deal_id, last_sale_price,
               last_normal_price, last_savings, last_change, last_checked_at, last_notified_at, enabled
        FROM deal_watch_items
        WHERE guild_id = ? AND steam_app_id = ?
      `,
      )
      .get(guildId, steamAppId);
    return row ? toDealWatch(row) : null;
  }

  listDealWatches(guildId: string): DealWatchItem[] {
    return this.db
      .prepare<[string], DealWatchRow>(
        `
        SELECT id, guild_id, channel_id, steam_app_id, title, last_deal_id, last_sale_price,
               last_normal_price, last_savings, last_change, last_checked_at, last_notified_at, enabled
        FROM deal_watch_items
        WHERE guild_id = ? AND enabled = 1
        ORDER BY updated_at DESC
      `,
      )
      .all(guildId)
      .map(toDealWatch);
  }

  listAllDealWatches(): DealWatchItem[] {
    return this.db
      .prepare<[], DealWatchRow>(
        `
        SELECT id, guild_id, channel_id, steam_app_id, title, last_deal_id, last_sale_price,
               last_normal_price, last_savings, last_change, last_checked_at, last_notified_at, enabled
        FROM deal_watch_items
        WHERE enabled = 1
      `,
      )
      .all()
      .map(toDealWatch);
  }

  disableDealWatch(guildId: string, steamAppId: string): number {
    const result = this.db
      .prepare("UPDATE deal_watch_items SET enabled = 0, updated_at = ? WHERE guild_id = ? AND steam_app_id = ? AND enabled = 1")
      .run(sqliteTimestamp(), guildId, steamAppId);
    return result.changes;
  }

  updateDealWatchChecked(item: DealWatchItem, deal: CheapSharkDeal | null, notified: boolean): void {
    const now = sqliteTimestamp();
    this.db
      .prepare(
        `
        UPDATE deal_watch_items
        SET title = COALESCE(@title, title),
            last_deal_id = @lastDealId,
            last_sale_price = @lastSalePrice,
            last_normal_price = @lastNormalPrice,
            last_savings = @lastSavings,
            last_change = @lastChange,
            last_checked_at = @now,
            last_notified_at = CASE WHEN @notified = 1 THEN @now ELSE last_notified_at END,
            updated_at = @now
        WHERE id = @id
      `,
      )
      .run({
        id: item.id,
        title: deal?.title ?? null,
        lastDealId: deal?.dealId ?? null,
        lastSalePrice: deal?.salePrice ?? null,
        lastNormalPrice: deal?.normalPrice ?? null,
        lastSavings: deal?.savings ?? null,
        lastChange: deal?.lastChange ?? null,
        notified: notified ? 1 : 0,
        now,
      });
  }

  getDealStatus(): GameDealStatus {
    const base = this.getStatus();
    const row = this.db
      .prepare<[], { cheapshark_cooldown_until: string | null }>(
        "SELECT cheapshark_cooldown_until FROM game_deal_status WHERE id = 1",
      )
      .get();
    return { ...base, cheapSharkCooldownUntil: row?.cheapshark_cooldown_until ?? null };
  }

  updateDealStatus(input: { lastScanAt?: string; lastSuccessAt?: string | null; lastError?: string | null; lastDetectedCount?: number; cheapSharkCooldownUntil?: string | null }): void {
    this.db
      .prepare(
        `
        INSERT INTO game_deal_status (id, last_detected_count)
        VALUES (1, 0)
        ON CONFLICT(id) DO NOTHING
      `,
      )
      .run();
    this.db
      .prepare(
        `
        UPDATE game_deal_status
        SET last_scan_at = COALESCE(@lastScanAt, last_scan_at),
            last_success_at = CASE WHEN @lastSuccessAtSet = 1 THEN @lastSuccessAt ELSE last_success_at END,
            last_error = CASE WHEN @lastErrorSet = 1 THEN @lastError ELSE last_error END,
            last_detected_count = COALESCE(@lastDetectedCount, last_detected_count),
            cheapshark_cooldown_until = CASE WHEN @cooldownSet = 1 THEN @cheapSharkCooldownUntil ELSE cheapshark_cooldown_until END
        WHERE id = 1
      `,
      )
      .run({
        lastScanAt: input.lastScanAt ?? null,
        lastSuccessAtSet: input.lastSuccessAt !== undefined ? 1 : 0,
        lastSuccessAt: input.lastSuccessAt ?? null,
        lastErrorSet: input.lastError !== undefined ? 1 : 0,
        lastError: input.lastError ?? null,
        lastDetectedCount: input.lastDetectedCount ?? null,
        cooldownSet: input.cheapSharkCooldownUntil !== undefined ? 1 : 0,
        cheapSharkCooldownUntil: input.cheapSharkCooldownUntil ?? null,
      });
  }

  getCheapSharkCooldownUntil(): string | null {
    const row = this.db
      .prepare<[], { cheapshark_cooldown_until: string | null }>(
        "SELECT cheapshark_cooldown_until FROM game_deal_status WHERE id = 1",
      )
      .get();
    return row?.cheapshark_cooldown_until ?? null;
  }
}
