import { ulid } from "ulid";
import type { Pool, PoolClient } from "pg";
import type { PgQueryable } from "../../core/db/postgres.js";
import type { YouTubeFeedEntry } from "./youtubeRss.js";

export type YouTubeWatchSubscription = {
  id: string;
  guildId: string;
  youtubeChannelId: string;
  sourceUrl: string;
  discordChannelId: string;
  enabled: boolean;
  lastError: string | null;
  updatedAt: string;
};

export function toUnnotifiedEntries<T extends { videoId: string; publishedAt: string }>(entries: T[], sentVideoIds: Set<string>): T[] {
  return entries.filter((entry) => !sentVideoIds.has(entry.videoId)).sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));
}

export async function ensurePostgresYouTubeWatcherSchema(pool: PgQueryable): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS youtube_watch_subscriptions (
      id text PRIMARY KEY, guild_id text NOT NULL, youtube_channel_id text NOT NULL, source_url text NOT NULL,
      discord_channel_id text NOT NULL, enabled boolean NOT NULL DEFAULT true, last_error text,
      created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (guild_id, youtube_channel_id, discord_channel_id)
    );
    CREATE INDEX IF NOT EXISTS idx_youtube_watch_subscriptions_enabled ON youtube_watch_subscriptions (enabled, guild_id);
    CREATE TABLE IF NOT EXISTS youtube_watch_posts (
      subscription_id text NOT NULL REFERENCES youtube_watch_subscriptions(id) ON DELETE CASCADE,
      video_id text NOT NULL, title text NOT NULL, channel_title text NOT NULL, published_at timestamptz NOT NULL,
      video_url text NOT NULL, thumbnail_url text, discord_message_id text, status text NOT NULL, error_message text,
      created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (subscription_id, video_id)
    );
  `);
}

function mapSubscription(row: any): YouTubeWatchSubscription {
  return { id: row.id, guildId: row.guild_id, youtubeChannelId: row.youtube_channel_id, sourceUrl: row.source_url, discordChannelId: row.discord_channel_id, enabled: row.enabled, lastError: row.last_error, updatedAt: new Date(row.updated_at).toISOString() };
}

export class PostgresYouTubeWatcherRepository {
  constructor(private readonly pool: Pool | PoolClient) {}

  async add(input: Omit<YouTubeWatchSubscription, "id" | "enabled" | "lastError" | "updatedAt">): Promise<YouTubeWatchSubscription> {
    const id = ulid();
    const result = await this.pool.query(`
      INSERT INTO youtube_watch_subscriptions (id, guild_id, youtube_channel_id, source_url, discord_channel_id, enabled)
      VALUES ($1, $2, $3, $4, $5, true)
      ON CONFLICT (guild_id, youtube_channel_id, discord_channel_id) DO UPDATE
      SET source_url = EXCLUDED.source_url, enabled = true, last_error = NULL, updated_at = CURRENT_TIMESTAMP
      RETURNING *`, [id, input.guildId, input.youtubeChannelId, input.sourceUrl, input.discordChannelId]);
    return mapSubscription(result.rows[0]);
  }

  async disable(guildId: string, youtubeChannelId: string, discordChannelId: string): Promise<boolean> {
    const result = await this.pool.query("UPDATE youtube_watch_subscriptions SET enabled = false, updated_at = CURRENT_TIMESTAMP WHERE guild_id = $1 AND youtube_channel_id = $2 AND discord_channel_id = $3 AND enabled = true", [guildId, youtubeChannelId, discordChannelId]);
    return (result.rowCount ?? 0) > 0;
  }

  async list(guildId: string, enabledOnly = false): Promise<YouTubeWatchSubscription[]> {
    const result = await this.pool.query(`SELECT * FROM youtube_watch_subscriptions WHERE guild_id = $1 ${enabledOnly ? "AND enabled = true" : ""} ORDER BY updated_at DESC`, [guildId]);
    return result.rows.map(mapSubscription);
  }

  async sentVideoIds(subscriptionId: string): Promise<Set<string>> {
    const result = await this.pool.query("SELECT video_id FROM youtube_watch_posts WHERE subscription_id = $1 AND status IN ('pending', 'sent')", [subscriptionId]);
    return new Set(result.rows.map((row) => row.video_id as string));
  }

  async savePost(subscriptionId: string, entry: YouTubeFeedEntry, input: { status: "pending" | "sent" | "failed"; messageId?: string | null; error?: string | null }): Promise<void> {
    await this.pool.query(`INSERT INTO youtube_watch_posts (subscription_id, video_id, title, channel_title, published_at, video_url, thumbnail_url, discord_message_id, status, error_message)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (subscription_id, video_id) DO UPDATE SET title = EXCLUDED.title, channel_title = EXCLUDED.channel_title, published_at = EXCLUDED.published_at, video_url = EXCLUDED.video_url, thumbnail_url = EXCLUDED.thumbnail_url, discord_message_id = COALESCE(EXCLUDED.discord_message_id, youtube_watch_posts.discord_message_id), status = EXCLUDED.status, error_message = EXCLUDED.error_message, updated_at = CURRENT_TIMESTAMP`,
      [subscriptionId, entry.videoId, entry.title, entry.channelTitle, entry.publishedAt, entry.videoUrl, entry.thumbnailUrl, input.messageId ?? null, input.status, input.error ?? null]);
  }

  async setError(subscriptionId: string, error: string | null): Promise<void> {
    await this.pool.query("UPDATE youtube_watch_subscriptions SET last_error = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2", [error, subscriptionId]);
  }

}
