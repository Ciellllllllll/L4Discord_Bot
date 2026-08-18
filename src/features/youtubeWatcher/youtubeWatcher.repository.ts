import { randomUUID } from "node:crypto";
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

export type YouTubeMediaRepairCandidate = {
  subscriptionId: string;
  discordChannelId: string;
  discordMessageId: string;
  entry: YouTubeFeedEntry;
};

export type YouTubeVideoCacheReferenceRecoveryCandidate = {
  subscriptionId: string;
  guildId: string;
  discordChannelId: string;
  discordMessageId: string;
  entry: YouTubeFeedEntry;
};

export type YouTubeVideoCacheMediaMode = "vps" | "google" | "none";

export const YOUTUBE_GOOGLEVIDEO_PENDING_PREFIX = "googlevideo_pending:";

export function youtubeGoogleVideoPendingError(reason: string): string {
  return `${YOUTUBE_GOOGLEVIDEO_PENDING_PREFIX}${reason}`;
}

export type YouTubeVideoCacheReference = {
  messageId: string;
  videoId: string;
  guildId: string;
  channelId: string;
  youtubeUrl: string;
  mediaMode: YouTubeVideoCacheMediaMode;
  lastError: string | null;
  createdAt: string;
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
      durable_media_url text, media_finalized_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (subscription_id, video_id)
    );
  `);
}

export async function migratePostgresYouTubeWatcherDurableMedia(pool: PgQueryable): Promise<void> {
  await ensurePostgresYouTubeWatcherSchema(pool);
  await pool.query(`
    ALTER TABLE youtube_watch_posts ADD COLUMN IF NOT EXISTS durable_media_url text;
    ALTER TABLE youtube_watch_posts ADD COLUMN IF NOT EXISTS media_finalized_at timestamptz;
  `);
}

export async function migratePostgresYouTubeVideoCacheReferences(pool: PgQueryable): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS youtube_video_cache_references (
      message_id text PRIMARY KEY,
      video_id text NOT NULL,
      guild_id text NOT NULL,
      channel_id text NOT NULL,
      youtube_url text NOT NULL,
      media_mode text NOT NULL CHECK (media_mode IN ('vps', 'google', 'none')),
      last_error text,
      created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_youtube_video_cache_references_video_mode
      ON youtube_video_cache_references (video_id, media_mode);
    CREATE INDEX IF NOT EXISTS idx_youtube_video_cache_references_vps
      ON youtube_video_cache_references (video_id) WHERE media_mode = 'vps';
    INSERT INTO youtube_video_cache_references (
      message_id, video_id, guild_id, channel_id, youtube_url, media_mode, last_error, created_at, updated_at
    )
    SELECT p.discord_message_id, p.video_id, s.guild_id, s.discord_channel_id, p.video_url,
      CASE WHEN p.durable_media_url IS NOT NULL AND p.durable_media_url <> '' THEN 'vps' ELSE 'none' END,
      p.error_message, p.created_at, p.updated_at
    FROM youtube_watch_posts p JOIN youtube_watch_subscriptions s ON s.id = p.subscription_id
    WHERE p.status = 'sent' AND p.discord_message_id IS NOT NULL
    ON CONFLICT (message_id) DO UPDATE SET
      video_id = EXCLUDED.video_id,
      guild_id = EXCLUDED.guild_id,
      channel_id = EXCLUDED.channel_id,
      youtube_url = EXCLUDED.youtube_url,
      media_mode = EXCLUDED.media_mode,
      last_error = EXCLUDED.last_error,
      updated_at = EXCLUDED.updated_at;
  `);
}

function mapSubscription(row: any): YouTubeWatchSubscription {
  return { id: row.id, guildId: row.guild_id, youtubeChannelId: row.youtube_channel_id, sourceUrl: row.source_url, discordChannelId: row.discord_channel_id, enabled: row.enabled, lastError: row.last_error, updatedAt: new Date(row.updated_at).toISOString() };
}

function mapVideoCacheReference(row: any): YouTubeVideoCacheReference {
  return {
    messageId: row.message_id,
    videoId: row.video_id,
    guildId: row.guild_id,
    channelId: row.channel_id,
    youtubeUrl: row.youtube_url,
    mediaMode: row.media_mode,
    lastError: row.last_error,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export class PostgresYouTubeWatcherRepository {
  constructor(private readonly pool: Pool | PoolClient) {}

  async add(input: Omit<YouTubeWatchSubscription, "id" | "enabled" | "lastError" | "updatedAt">): Promise<YouTubeWatchSubscription> {
    const id = randomUUID();
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

  async savePost(subscriptionId: string, entry: YouTubeFeedEntry, input: { status: "pending" | "sent" | "failed"; messageId?: string | null; error?: string | null; durableMediaUrl?: string | null }): Promise<void> {
    await this.pool.query(`INSERT INTO youtube_watch_posts (subscription_id, video_id, title, channel_title, published_at, video_url, thumbnail_url, discord_message_id, status, error_message, durable_media_url, media_finalized_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,CASE WHEN $11::text IS NULL THEN NULL ELSE CURRENT_TIMESTAMP END)
      ON CONFLICT (subscription_id, video_id) DO UPDATE SET title = EXCLUDED.title, channel_title = EXCLUDED.channel_title, published_at = EXCLUDED.published_at, video_url = EXCLUDED.video_url, thumbnail_url = EXCLUDED.thumbnail_url, discord_message_id = COALESCE(EXCLUDED.discord_message_id, youtube_watch_posts.discord_message_id), status = EXCLUDED.status, error_message = EXCLUDED.error_message, durable_media_url = COALESCE(EXCLUDED.durable_media_url, youtube_watch_posts.durable_media_url), media_finalized_at = COALESCE(EXCLUDED.media_finalized_at, youtube_watch_posts.media_finalized_at), updated_at = CURRENT_TIMESTAMP`,
      [subscriptionId, entry.videoId, entry.title, entry.channelTitle, entry.publishedAt, entry.videoUrl, entry.thumbnailUrl, input.messageId ?? null, input.status, input.error ?? null, input.durableMediaUrl ?? null]);
  }

  async listMediaRepairCandidates(limit: number): Promise<YouTubeMediaRepairCandidate[]> {
    const result = await this.pool.query(`
      SELECT p.subscription_id, s.discord_channel_id, p.discord_message_id, p.video_id, p.title,
        p.channel_title, p.published_at, p.video_url, p.thumbnail_url
      FROM youtube_watch_posts p
      JOIN youtube_watch_subscriptions s ON s.id = p.subscription_id
      WHERE p.status = 'sent' AND p.discord_message_id IS NOT NULL AND p.media_finalized_at IS NULL
      ORDER BY p.published_at ASC
      LIMIT $1
    `, [limit]);
    return result.rows.map((row) => ({
      subscriptionId: row.subscription_id as string,
      discordChannelId: row.discord_channel_id as string,
      discordMessageId: row.discord_message_id as string,
      entry: {
        videoId: row.video_id as string,
        title: row.title as string,
        channelTitle: row.channel_title as string,
        publishedAt: new Date(row.published_at).toISOString(),
        videoUrl: row.video_url as string,
        thumbnailUrl: row.thumbnail_url as string | null,
      },
    }));
  }

  async finalizeMediaRepair(subscriptionId: string, videoId: string, durableMediaUrl: string | null): Promise<void> {
    await this.pool.query(`
      UPDATE youtube_watch_posts
      SET durable_media_url = $1, media_finalized_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE subscription_id = $2 AND video_id = $3
    `, [durableMediaUrl, subscriptionId, videoId]);
  }

  async listVideoCacheReferenceRecoveryCandidates(limit: number): Promise<YouTubeVideoCacheReferenceRecoveryCandidate[]> {
    const result = await this.pool.query(`
      SELECT p.subscription_id, s.guild_id, s.discord_channel_id, p.discord_message_id, p.video_id, p.title,
        p.channel_title, p.published_at, p.video_url, p.thumbnail_url
      FROM youtube_watch_posts p
      JOIN youtube_watch_subscriptions s ON s.id = p.subscription_id
      WHERE p.status = 'pending' AND p.discord_message_id IS NOT NULL
        AND p.error_message = 'youtube_video_cache_reference_recovery_pending'
      ORDER BY p.updated_at ASC
      LIMIT $1
    `, [limit]);
    return result.rows.map((row) => ({
      subscriptionId: row.subscription_id as string,
      guildId: row.guild_id as string,
      discordChannelId: row.discord_channel_id as string,
      discordMessageId: row.discord_message_id as string,
      entry: {
        videoId: row.video_id as string,
        title: row.title as string,
        channelTitle: row.channel_title as string,
        publishedAt: new Date(row.published_at).toISOString(),
        videoUrl: row.video_url as string,
        thumbnailUrl: row.thumbnail_url as string | null,
      },
    }));
  }

  async upsertVideoCacheReference(input: Omit<YouTubeVideoCacheReference, "createdAt" | "updatedAt">): Promise<void> {
    await this.pool.query(`
      INSERT INTO youtube_video_cache_references (
        message_id, video_id, guild_id, channel_id, youtube_url, media_mode, last_error
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (message_id) DO UPDATE SET
        video_id = EXCLUDED.video_id,
        guild_id = EXCLUDED.guild_id,
        channel_id = EXCLUDED.channel_id,
        youtube_url = EXCLUDED.youtube_url,
        media_mode = EXCLUDED.media_mode,
        last_error = EXCLUDED.last_error,
        updated_at = CURRENT_TIMESTAMP
    `, [
      input.messageId,
      input.videoId,
      input.guildId,
      input.channelId,
      input.youtubeUrl,
      input.mediaMode,
      input.lastError,
    ]);
  }

  async listVideoCacheReferences(videoId: string, mediaMode?: YouTubeVideoCacheMediaMode): Promise<YouTubeVideoCacheReference[]> {
    const result = await this.pool.query(
      `SELECT message_id, video_id, guild_id, channel_id, youtube_url, media_mode, last_error, created_at, updated_at
       FROM youtube_video_cache_references
       WHERE video_id = $1${mediaMode ? " AND media_mode = $2" : ""}
       ORDER BY created_at ASC`,
      mediaMode ? [videoId, mediaMode] : [videoId],
    );
    return result.rows.map(mapVideoCacheReference);
  }

  async listVpsVideoCacheReferences(videoId?: string): Promise<YouTubeVideoCacheReference[]> {
    const result = await this.pool.query(
      `SELECT message_id, video_id, guild_id, channel_id, youtube_url, media_mode, last_error, created_at, updated_at
       FROM youtube_video_cache_references
       WHERE media_mode = 'vps'${videoId ? " AND video_id = $1" : ""}
       ORDER BY updated_at ASC`,
      videoId ? [videoId] : [],
    );
    return result.rows.map(mapVideoCacheReference);
  }

  async listVideoCacheRepairCandidates(limit: number): Promise<YouTubeVideoCacheReference[]> {
    const result = await this.pool.query(
      "SELECT message_id, video_id, guild_id, channel_id, youtube_url, media_mode, last_error, created_at, updated_at FROM youtube_video_cache_references WHERE media_mode = 'vps' ORDER BY updated_at ASC LIMIT $1",
      [limit],
    );
    return result.rows.map(mapVideoCacheReference);
  }

  async listDueGoogleVideoRetries(cutoff: Date, limit: number): Promise<YouTubeVideoCacheReference[]> {
    const result = await this.pool.query(
      `SELECT message_id, video_id, guild_id, channel_id, youtube_url, media_mode, last_error, created_at, updated_at
       FROM youtube_video_cache_references
       WHERE media_mode = 'none' AND LEFT(last_error, char_length($1)) = $1 AND updated_at <= $2
       ORDER BY updated_at ASC LIMIT $3`,
      [YOUTUBE_GOOGLEVIDEO_PENDING_PREFIX, cutoff, limit],
    );
    return result.rows.map(mapVideoCacheReference);
  }

  async updateVideoCacheReferenceMedia(messageId: string, mediaMode: YouTubeVideoCacheMediaMode, lastError: string | null): Promise<void> {
    await this.pool.query(
      "UPDATE youtube_video_cache_references SET media_mode = $1, last_error = $2, updated_at = CURRENT_TIMESTAMP WHERE message_id = $3",
      [mediaMode, lastError, messageId],
    );
  }

  async deleteVideoCacheReference(messageId: string): Promise<void> {
    await this.pool.query("DELETE FROM youtube_video_cache_references WHERE message_id = $1", [messageId]);
  }

  private async withSessionLock<T>(
    lockName: "youtube_video_cache" | "youtube_googlevideo_retry",
    run: (repo: PostgresYouTubeWatcherRepository) => Promise<T>,
  ): Promise<T> {
    if (!("connect" in this.pool)) throw new Error("session lock requires a PostgreSQL pool");
    const client = await (this.pool as Pool).connect();
    let locked = false;
    let callbackError: unknown;
    let releaseError: Error | undefined;
    try {
      await client.query(`SELECT pg_advisory_lock(hashtext('${lockName}'))`);
      locked = true;
      return await run(new PostgresYouTubeWatcherRepository(client));
    } catch (error) {
      callbackError = error;
      throw error;
    } finally {
      try {
        if (locked) await client.query(`SELECT pg_advisory_unlock(hashtext('${lockName}'))`);
      } catch (unlockError) {
        releaseError = unlockError instanceof Error ? unlockError : new Error(String(unlockError));
        if (!callbackError) throw releaseError;
      } finally {
        client.release(releaseError);
      }
    }
  }

  async withVideoCacheLock<T>(run: (repo: PostgresYouTubeWatcherRepository) => Promise<T>): Promise<T> {
    return this.withSessionLock("youtube_video_cache", run);
  }

  async withGoogleVideoRetryLock<T>(run: (repo: PostgresYouTubeWatcherRepository) => Promise<T>): Promise<T> {
    return this.withSessionLock("youtube_googlevideo_retry", run);
  }

  async setError(subscriptionId: string, error: string | null): Promise<void> {
    await this.pool.query("UPDATE youtube_watch_subscriptions SET last_error = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2", [error, subscriptionId]);
  }

}
