import assert from "node:assert/strict";
import { ComponentType } from "discord.js";
import {
  cacheYouTubeWatcherVideo,
  recoverYouTubeWatcherVideoCacheReferenceCandidate,
  scanYouTubeWatcher,
  saveYouTubeWatcherVideoCacheReference,
  saveYouTubeWatcherReferenceRecoveryPending,
  shouldMarkYouTubeWatcherPostFailed,
  startYouTubeWatcher,
} from "./youtubeWatcher.watcher.js";
import { YouTubeVideoCacheReferenceRecoveryError } from "../youtube/youtubeVideoCacheMaintenance.js";
import type { YouTubeFeedEntry } from "./youtubeRss.js";

const entry = {
  videoId: "video-1",
  title: "T".repeat(300),
  channelTitle: "テストチャンネル",
  publishedAt: "2026-08-06T12:34:56Z",
  videoUrl: "https://www.youtube.com/watch?v=video-1",
  thumbnailUrl: "https://i.ytimg.com/vi/video-1/maxresdefault.jpg",
};

// 実際のスキャンを通し、Discord送信前の保留と、RSSから消えた後の再確認を検証する。
{
  const posts = new Map<string, { entry: typeof entry; status: string }>();
  const sent: string[] = [];
  let releases = 0;
  const subscription = {
    id: "availability-sub", guild_id: "guild-1", youtube_channel_id: "availability-channel",
    source_url: "https://www.youtube.com/channel/availability-channel", discord_channel_id: "channel-1",
    enabled: true, last_error: null, updated_at: new Date(),
  };
  const query = async (sql: string, params: unknown[] = []) => {
    if (sql.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }] };
    if (sql.includes("pg_advisory_unlock")) return { rows: [{ unlocked: true }] };
    if (sql.includes("SELECT * FROM youtube_watch_subscriptions")) return { rows: [subscription] };
    if (sql.includes("SELECT video_id, status")) return { rows: [...posts].map(([video_id, post]) => ({ video_id, status: post.status })) };
    if (sql.includes("status IN ('deferred', 'failed')")) return { rows: [...posts.values()].filter((post) => post.status === "deferred" || post.status === "failed").map(({ entry: video }) => ({
      video_id: video.videoId, title: video.title, channel_title: video.channelTitle,
      published_at: video.publishedAt, video_url: video.videoUrl, thumbnail_url: video.thumbnailUrl,
    })) };
    if (sql.startsWith("INSERT INTO youtube_watch_posts")) {
      posts.set(params[1] as string, {
        entry: { videoId: params[1], title: params[2], channelTitle: params[3], publishedAt: params[4], videoUrl: params[5], thumbnailUrl: params[6] } as typeof entry,
        status: params[8] as string,
      });
      return { rows: [] };
    }
    if (sql.startsWith("UPDATE youtube_watch_subscriptions SET last_error")) return { rows: [] };
    throw new Error(`Unexpected query: ${sql}`);
  };
  const ctx = {
    config: { BOT_PROFILE: "debug", GUILD_ID: "guild-1", YOUTUBE_REQUEST_TIMEOUT_MS: 1000, ADHD_RSS_REQUEST_TIMEOUT_MS: 1000 },
    mainPgPool: { connect: async () => ({ query, release: () => { releases += 1; } }) },
    log: { warn: () => undefined },
    client: { channels: { fetch: async () => ({
      id: "channel-1", guildId: "guild-1", isTextBased: () => true,
      isDMBased: () => false, isSendable: () => true, isThread: () => false,
    }) } },
  };
  const makeEntry = (videoId: string) => ({ ...entry, videoId, videoUrl: `https://www.youtube.com/watch?v=${videoId}` });
  let entries = ["members", "premiere", "public", "check-error"].map(makeEntry);
  let feedFails = false;
  const playable = new Set(["public"]);
  let checkFails = true;
  let sendFails = false;
  const deps = {
    fetchFeed: async () => feedFails ? { ok: false as const, error: "RSS unavailable" } : { ok: true as const, entries },
    fetchFallback: async () => ({ ok: false as const, error: "fallback unavailable" }),
    isPlayable: async (videoId: string) => {
      if (videoId === "check-error" && checkFails) throw new Error("timeout");
      return playable.has(videoId);
    },
    sendNotification: async (_ctx: unknown, _target: unknown, video: YouTubeFeedEntry) => {
      assert.equal(posts.get(video.videoId)?.status, "pending");
      if (sendFails && video.videoId === "premiere") throw new Error("Discord unavailable");
      sent.push(video.videoId);
      return { message: { id: `message-${video.videoId}` } } as never;
    },
  };
  await scanYouTubeWatcher(ctx as never, deps);
  assert.deepEqual(sent, ["public"]);
  for (const id of ["members", "premiere", "check-error"]) assert.equal(posts.get(id)?.status, "deferred");
  entries = [];
  checkFails = false;
  playable.add("check-error");
  await scanYouTubeWatcher(ctx as never, deps);
  assert.deepEqual(sent, ["public", "check-error"]);
  feedFails = true;
  playable.add("members");
  playable.add("premiere");
  sendFails = true;
  await scanYouTubeWatcher(ctx as never, deps);
  assert.deepEqual(sent, ["public", "check-error", "members"]);
  assert.equal(posts.get("premiere")?.status, "failed");
  sendFails = false;
  await scanYouTubeWatcher(ctx as never, deps);
  assert.deepEqual(sent, ["public", "check-error", "members", "premiere"]);
  await scanYouTubeWatcher(ctx as never, deps);
  assert.equal(sent.length, 4);
  assert.equal(releases, 5);
}

const noPublicWatcher = startYouTubeWatcher({
  config: {
    BOT_PROFILE: "production",
    ADHD_WATCHER_ENABLED: true,
    ADHD_VIDEO_PUBLIC_BASE_URL: undefined,
  },
  mainPgPool: { connect: async () => { throw new Error("scan not needed for this startup test"); } },
  log: { warn: () => undefined },
} as never);
assert.notEqual(noPublicWatcher, null);
noPublicWatcher?.stop();
assert.equal(startYouTubeWatcher({ config: { BOT_PROFILE: "debug", ADHD_WATCHER_ENABLED: false } } as never), null);

assert.equal(shouldMarkYouTubeWatcherPostFailed(false, new Error("send failed")), true);
assert.equal(shouldMarkYouTubeWatcherPostFailed(true, new Error("reference save failed")), false);
assert.equal(
  shouldMarkYouTubeWatcherPostFailed(true, new YouTubeVideoCacheReferenceRecoveryError(true, new Error("recovery failed"))),
  true,
);
assert.equal(
  shouldMarkYouTubeWatcherPostFailed(true, new YouTubeVideoCacheReferenceRecoveryError(true, { code: 10008 })),
  true,
);
assert.equal(
  shouldMarkYouTubeWatcherPostFailed(true, new YouTubeVideoCacheReferenceRecoveryError(false, new Error("recovery failed"))),
  false,
);
const pendingReferenceWrites: Array<{ status: string; messageId?: string; error?: string }> = [];
await saveYouTubeWatcherReferenceRecoveryPending({
  savePost: async (_subscriptionId: string, _entry: unknown, input: { status: string; messageId?: string; error?: string }) => { pendingReferenceWrites.push(input); },
} as never, "subscription-pending", entry, { message: { id: "message-pending" } } as never);
assert.deepEqual(pendingReferenceWrites, [{
  status: "pending",
  messageId: "message-pending",
  error: "youtube_video_cache_reference_recovery_pending",
}]);

const recoveryCandidate = {
  subscriptionId: "subscription-recovery",
  guildId: "guild-recovery",
  discordChannelId: "channel-recovery",
  discordMessageId: "message-recovery",
  entry: { ...entry, videoId: "video-recovery" },
};
const recoveryLegacyWrites: Array<{ status: string; messageId?: string; error?: string; durableMediaUrl?: string | null }> = [];
let recoveryUpserts = 0;
let recoverySends = 0;
let recoveryEditPayload: unknown;
await recoverYouTubeWatcherVideoCacheReferenceCandidate({
  config: {
    ADHD_VIDEO_FILES_DIR: "C:\\adhd-videos",
    ADHD_VIDEO_PUBLIC_BASE_URL: undefined,
    YOUTUBE_REQUEST_TIMEOUT_MS: 1_000,
  },
  client: {
    user: { id: "bot-1" },
    channels: {
      fetch: async () => ({
        messages: {
          fetch: async () => ({
            author: { id: "bot-1" },
            components: [{ toJSON: () => ({
              type: ComponentType.Container,
              components: [{ type: ComponentType.MediaGallery, items: [{ media: { url: "https://media.example/old-vps.mp4" } }] }],
            }) }],
            edit: async (payload: unknown) => { recoveryEditPayload = payload; },
            send: async () => { recoverySends += 1; },
          }),
        },
      }),
    },
  },
  log: { warn: () => undefined },
} as never, {
  savePost: async (_subscriptionId: string, _entry: unknown, input: { status: string; messageId?: string; error?: string; durableMediaUrl?: string | null }) => { recoveryLegacyWrites.push(input); },
} as never, {
  withVideoCacheLock: async <T>(run: () => Promise<T>): Promise<T> => run(),
  upsertVideoCacheReference: async () => { recoveryUpserts += 1; },
  updateVideoCacheReferenceMedia: async () => undefined,
} as never, recoveryCandidate, {
  videoExists: async () => false,
  resolveMedia: async () => ({ status: "ok", mediaUrl: "https://rr.example.googlevideo.com/recovery.mp4" }),
});
assert.equal(recoveryUpserts, 1);
assert.equal(recoverySends, 0);
const recoveryEditJson = JSON.stringify(recoveryEditPayload);
assert.equal(recoveryEditJson.includes("media.example/old-vps.mp4"), false);
assert.equal(recoveryEditJson.includes("rr.example.googlevideo.com/recovery.mp4"), true);
assert.deepEqual(recoveryLegacyWrites, [{
  status: "sent",
  messageId: "message-recovery",
  durableMediaUrl: null,
}]);

let thumbnailRecoveryEdit: unknown;
const thumbnailRecoveryWrites: Array<{ status: string; messageId?: string; durableMediaUrl?: string | null }> = [];
let thumbnailRecoveryUpserts = 0;
await recoverYouTubeWatcherVideoCacheReferenceCandidate({
  config: {
    ADHD_VIDEO_FILES_DIR: "C:\\adhd-videos",
    ADHD_VIDEO_PUBLIC_BASE_URL: undefined,
    YOUTUBE_REQUEST_TIMEOUT_MS: 1_000,
  },
  client: {
    user: { id: "bot-1" },
    channels: { fetch: async () => ({ messages: { fetch: async () => ({
      author: { id: "bot-1" },
      components: [{ toJSON: () => ({
        type: ComponentType.Container,
        components: [{ type: ComponentType.MediaGallery, items: [{ media: { url: "https://media.example/old-vps.mp4" } }] }],
      }) }],
      edit: async (payload: unknown) => { thumbnailRecoveryEdit = payload; },
    }) } }) },
  },
  log: { warn: () => undefined },
} as never, {
  savePost: async (_subscriptionId: string, _entry: unknown, input: { status: string; messageId?: string; durableMediaUrl?: string | null }) => { thumbnailRecoveryWrites.push(input); },
} as never, {
  withVideoCacheLock: async <T>(run: () => Promise<T>): Promise<T> => run(),
  upsertVideoCacheReference: async () => { thumbnailRecoveryUpserts += 1; },
  updateVideoCacheReferenceMedia: async () => undefined,
} as never, recoveryCandidate, {
  videoExists: async () => false,
  resolveMedia: async () => ({ status: "fallback", reason: "unavailable" }),
});
const thumbnailRecoveryJson = JSON.stringify(thumbnailRecoveryEdit);
assert.equal(thumbnailRecoveryJson.includes(entry.thumbnailUrl), false);
assert.equal(thumbnailRecoveryJson.includes("https://i.ytimg.com/vi/video-recovery/hqdefault.jpg"), false);
assert.equal(thumbnailRecoveryJson.includes("https://media.example/old-vps.mp4"), false);
assert.equal(thumbnailRecoveryUpserts, 1);
assert.deepEqual(thumbnailRecoveryWrites, [{
  status: "sent",
  messageId: "message-recovery",
  durableMediaUrl: null,
}]);

const temporaryRecoveryWrites: Array<{ status: string; messageId?: string; error?: string }> = [];
await recoverYouTubeWatcherVideoCacheReferenceCandidate({
  config: {},
  client: { channels: { fetch: async () => { throw new Error("Discord temporary failure"); } } },
  log: { warn: () => undefined },
} as never, {
  savePost: async (_subscriptionId: string, _entry: unknown, input: { status: string; messageId?: string; error?: string }) => { temporaryRecoveryWrites.push(input); },
} as never, {} as never, recoveryCandidate);
assert.deepEqual(temporaryRecoveryWrites, [{
  status: "pending",
  messageId: "message-recovery",
  error: "youtube_video_cache_reference_recovery_pending",
}]);

const unknownRecoveryWrites: Array<{ status: string; messageId?: string; error?: string }> = [];
await recoverYouTubeWatcherVideoCacheReferenceCandidate({
  config: {},
  client: { channels: { fetch: async () => ({ messages: { fetch: async () => { throw { code: 10008 }; } } }) } },
  log: { warn: () => undefined },
} as never, {
  savePost: async (_subscriptionId: string, _entry: unknown, input: { status: string; messageId?: string; error?: string }) => { unknownRecoveryWrites.push(input); },
} as never, {} as never, recoveryCandidate);
assert.deepEqual(unknownRecoveryWrites, [{
  status: "failed",
  messageId: "message-recovery",
  error: "youtube_video_cache_reference_recovery_pending",
}]);

const compensationRecoveryWrites: Array<{ status: string; messageId?: string; error?: string }> = [];
await recoverYouTubeWatcherVideoCacheReferenceCandidate({
  config: { ADHD_VIDEO_FILES_DIR: "C:\\adhd-videos", YOUTUBE_REQUEST_TIMEOUT_MS: 1_000 },
  client: {
    user: { id: "bot-1" },
    channels: { fetch: async () => ({ messages: { fetch: async () => ({
      author: { id: "bot-1" },
      components: [{ toJSON: () => ({ type: ComponentType.Container, components: [] }) }],
      edit: async () => { throw new Error("Discord temporary failure"); },
    }) } }) },
  },
  log: { warn: () => undefined },
} as never, {
  savePost: async (_subscriptionId: string, _entry: unknown, input: { status: string; messageId?: string; error?: string }) => { compensationRecoveryWrites.push(input); },
} as never, {
  withVideoCacheLock: async <T>(run: () => Promise<T>): Promise<T> => run(),
  upsertVideoCacheReference: async () => { throw new Error("database unavailable"); },
  updateVideoCacheReferenceMedia: async () => undefined,
} as never, recoveryCandidate, {
  videoExists: async () => true,
  resolveMedia: async () => ({ status: "fallback", reason: "unavailable" }),
});
assert.deepEqual(compensationRecoveryWrites, [{
  status: "pending",
  messageId: "message-recovery",
  error: "youtube_video_cache_reference_recovery_pending",
}]);

const temporaryEditWrites: Array<{ status: string; messageId?: string; error?: string }> = [];
let temporaryEditUpserts = 0;
await recoverYouTubeWatcherVideoCacheReferenceCandidate({
  config: { ADHD_VIDEO_FILES_DIR: "C:\\adhd-videos", YOUTUBE_REQUEST_TIMEOUT_MS: 1_000 },
  client: {
    user: { id: "bot-1" },
    channels: { fetch: async () => ({ messages: { fetch: async () => ({
      author: { id: "bot-1" },
      components: [{ toJSON: () => ({ type: ComponentType.Container, components: [] }) }],
      edit: async () => { throw new Error("Discord temporary failure"); },
    }) } }) },
  },
  log: { warn: () => undefined },
} as never, {
  savePost: async (_subscriptionId: string, _entry: unknown, input: { status: string; messageId?: string; error?: string }) => { temporaryEditWrites.push(input); },
} as never, {
  withVideoCacheLock: async <T>(run: () => Promise<T>): Promise<T> => run(),
  upsertVideoCacheReference: async () => { temporaryEditUpserts += 1; },
  updateVideoCacheReferenceMedia: async () => undefined,
} as never, recoveryCandidate, {
  videoExists: async () => false,
  resolveMedia: async () => ({ status: "fallback", reason: "unavailable" }),
});
assert.equal(temporaryEditUpserts, 0);
assert.deepEqual(temporaryEditWrites, [{
  status: "pending",
  messageId: "message-recovery",
  error: "youtube_video_cache_reference_recovery_pending",
}]);

const unknownEditWrites: Array<{ status: string; messageId?: string; error?: string }> = [];
await recoverYouTubeWatcherVideoCacheReferenceCandidate({
  config: { ADHD_VIDEO_FILES_DIR: "C:\\adhd-videos", YOUTUBE_REQUEST_TIMEOUT_MS: 1_000 },
  client: {
    user: { id: "bot-1" },
    channels: { fetch: async () => ({ messages: { fetch: async () => ({
      author: { id: "bot-1" },
      components: [{ toJSON: () => ({ type: ComponentType.Container, components: [] }) }],
      edit: async () => { throw { code: 10008 }; },
    }) } }) },
  },
  log: { warn: () => undefined },
} as never, {
  savePost: async (_subscriptionId: string, _entry: unknown, input: { status: string; messageId?: string; error?: string }) => { unknownEditWrites.push(input); },
} as never, {} as never, recoveryCandidate, {
  videoExists: async () => false,
  resolveMedia: async () => ({ status: "fallback", reason: "unavailable" }),
});
assert.deepEqual(unknownEditWrites, [{
  status: "failed",
  messageId: "message-recovery",
  error: "youtube_video_cache_reference_recovery_pending",
}]);

let vpsRecoveryEdit: unknown;
const vpsRecoveryWrites: Array<{ status: string; messageId?: string; durableMediaUrl?: string | null }> = [];
await recoverYouTubeWatcherVideoCacheReferenceCandidate({
  config: {
    ADHD_VIDEO_FILES_DIR: "C:\\adhd-videos",
    ADHD_VIDEO_PUBLIC_BASE_URL: "https://media.example/adhd/",
    YOUTUBE_REQUEST_TIMEOUT_MS: 1_000,
  },
  client: {
    user: { id: "bot-1" },
    channels: { fetch: async () => ({ messages: { fetch: async () => ({
      author: { id: "bot-1" },
      components: [{ toJSON: () => ({
        type: ComponentType.Container,
        components: [{ type: ComponentType.MediaGallery, items: [{ media: { url: "https://rr.example.googlevideo.com/old.mp4" } }] }],
      }) }],
      edit: async (payload: unknown) => { vpsRecoveryEdit = payload; },
    }) } }) },
  },
  log: { warn: () => undefined },
} as never, {
  savePost: async (_subscriptionId: string, _entry: unknown, input: { status: string; messageId?: string; durableMediaUrl?: string | null }) => { vpsRecoveryWrites.push(input); },
} as never, {
  withVideoCacheLock: async <T>(run: () => Promise<T>): Promise<T> => run(),
  upsertVideoCacheReference: async () => undefined,
  updateVideoCacheReferenceMedia: async () => undefined,
} as never, recoveryCandidate, { videoExists: async () => true });
const vpsRecoveryJson = JSON.stringify(vpsRecoveryEdit);
assert.equal(vpsRecoveryJson.includes("rr.example.googlevideo.com/old.mp4"), false);
assert.equal(vpsRecoveryJson.includes("https://media.example/adhd/video-recovery.mp4"), true);
assert.deepEqual(vpsRecoveryWrites, [{
  status: "sent",
  messageId: "message-recovery",
  durableMediaUrl: "https://media.example/adhd/video-recovery.mp4",
}]);

let noneRecoveryEdit: unknown;
const noneRecoveryWrites: Array<{ status: string; messageId?: string; durableMediaUrl?: string | null }> = [];
await recoverYouTubeWatcherVideoCacheReferenceCandidate({
  config: { ADHD_VIDEO_FILES_DIR: "C:\\adhd-videos", YOUTUBE_REQUEST_TIMEOUT_MS: 1_000 },
  client: {
    user: { id: "bot-1" },
    channels: { fetch: async () => ({ messages: { fetch: async () => ({
      author: { id: "bot-1" },
      components: [{ toJSON: () => ({
        type: ComponentType.Container,
        components: [{ type: ComponentType.MediaGallery, items: [{ media: { url: "https://media.example/old-vps-none.mp4" } }] }],
      }) }],
      edit: async (payload: unknown) => { noneRecoveryEdit = payload; },
    }) } }) },
  },
  log: { warn: () => undefined },
} as never, {
  savePost: async (_subscriptionId: string, _entry: unknown, input: { status: string; messageId?: string; durableMediaUrl?: string | null }) => { noneRecoveryWrites.push(input); },
} as never, {
  withVideoCacheLock: async <T>(run: () => Promise<T>): Promise<T> => run(),
  upsertVideoCacheReference: async () => undefined,
  updateVideoCacheReferenceMedia: async () => undefined,
} as never, recoveryCandidate, {
  videoExists: async () => false,
  resolveMedia: async () => ({ status: "fallback", reason: "unavailable" }),
});
const noneRecoveryJson = JSON.stringify(noneRecoveryEdit);
assert.equal(noneRecoveryJson.includes("media.example/old-vps-none.mp4"), false);
assert.equal(noneRecoveryJson.includes("MediaGallery"), false);
assert.deepEqual(noneRecoveryWrites, [{ status: "sent", messageId: "message-recovery", durableMediaUrl: null }]);

console.log("youtubeWatcher.watcher.spec.ts: all assertions passed");

// RED: production の保存結果は送信に使える明示的な媒体状態へ変換され、
// キャッシュ全体ロック内で一度だけ保存する。
const cacheCallOrder: string[] = [];
let persistedOptions: Record<string, unknown> | undefined;
const cachedMedia = await cacheYouTubeWatcherVideo({
  config: {
    BOT_PROFILE: "production",
    ADHD_VIDEO_FILES_DIR: "C:\\adhd-videos",
    ADHD_VIDEO_PUBLIC_BASE_URL: "https://media.example/adhd/",
    ADHD_VIDEO_MIN_FREE_BYTES: 1_000,
    ADHD_VIDEO_CACHE_MAX_BYTES: 2_000,
    ADHD_VIDEO_RETENTION_DAYS: 7,
    YOUTUBE_REQUEST_TIMEOUT_MS: 3_000,
  },
  log: { warn: () => undefined },
} as never, entry, {
  withVideoCacheLock: async (run) => {
    cacheCallOrder.push("lock:start");
    const value = await run({} as never);
    cacheCallOrder.push("lock:end");
    return value;
  },
}, {
  persistVideo: async (_input, options) => {
    cacheCallOrder.push("persist");
    persistedOptions = options;
    return { status: "cached", mediaUrl: "https://media.example/adhd/video-1.mp4", evictedVideoIds: ["old-video"] };
  },
  resolveMedia: async () => ({ status: "fallback", reason: "unused" }),
  maintenance: {
    fallbackVideos: async (ids) => { cacheCallOrder.push(`fallback:${ids.join(",")}`); },
    restoreCachedVideo: async (videoId, mediaUrl) => { cacheCallOrder.push(`restore:${videoId}:${mediaUrl}`); },
  },
});
assert.deepEqual(cachedMedia, {
  mediaMode: "vps",
  mediaUrl: "https://media.example/adhd/video-1.mp4",
  lastError: null,
});
assert.deepEqual(cacheCallOrder, [
  "lock:start",
  "persist",
  "fallback:old-video",
  "restore:video-1:https://media.example/adhd/video-1.mp4",
  "lock:end",
]);
assert.equal(typeof persistedOptions?.mediaResolver, "function");
const { mediaResolver: _persistedMediaResolver, ...persistedBaseOptions } = persistedOptions ?? {};
assert.deepEqual(persistedBaseOptions, {
  directory: "C:\\adhd-videos",
  publicBaseUrl: "https://media.example/adhd/",
  timeoutMs: 3_000,
  minFreeBytes: 1_000,
  cacheMaxBytes: 2_000,
  retentionDays: 7,
});

const fallbackMedia = await cacheYouTubeWatcherVideo({
  config: {
    BOT_PROFILE: "production",
    ADHD_VIDEO_FILES_DIR: "C:\\adhd-videos",
    ADHD_VIDEO_PUBLIC_BASE_URL: undefined,
    ADHD_VIDEO_MIN_FREE_BYTES: 1_000,
    ADHD_VIDEO_CACHE_MAX_BYTES: 2_000,
    ADHD_VIDEO_RETENTION_DAYS: 7,
    YOUTUBE_REQUEST_TIMEOUT_MS: 3_000,
  },
  log: { warn: () => undefined },
} as never, entry, {
  withVideoCacheLock: async (run) => run({} as never),
}, {
  persistVideo: async () => { throw new Error("PUBLIC_BASE未設定では保存しない"); },
  resolveMedia: async () => ({ status: "ok", mediaUrl: "https://rr.example.googlevideo.com/video.mp4" }),
  maintenance: { fallbackVideos: async () => undefined, restoreCachedVideo: async () => undefined },
});
assert.deepEqual(fallbackMedia, {
  mediaMode: "google",
  mediaUrl: "https://rr.example.googlevideo.com/video.mp4",
  lastError: "invalid_public_base_url",
});

let fallbackEvictions: string[] = [];
const persistedFallbackMedia = await cacheYouTubeWatcherVideo({
  config: {
    BOT_PROFILE: "production",
    ADHD_VIDEO_FILES_DIR: "C:\\adhd-videos",
    ADHD_VIDEO_PUBLIC_BASE_URL: "https://media.example/adhd/",
    ADHD_VIDEO_MIN_FREE_BYTES: 1_000,
    ADHD_VIDEO_CACHE_MAX_BYTES: 2_000,
    ADHD_VIDEO_RETENTION_DAYS: 7,
    YOUTUBE_REQUEST_TIMEOUT_MS: 3_000,
  },
  log: { warn: () => undefined },
} as never, entry, { withVideoCacheLock: async (run) => run({} as never) }, {
  persistVideo: async () => ({
    status: "fallback",
    reason: "insufficient_disk_space",
    googleVideoUrl: "https://rr.example.googlevideo.com/video.mp4",
    evictedVideoIds: ["expired-video"],
  }),
  resolveMedia: async () => ({ status: "fallback", reason: "unused" }),
  maintenance: {
    fallbackVideos: async (ids) => { fallbackEvictions = [...ids]; },
    restoreCachedVideo: async () => { throw new Error("fallbackはrestoreしない"); },
  },
});
assert.deepEqual(persistedFallbackMedia, {
  mediaMode: "google",
  mediaUrl: "https://rr.example.googlevideo.com/video.mp4",
  lastError: "insufficient_disk_space",
});
assert.deepEqual(fallbackEvictions, ["expired-video"]);

let debugPersistCalls = 0;
const debugMedia = await cacheYouTubeWatcherVideo({
  config: { BOT_PROFILE: "debug" },
  log: { warn: () => undefined },
} as never, entry, { withVideoCacheLock: async (run) => run({} as never) }, {
  persistVideo: async () => {
    debugPersistCalls += 1;
    return { status: "cached", mediaUrl: "https://media.example/unexpected.mp4", evictedVideoIds: [] };
  },
  maintenance: { fallbackVideos: async () => undefined, restoreCachedVideo: async () => undefined },
});
assert.deepEqual(debugMedia, { mediaMode: "none", lastError: null });
assert.equal(debugPersistCalls, 0);

const referenceFallbackComponents = [{
  type: ComponentType.Container,
  components: [{
    type: ComponentType.Section,
    components: [{ type: ComponentType.TextDisplay, content: "本文" }],
    accessory: { type: ComponentType.Thumbnail, media: { url: entry.thumbnailUrl } },
  }, {
    type: ComponentType.MediaGallery,
    items: [{ media: { url: "https://media.example/adhd/video-1.mp4" } }],
  }, {
    type: ComponentType.ActionRow,
    components: [{ type: ComponentType.Button, style: 5, label: "YouTubeで開く", url: entry.videoUrl }],
  }],
}];
let referenceFallbackEdit: unknown;
let referenceFallbackUpserts = 0;
const referenceFallbackMedia = await saveYouTubeWatcherVideoCacheReference({
  config: { YOUTUBE_REQUEST_TIMEOUT_MS: 1_000 },
  log: { warn: () => undefined },
} as never, {
  withVideoCacheLock: async <T>(run: () => Promise<T>): Promise<T> => run(),
  upsertVideoCacheReference: async () => { referenceFallbackUpserts += 1; if (referenceFallbackUpserts === 1) throw new Error("database unavailable"); },
  updateVideoCacheReferenceMedia: async () => undefined,
} as never, { guildId: "guild-1", id: "channel-1" } as never, entry, {
  message: {
    id: "message-1",
    components: referenceFallbackComponents.map((component) => ({ toJSON: () => component })),
    edit: async (payload: unknown) => { referenceFallbackEdit = payload; },
  } as never,
  media: { mediaMode: "vps", mediaUrl: "https://media.example/adhd/video-1.mp4", lastError: null },
}, {
  resolveMedia: async () => ({ status: "ok", mediaUrl: "https://rr.example.googlevideo.com/video.mp4" }),
});
const referenceFallbackJson = JSON.stringify(referenceFallbackEdit);
assert.equal(referenceFallbackJson.includes("rr.example.googlevideo.com/video.mp4"), true);
assert.equal(referenceFallbackJson.includes("media.example/adhd/video-1.mp4"), false);
assert.equal(referenceFallbackJson.includes("i.ytimg.com"), true);
assert.equal(referenceFallbackJson.includes('"type":11'), true);
assert.equal(referenceFallbackUpserts, 2);
assert.deepEqual(referenceFallbackMedia, {
  mediaMode: "google",
  mediaUrl: "https://rr.example.googlevideo.com/video.mp4",
  lastError: "reference_save_error",
});
