import type DatabaseLib from "better-sqlite3";
import { sqliteTimestamp } from "../../core/db/sqliteTimestamp.js";
import { buildSteamStateKey } from "./steamFreeDetector.js";
import type {
  SteamFreeCandidate,
  SteamFreeDetectedType,
  SteamFreeStoredItem,
  SteamNotifyChannel,
  SteamWatcherStatus,
} from "./steamFreeTypes.js";

type ChannelRow = {
  guild_id: string;
  channel_id: string;
  enabled: number;
};

type ItemRow = {
  appid: string;
  name: string;
  detected_type: SteamFreeDetectedType;
  original_price: number | null;
  final_price: number | null;
  discount_percent: number | null;
  store_url: string;
  image_url: string | null;
  state_key: string;
  first_detected_at: string;
  last_seen_at: string;
  notified_at: string | null;
  active: number;
};

type StatusRow = {
  last_scan_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  last_detected_count: number;
};

export function ensureSteamFreeSchema(db: DatabaseLib.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS steam_free_notify_channels (
      guild_id TEXT PRIMARY KEY NOT NULL,
      channel_id TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS steam_free_detected_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      appid TEXT NOT NULL,
      name TEXT NOT NULL,
      detected_type TEXT NOT NULL,
      original_price INTEGER,
      final_price INTEGER,
      discount_percent INTEGER,
      store_url TEXT NOT NULL,
      image_url TEXT,
      state_key TEXT NOT NULL,
      first_detected_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      notified_at TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      UNIQUE(appid, detected_type)
    );

    CREATE INDEX IF NOT EXISTS idx_steam_free_detected_items_active
      ON steam_free_detected_items (active, last_seen_at);

    CREATE INDEX IF NOT EXISTS idx_steam_free_detected_items_state
      ON steam_free_detected_items (appid, detected_type, state_key);

    CREATE TABLE IF NOT EXISTS steam_free_watcher_status (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_scan_at TEXT,
      last_success_at TEXT,
      last_error TEXT,
      last_detected_count INTEGER NOT NULL DEFAULT 0
    );

    INSERT OR IGNORE INTO steam_free_watcher_status (id, last_detected_count)
    VALUES (1, 0);
  `);
}

function toChannel(row: ChannelRow): SteamNotifyChannel {
  return {
    guildId: row.guild_id,
    channelId: row.channel_id,
    enabled: row.enabled === 1,
  };
}

function toStored(row: ItemRow): SteamFreeStoredItem {
  return {
    appid: row.appid,
    name: row.name,
    detectedType: row.detected_type,
    originalPrice: row.original_price,
    finalPrice: row.final_price,
    discountPercent: row.discount_percent,
    storeUrl: row.store_url,
    imageUrl: row.image_url,
    source: "steam_search_appdetails",
    confidence: "medium",
    stateKey: row.state_key,
    firstDetectedAt: row.first_detected_at,
    lastSeenAt: row.last_seen_at,
    notifiedAt: row.notified_at,
    active: row.active === 1,
  };
}

export class SteamFreeRepository {
  constructor(private readonly db: DatabaseLib.Database) {
    ensureSteamFreeSchema(db);
  }

  getNotifyChannel(guildId: string): SteamNotifyChannel | null {
    const row = this.db
      .prepare<[string], ChannelRow>("SELECT guild_id, channel_id, enabled FROM steam_free_notify_channels WHERE guild_id = ?")
      .get(guildId);
    return row ? toChannel(row) : null;
  }

  listEnabledNotifyChannels(): SteamNotifyChannel[] {
    return this.db
      .prepare<[], ChannelRow>("SELECT guild_id, channel_id, enabled FROM steam_free_notify_channels WHERE enabled = 1")
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
        INSERT INTO steam_free_notify_channels (guild_id, channel_id, enabled, created_at, updated_at)
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
    const now = sqliteTimestamp();
    this.db
      .prepare("UPDATE steam_free_notify_channels SET enabled = 0, updated_at = ? WHERE guild_id = ?")
      .run(now, guildId);
  }

  getStatus(): SteamWatcherStatus {
    const row = this.db
      .prepare<[], StatusRow>(
        "SELECT last_scan_at, last_success_at, last_error, last_detected_count FROM steam_free_watcher_status WHERE id = 1",
      )
      .get();
    return {
      lastScanAt: row?.last_scan_at ?? null,
      lastSuccessAt: row?.last_success_at ?? null,
      lastError: row?.last_error ?? null,
      lastDetectedCount: row?.last_detected_count ?? 0,
    };
  }

  markScanStarted(now = sqliteTimestamp()): void {
    this.db
      .prepare(
        `
        INSERT INTO steam_free_watcher_status (id, last_scan_at, last_detected_count)
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
        INSERT INTO steam_free_watcher_status (id, last_scan_at, last_success_at, last_error, last_detected_count)
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
        INSERT INTO steam_free_watcher_status (id, last_scan_at, last_error, last_detected_count)
        VALUES (1, ?, ?, 0)
        ON CONFLICT(id) DO UPDATE SET
          last_scan_at = excluded.last_scan_at,
          last_error = excluded.last_error
      `,
      )
      .run(now, error.slice(0, 1000));
  }

  upsertSeen(candidate: SteamFreeCandidate, markNotified: boolean): { shouldNotify: boolean; stateChanged: boolean } {
    const now = sqliteTimestamp();
    const stateKey = buildSteamStateKey(candidate);
    const row = this.db
      .prepare<[string, SteamFreeDetectedType], ItemRow>(
        `
        SELECT appid, name, detected_type, original_price, final_price, discount_percent, store_url,
               image_url, state_key, first_detected_at, last_seen_at, notified_at, active
        FROM steam_free_detected_items
        WHERE appid = ? AND detected_type = ?
      `,
      )
      .get(candidate.appid, candidate.detectedType);
    const notifiedAt = markNotified ? now : null;
    if (!row) {
      this.db
        .prepare(
          `
          INSERT INTO steam_free_detected_items (
            appid, name, detected_type, original_price, final_price, discount_percent, store_url,
            image_url, state_key, first_detected_at, last_seen_at, notified_at, active
          )
          VALUES (
            @appid, @name, @detectedType, @originalPrice, @finalPrice, @discountPercent, @storeUrl,
            @imageUrl, @stateKey, @now, @now, @notifiedAt, 1
          )
        `,
        )
        .run({ ...candidate, stateKey, now, notifiedAt });
      return { shouldNotify: markNotified, stateChanged: true };
    }
    const stateChanged = row.state_key !== stateKey;
    const shouldNotify = markNotified && (!row.notified_at || stateChanged);
    const nextStateKey = markNotified ? stateKey : row.state_key;
    this.db
      .prepare(
        `
        UPDATE steam_free_detected_items
        SET name = @name,
            original_price = @originalPrice,
            final_price = @finalPrice,
            discount_percent = @discountPercent,
            store_url = @storeUrl,
            image_url = @imageUrl,
            state_key = @nextStateKey,
            last_seen_at = @now,
            notified_at = CASE WHEN @shouldNotify = 1 THEN @now ELSE notified_at END,
            active = 1
        WHERE appid = @appid AND detected_type = @detectedType
      `,
      )
      .run({ ...candidate, stateKey, nextStateKey, now, shouldNotify: shouldNotify ? 1 : 0 });
    return { shouldNotify, stateChanged };
  }

  markNotified(candidate: SteamFreeCandidate): void {
    const now = sqliteTimestamp();
    const stateKey = buildSteamStateKey(candidate);
    this.db
      .prepare(
        `
        UPDATE steam_free_detected_items
        SET notified_at = ?, state_key = ?
        WHERE appid = ? AND detected_type = ?
      `,
      )
      .run(now, stateKey, candidate.appid, candidate.detectedType);
  }

  markMissingInactive(activeKeys: Array<{ appid: string; detectedType: SteamFreeDetectedType }>): void {
    const keep = new Set(activeKeys.map((k) => `${k.appid}:${k.detectedType}`));
    const rows = this.db
      .prepare<[], Pick<ItemRow, "appid" | "detected_type">>(
        "SELECT appid, detected_type FROM steam_free_detected_items WHERE active = 1",
      )
      .all();
    const update = this.db.prepare("UPDATE steam_free_detected_items SET active = 0 WHERE appid = ? AND detected_type = ?");
    const tx = this.db.transaction((items: typeof rows) => {
      for (const row of items) {
        if (!keep.has(`${row.appid}:${row.detected_type}`)) update.run(row.appid, row.detected_type);
      }
    });
    tx(rows);
  }

  listRecentActive(limit = 10): SteamFreeStoredItem[] {
    return this.db
      .prepare<[], ItemRow>(
        `
        SELECT appid, name, detected_type, original_price, final_price, discount_percent, store_url,
               image_url, state_key, first_detected_at, last_seen_at, notified_at, active
        FROM steam_free_detected_items
        WHERE active = 1
        ORDER BY last_seen_at DESC
        LIMIT ${Math.max(1, Math.min(50, limit))}
      `,
      )
      .all()
      .map(toStored);
  }
}
