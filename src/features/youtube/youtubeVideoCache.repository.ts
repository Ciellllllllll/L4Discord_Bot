import type { PgQueryable } from "../../core/db/postgres.js";
import type { Pool, PoolClient } from "pg";

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

/** youtube_video_cache_references の読み書き。元は PostgresYouTubeWatcherRepository にあった部分。 */
export class PostgresYouTubeVideoCacheRepository {
  constructor(private readonly pool: Pool | PoolClient) {}

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
    run: (repo: PostgresYouTubeVideoCacheRepository) => Promise<T>,
  ): Promise<T> {
    if (!("connect" in this.pool)) throw new Error("session lock requires a PostgreSQL pool");
    const client = await (this.pool as Pool).connect();
    let locked = false;
    let callbackError: unknown;
    let releaseError: Error | undefined;
    try {
      await client.query(`SELECT pg_advisory_lock(hashtext('${lockName}'))`);
      locked = true;
      return await run(new PostgresYouTubeVideoCacheRepository(client));
    } catch (error) {
      callbackError = error;
      throw error;
    } finally {
      try {
        if (locked) await client.query(`SELECT pg_advisory_unlock(hashtext('${lockName}'))`);
      } catch (unlockError) {
        releaseError = unlockError instanceof Error ? unlockError : new Error(String(unlockError));
        // eslint-disable-next-line no-unsafe-finally -- surface unlock failure only when the callback itself succeeded
        if (!callbackError) throw releaseError;
      } finally {
        client.release(releaseError);
      }
    }
  }

  async withVideoCacheLock<T>(run: (repo: PostgresYouTubeVideoCacheRepository) => Promise<T>): Promise<T> {
    return this.withSessionLock("youtube_video_cache", run);
  }

  async withGoogleVideoRetryLock<T>(run: (repo: PostgresYouTubeVideoCacheRepository) => Promise<T>): Promise<T> {
    return this.withSessionLock("youtube_googlevideo_retry", run);
  }
}
