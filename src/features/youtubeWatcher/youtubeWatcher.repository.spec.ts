import assert from "node:assert/strict";
import test from "node:test";
import {
  ensurePostgresYouTubeWatcherSchema,
  migratePostgresYouTubeVideoCacheReferences,
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

test("video cache reference migration creates durable message references and backfills sent posts", async () => {
  const queries: string[] = [];
  const pool = {
    query: async (sql: string) => {
      queries.push(sql.replace(/\s+/g, " ").trim());
      return { rows: [], rowCount: 0 };
    },
  };
  await migratePostgresYouTubeVideoCacheReferences(pool as never);
  const sql = queries.join("\n");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS youtube_video_cache_references/);
  assert.match(sql, /message_id text PRIMARY KEY/);
  assert.match(sql, /media_mode text NOT NULL CHECK \(media_mode IN \('vps', 'google', 'none'\)\)/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_youtube_video_cache_references_video_mode/);
  assert.match(sql, /FROM youtube_watch_posts p JOIN youtube_watch_subscriptions s ON s\.id = p\.subscription_id/);
  assert.match(sql, /p\.status = 'sent' AND p\.discord_message_id IS NOT NULL/);
  assert.match(sql, /WHEN p\.durable_media_url IS NOT NULL AND p\.durable_media_url <> '' THEN 'vps' ELSE 'none'/);
  assert.match(sql, /ON CONFLICT \(message_id\) DO UPDATE SET video_id = EXCLUDED\.video_id, guild_id = EXCLUDED\.guild_id, channel_id = EXCLUDED\.channel_id, youtube_url = EXCLUDED\.youtube_url, media_mode = EXCLUDED\.media_mode, last_error = EXCLUDED\.last_error, updated_at = EXCLUDED\.updated_at/);
  assert.doesNotMatch(sql, /ON CONFLICT \(message_id\) DO NOTHING/);
});

test("video cache references can be saved, retrieved by video and media mode, updated, and deleted", async () => {
  const calls: Array<{ sql: string; params: unknown[] | undefined }> = [];
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
      if (sql.includes("FROM youtube_video_cache_references") && sql.includes("video_id = $1")) {
        return { rows: [{
          message_id: "message-1",
          video_id: "video-1",
          guild_id: "guild-1",
          channel_id: "channel-1",
          youtube_url: "https://www.youtube.com/watch?v=video-1",
          media_mode: "none",
          last_error: null,
          created_at: new Date("2026-08-10T00:00:00Z"),
          updated_at: new Date("2026-08-10T00:00:00Z"),
        }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
  };
  const repo = new PostgresYouTubeWatcherRepository(pool as never);
  await repo.upsertVideoCacheReference({
    messageId: "message-1",
    videoId: "video-1",
    guildId: "guild-1",
    channelId: "channel-1",
    youtubeUrl: "https://www.youtube.com/watch?v=video-1",
    mediaMode: "none",
    lastError: null,
  });
  assert.deepEqual(calls.at(-1)?.params, [
    "message-1", "video-1", "guild-1", "channel-1", "https://www.youtube.com/watch?v=video-1", "none", null,
  ]);
  assert.deepEqual(await repo.listVideoCacheReferences("video-1", "none"), [{
    messageId: "message-1",
    videoId: "video-1",
    guildId: "guild-1",
    channelId: "channel-1",
    youtubeUrl: "https://www.youtube.com/watch?v=video-1",
    mediaMode: "none",
    lastError: null,
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
  }]);
  assert.deepEqual(calls.at(-1)?.params, ["video-1", "none"]);
  await repo.updateVideoCacheReferenceMedia("message-1", "google", "cache unavailable");
  assert.deepEqual(calls.at(-1)?.params, ["google", "cache unavailable", "message-1"]);
  await repo.deleteVideoCacheReference("message-1");
  assert.deepEqual(calls.at(-1)?.params, ["message-1"]);
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

test("due GoogleVideo retries select only pending none references older than the cutoff", async () => {
  const calls: Array<{ sql: string; params: unknown[] | undefined }> = [];
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
      return { rows: [{
        message_id: "message-pending",
        video_id: "video-pending",
        guild_id: "guild-1",
        channel_id: "channel-1",
        youtube_url: "https://www.youtube.com/watch?v=video-pending",
        media_mode: "none",
        last_error: "googlevideo_pending:timeout",
        created_at: new Date("2026-08-16T00:00:00Z"),
        updated_at: new Date("2026-08-17T00:00:00Z"),
      }], rowCount: 1 };
    },
  };
  const repo = new PostgresYouTubeWatcherRepository(pool as never);
  const cutoff = new Date("2026-08-17T12:00:00Z");
  assert.equal((await repo.listDueGoogleVideoRetries(cutoff, 100))[0]?.messageId, "message-pending");
  assert.match(calls[0]!.sql, /media_mode = 'none'/);
  assert.match(calls[0]!.sql, /LEFT\(last_error, char_length\(\$1\)\) = \$1/);
  assert.match(calls[0]!.sql, /updated_at <= \$2/);
  assert.match(calls[0]!.sql, /ORDER BY updated_at ASC LIMIT \$3/);
  assert.deepEqual(calls[0]!.params, ["googlevideo_pending:", cutoff, 100]);
});

test("VPS cache references can be retrieved for one video", async () => {
  const pool = {
    query: async () => ({ rows: [{
      message_id: "message-1", video_id: "video-1", guild_id: "guild-1", channel_id: "channel-1",
      youtube_url: "https://www.youtube.com/watch?v=video-1", media_mode: "vps", last_error: null,
      created_at: new Date("2026-08-10T00:00:00Z"), updated_at: new Date("2026-08-10T00:00:00Z"),
    }], rowCount: 1 }),
  };
  const repo = new PostgresYouTubeWatcherRepository(pool as never);
  assert.deepEqual(await repo.listVpsVideoCacheReferences("video-1"), [{
    messageId: "message-1", videoId: "video-1", guildId: "guild-1", channelId: "channel-1",
    youtubeUrl: "https://www.youtube.com/watch?v=video-1", mediaMode: "vps", lastError: null,
    createdAt: "2026-08-10T00:00:00.000Z", updatedAt: "2026-08-10T00:00:00.000Z",
  }]);
});

test("video cache repair candidates list only VPS references and the global cache lock uses one session", async () => {
  const calls: Array<{ sql: string; params: unknown[] | undefined }> = [];
  let released = false;
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
      if (sql.includes("FROM youtube_video_cache_references") && sql.includes("media_mode = 'vps'")) {
        return { rows: [{
          message_id: "message-1", video_id: "video-1", guild_id: "guild-1", channel_id: "channel-1",
          youtube_url: "https://www.youtube.com/watch?v=video-1", media_mode: "vps", last_error: null,
          created_at: new Date("2026-08-10T00:00:00Z"), updated_at: new Date("2026-08-10T00:00:00Z"),
        }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
    release: () => { released = true; },
  };
  let connectCalls = 0;
  const repo = new PostgresYouTubeWatcherRepository({
    query: client.query,
    connect: async () => { connectCalls += 1; return client; },
  } as never);
  assert.equal((await repo.listVideoCacheRepairCandidates(1))[0]?.mediaMode, "vps");
  assert.deepEqual(calls.at(-1)?.params, [1]);
  const value = await repo.withVideoCacheLock(async (lockedRepo) => {
    assert.ok(lockedRepo instanceof PostgresYouTubeWatcherRepository);
    await lockedRepo.upsertVideoCacheReference({
      messageId: "message-locked",
      videoId: "video-locked",
      guildId: "guild-1",
      channelId: "channel-1",
      youtubeUrl: "https://www.youtube.com/watch?v=video-locked",
      mediaMode: "vps",
      lastError: null,
    });
    return "saved";
  });
  assert.equal(value, "saved");
  assert.deepEqual(calls.map((call) => call.sql).slice(0, 2), [
    "SELECT message_id, video_id, guild_id, channel_id, youtube_url, media_mode, last_error, created_at, updated_at FROM youtube_video_cache_references WHERE media_mode = 'vps' ORDER BY updated_at ASC LIMIT $1",
    "SELECT pg_advisory_lock(hashtext('youtube_video_cache'))",
  ]);
  assert.match(calls[2]?.sql ?? "", /INSERT INTO youtube_video_cache_references/);
  assert.equal(calls[3]?.sql, "SELECT pg_advisory_unlock(hashtext('youtube_video_cache'))");
  assert.equal(connectCalls, 1);
  assert.equal(released, true);
});

test("global cache session lock unlocks and releases the client when its callback fails", async () => {
  const calls: string[] = [];
  let released = false;
  let releaseError: unknown;
  const client = {
    query: async (sql: string) => {
      calls.push(sql);
      if (sql.includes("pg_advisory_unlock")) throw new Error("unlock failed");
      return { rows: [], rowCount: 0 };
    },
    release: (error?: unknown) => { released = true; releaseError = error; },
  };
  const repo = new PostgresYouTubeWatcherRepository({ connect: async () => client } as never);
  await assert.rejects(
    repo.withVideoCacheLock(async () => { throw new Error("save failed"); }),
    /save failed/,
  );
  assert.deepEqual(calls, [
    "SELECT pg_advisory_lock(hashtext('youtube_video_cache'))",
    "SELECT pg_advisory_unlock(hashtext('youtube_video_cache'))",
  ]);
  assert.equal(released, true);
  assert.match(String((releaseError as Error).message), /unlock failed/);
});

test("daily GoogleVideo retries use a session lock separate from VPS cache maintenance", async () => {
  const calls: string[] = [];
  let released = false;
  const client = {
    query: async (sql: string) => {
      calls.push(sql);
      return { rows: [], rowCount: 0 };
    },
    release: () => { released = true; },
  };
  const repo = new PostgresYouTubeWatcherRepository({ connect: async () => client } as never);
  await repo.withGoogleVideoRetryLock(async (lockedRepo) => {
    assert.ok(lockedRepo instanceof PostgresYouTubeWatcherRepository);
  });
  assert.deepEqual(calls, [
    "SELECT pg_advisory_lock(hashtext('youtube_googlevideo_retry'))",
    "SELECT pg_advisory_unlock(hashtext('youtube_googlevideo_retry'))",
  ]);
  assert.equal(released, true);
});

test("global cache session lock permits a compensation query after a callback SQL failure", async () => {
  const calls: string[] = [];
  let upsertAttempts = 0;
  const client = {
    query: async (sql: string) => {
      calls.push(sql.replace(/\s+/g, " ").trim());
      if (sql.includes("INSERT INTO youtube_video_cache_references") && ++upsertAttempts === 1) {
        throw new Error("first upsert failed");
      }
      return { rows: [], rowCount: 1 };
    },
    release: () => undefined,
  };
  const repo = new PostgresYouTubeWatcherRepository({ connect: async () => client } as never);
  await repo.withVideoCacheLock(async (lockedRepo) => {
    await assert.rejects(lockedRepo.upsertVideoCacheReference({
      messageId: "message-1", videoId: "video-1", guildId: "guild-1", channelId: "channel-1",
      youtubeUrl: "https://www.youtube.com/watch?v=video-1", mediaMode: "vps", lastError: null,
    }), /first upsert failed/);
    await lockedRepo.upsertVideoCacheReference({
      messageId: "message-1", videoId: "video-1", guildId: "guild-1", channelId: "channel-1",
      youtubeUrl: "https://www.youtube.com/watch?v=video-1", mediaMode: "google", lastError: "reference_save_error",
    });
  });
  assert.equal(upsertAttempts, 2);
  assert.equal(calls.at(-1), "SELECT pg_advisory_unlock(hashtext('youtube_video_cache'))");
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
