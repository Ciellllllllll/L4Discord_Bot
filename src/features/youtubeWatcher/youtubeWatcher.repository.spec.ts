import assert from "node:assert/strict";
import test from "node:test";
import {
  ensurePostgresYouTubeWatcherSchema,
  migratePostgresYouTubeWatcherDurableMedia,
  PostgresYouTubeWatcherRepository,
  toUnnotifiedEntries,
} from "./youtubeWatcher.repository.js";

test("toUnnotifiedEntries includes entries without a sent notification and orders oldest first", () => {
  const entries = [
    { videoId: "new", publishedAt: "2026-07-13T01:00:00.000Z" },
    { videoId: "old", publishedAt: "2026-07-13T00:00:00.000Z" },
  ];
  assert.deepEqual(toUnnotifiedEntries(entries, new Set(["new"])), [entries[1]]);
});

test("YouTube watcher schema and migration add durable media repair columns", async () => {
  const queries: string[] = [];
  const pool = {
    query: async (sql: string) => {
      queries.push(sql.replace(/\s+/g, " ").trim());
      return { rows: [], rowCount: 0 };
    },
  };
  await ensurePostgresYouTubeWatcherSchema(pool as never);
  await migratePostgresYouTubeWatcherDurableMedia(pool as never);
  const sql = queries.join("\n");
  assert.match(sql, /durable_media_url text/);
  assert.match(sql, /media_finalized_at timestamptz/);
  assert.match(sql, /ALTER TABLE youtube_watch_posts ADD COLUMN IF NOT EXISTS durable_media_url text/);
  assert.match(sql, /ALTER TABLE youtube_watch_posts ADD COLUMN IF NOT EXISTS media_finalized_at timestamptz/);
});

test("notification history separates notified videos from ones that failed to post", async () => {
  const calls: Array<{ sql: string; params: unknown[] | undefined }> = [];
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
      return { rows: [
        { video_id: "sent-1", status: "sent" },
        { video_id: "pending-1", status: "pending" },
        { video_id: "failed-1", status: "failed" },
        { video_id: "deferred-1", status: "deferred" },
      ], rowCount: 3 };
    },
  };
  const repo = new PostgresYouTubeWatcherRepository(pool as never);
  const history = await repo.notificationHistory("subscription-1");
  // 送信中（pending）は二重送信を避けるため通知済みとして扱う
  assert.deepEqual([...history.sent].sort(), ["pending-1", "sent-1"]);
  assert.deepEqual([...history.failed], ["failed-1"]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.params, ["subscription-1"]);
});

await test("deferred and failed posts retain feed metadata for retrying after they leave RSS", async () => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const repo = new PostgresYouTubeWatcherRepository({
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      return { rows: [{
        video_id: "early-access", title: "先行公開", channel_title: "チャンネル",
        published_at: new Date("2026-10-18T00:00:00Z"),
        video_url: "https://www.youtube.com/watch?v=early-access", thumbnail_url: null,
      }] };
    },
  } as never);
  const entries = await repo.listRetryablePosts("subscription-1");
  assert.deepEqual(entries, [{
    videoId: "early-access", title: "先行公開", channelTitle: "チャンネル",
    publishedAt: "2026-10-18T00:00:00.000Z",
    videoUrl: "https://www.youtube.com/watch?v=early-access", thumbnailUrl: null,
  }]);
  assert.match(calls[0]!.sql, /status IN \('deferred', 'failed'\)/);
  assert.deepEqual(calls[0]!.params, ["subscription-1"]);
  await repo.savePost("subscription-1", entries[0]!, { status: "deferred" });
  assert.equal(calls[1]!.params?.[8], "deferred");
});

test("repository maps the oldest unfinished media repair and finalizes it", async () => {
  const calls: Array<{ sql: string; params: unknown[] | undefined }> = [];
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
      if (sql.includes("media_finalized_at IS NULL")) {
        return {
          rows: [{
            subscription_id: "subscription-1",
            discord_channel_id: "channel-1",
            discord_message_id: "message-1",
            video_id: "video-1",
            title: "Video title",
            channel_title: "Channel title",
            published_at: new Date("2026-08-10T00:00:00Z"),
            video_url: "https://www.youtube.com/watch?v=video-1",
            thumbnail_url: "https://i.ytimg.com/vi/video-1/hqdefault.jpg",
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    },
  };
  const repo = new PostgresYouTubeWatcherRepository(pool as never);
  assert.deepEqual(await repo.listMediaRepairCandidates(1), [{
    subscriptionId: "subscription-1",
    discordChannelId: "channel-1",
    discordMessageId: "message-1",
    entry: {
      videoId: "video-1",
      title: "Video title",
      channelTitle: "Channel title",
      publishedAt: "2026-08-10T00:00:00.000Z",
      videoUrl: "https://www.youtube.com/watch?v=video-1",
      thumbnailUrl: "https://i.ytimg.com/vi/video-1/hqdefault.jpg",
    },
  }]);
  await repo.finalizeMediaRepair("subscription-1", "video-1", "https://media.example/adhd/video-1.mp4");
  assert.deepEqual(calls.at(-1)?.params, ["https://media.example/adhd/video-1.mp4", "subscription-1", "video-1"]);
});

test("repository lists pending video cache reference recovery candidates with their Discord routing data", async () => {
  const calls: Array<{ sql: string; params: unknown[] | undefined }> = [];
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
      return { rows: [{
        subscription_id: "subscription-1",
        guild_id: "guild-1",
        discord_channel_id: "channel-1",
        discord_message_id: "message-1",
        video_id: "video-1",
        title: "Video title",
        channel_title: "Channel title",
        published_at: new Date("2026-08-10T00:00:00Z"),
        video_url: "https://www.youtube.com/watch?v=video-1",
        thumbnail_url: "https://i.ytimg.com/vi/video-1/hqdefault.jpg",
      }], rowCount: 1 };
    },
  };
  const repo = new PostgresYouTubeWatcherRepository(pool as never);
  assert.deepEqual(await repo.listVideoCacheReferenceRecoveryCandidates(10), [{
    subscriptionId: "subscription-1",
    guildId: "guild-1",
    discordChannelId: "channel-1",
    discordMessageId: "message-1",
    entry: {
      videoId: "video-1",
      title: "Video title",
      channelTitle: "Channel title",
      publishedAt: "2026-08-10T00:00:00.000Z",
      videoUrl: "https://www.youtube.com/watch?v=video-1",
      thumbnailUrl: "https://i.ytimg.com/vi/video-1/hqdefault.jpg",
    },
  }]);
  assert.match(calls[0]!.sql, /p\.status = 'pending' AND p\.discord_message_id IS NOT NULL AND p\.error_message = 'youtube_video_cache_reference_recovery_pending'/);
  assert.deepEqual(calls[0]!.params, [10]);
});
