import type DatabaseLib from "better-sqlite3";
import { sqliteTimestamp } from "../../core/db/sqliteTimestamp.js";
import type { EpicFreeCandidate, EpicNotifyChannel, EpicWatcherStatus } from "./epicFreeTypes.js";

type ChannelRow = {
  guild_id: string;
  channel_id: string;
  enabled: number;
};

type ItemRow = {
  dedupe_key: string;
  notified_at: string | null;
};

type StatusRow = {
  last_scan_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  last_detected_count: number;
};

export function ensureEpicFreeSchema(db: DatabaseLib.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS epic_free_notify_channels (
      guild_id TEXT PRIMARY KEY NOT NULL,
      channel_id TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS epic_free_detected_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      offer_id TEXT,
      namespace TEXT,
      title TEXT NOT NULL,
      detected_type TEXT NOT NULL,
      product_slug TEXT,
      url TEXT NOT NULL,
      image_url TEXT,
      original_price INTEGER,
      discount_price INTEGER,
      currency_code TEXT,
      start_date TEXT,
      end_date TEXT,
      first_detected_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      notified_at TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      dedupe_key TEXT NOT NULL UNIQUE
    );

    CREATE INDEX IF NOT EXISTS idx_epic_free_detected_items_active
      ON epic_free_detected_items (active, last_seen_at);

    CREATE TABLE IF NOT EXISTS epic_free_watcher_status (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_scan_at TEXT,
      last_success_at TEXT,
      last_error TEXT,
      last_detected_count INTEGER NOT NULL DEFAULT 0
    );

    INSERT OR IGNORE INTO epic_free_watcher_status (id, last_detected_count)
    VALUES (1, 0);
  `);
}

function toChannel(row: ChannelRow): EpicNotifyChannel {
  return {
    guildId: row.guild_id,
    channelId: row.channel_id,
    enabled: row.enabled === 1,
  };
}

export class EpicFreeRepository {
  constructor(private readonly db: DatabaseLib.Database) {
    ensureEpicFreeSchema(db);
  }

  getNotifyChannel(guildId: string): EpicNotifyChannel | null {
    const row = this.db
      .prepare<[string], ChannelRow>("SELECT guild_id, channel_id, enabled FROM epic_free_notify_channels WHERE guild_id = ?")
      .get(guildId);
    return row ? toChannel(row) : null;
  }

  listEnabledNotifyChannels(): EpicNotifyChannel[] {
    return this.db
      .prepare<[], ChannelRow>("SELECT guild_id, channel_id, enabled FROM epic_free_notify_channels WHERE enabled = 1")
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
        INSERT INTO epic_free_notify_channels (guild_id, channel_id, enabled, created_at, updated_at)
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
      .prepare("UPDATE epic_free_notify_channels SET enabled = 0, updated_at = ? WHERE guild_id = ?")
      .run(sqliteTimestamp(), guildId);
  }

  getStatus(): EpicWatcherStatus {
    const row = this.db
      .prepare<[], StatusRow>(
        "SELECT last_scan_at, last_success_at, last_error, last_detected_count FROM epic_free_watcher_status WHERE id = 1",
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
        INSERT INTO epic_free_watcher_status (id, last_scan_at, last_detected_count)
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
        INSERT INTO epic_free_watcher_status (id, last_scan_at, last_success_at, last_error, last_detected_count)
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
        INSERT INTO epic_free_watcher_status (id, last_scan_at, last_error, last_detected_count)
        VALUES (1, ?, ?, 0)
        ON CONFLICT(id) DO UPDATE SET
          last_scan_at = excluded.last_scan_at,
          last_error = excluded.last_error
      `,
      )
      .run(now, error.slice(0, 1000));
  }

  upsertSeen(candidate: EpicFreeCandidate, markNotified: boolean): { shouldNotify: boolean } {
    const now = sqliteTimestamp();
    const existing = this.db
      .prepare<[string], ItemRow>("SELECT dedupe_key, notified_at FROM epic_free_detected_items WHERE dedupe_key = ?")
      .get(candidate.dedupeKey);
    const shouldNotify = markNotified && (!existing || !existing.notified_at);
    const notifiedAt = shouldNotify ? now : null;
    if (!existing) {
      this.db
        .prepare(
          `
          INSERT INTO epic_free_detected_items (
            offer_id, namespace, title, detected_type, product_slug, url, image_url,
            original_price, discount_price, currency_code, start_date, end_date,
            first_detected_at, last_seen_at, notified_at, active, dedupe_key
          )
          VALUES (
            @offerId, @namespace, @title, @detectedType, @productSlug, @url, @imageUrl,
            @originalPrice, @discountPrice, @currencyCode, @startDate, @endDate,
            @now, @now, @notifiedAt, 1, @dedupeKey
          )
        `,
        )
        .run({ ...candidate, now, notifiedAt });
      return { shouldNotify };
    }
    this.db
      .prepare(
        `
        UPDATE epic_free_detected_items
        SET title = @title,
            product_slug = @productSlug,
            url = @url,
            image_url = @imageUrl,
            original_price = @originalPrice,
            discount_price = @discountPrice,
            currency_code = @currencyCode,
            start_date = @startDate,
            end_date = @endDate,
            last_seen_at = @now,
            notified_at = CASE WHEN @shouldNotify = 1 THEN @now ELSE notified_at END,
            active = 1
        WHERE dedupe_key = @dedupeKey
      `,
      )
      .run({ ...candidate, now, shouldNotify: shouldNotify ? 1 : 0 });
    return { shouldNotify };
  }

  markNotified(candidate: EpicFreeCandidate): void {
    this.db
      .prepare("UPDATE epic_free_detected_items SET notified_at = ? WHERE dedupe_key = ?")
      .run(sqliteTimestamp(), candidate.dedupeKey);
  }

  markMissingInactive(activeKeys: string[]): void {
    const keep = new Set(activeKeys);
    const rows = this.db
      .prepare<[], Pick<ItemRow, "dedupe_key">>("SELECT dedupe_key FROM epic_free_detected_items WHERE active = 1")
      .all();
    const update = this.db.prepare("UPDATE epic_free_detected_items SET active = 0 WHERE dedupe_key = ?");
    const tx = this.db.transaction((items: typeof rows) => {
      for (const row of items) {
        if (!keep.has(row.dedupe_key)) update.run(row.dedupe_key);
      }
    });
    tx(rows);
  }
}
