import assert from "node:assert/strict";
import { ComponentType } from "discord.js";
import {
  cacheYouTubeWatcherVideo,
  recoverYouTubeWatcherVideoCacheReferenceCandidate,
  repairOneYouTubeWatcherMessage,
  saveYouTubeWatcherVideoCacheReference,
  saveYouTubeWatcherReferenceRecoveryPending,
  shouldMarkYouTubeWatcherPostFailed,
  startYouTubeWatcher,
} from "./youtubeWatcher.watcher.js";
import { YouTubeVideoCacheReferenceRecoveryError } from "./youtubeVideoCache.service.js";

const entry = {
  videoId: "video-1",
  title: "T".repeat(300),
  channelTitle: "テストチャンネル",
  publishedAt: "2026-08-06T12:34:56Z",
  videoUrl: "https://www.youtube.com/watch?v=video-1",
  thumbnailUrl: "https://i.ytimg.com/vi/video-1/maxresdefault.jpg",
};

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

const productionRepairContext = {
  client: {
    user: { id: "bot-1" },
    channels: { fetch: async () => { throw new Error("旧repairはチャンネル取得しない"); } },
  },
  config: {
    BOT_PROFILE: "production",
    YOUTUBE_REQUEST_TIMEOUT_MS: 1_000,
    ADHD_VIDEO_FILES_DIR: "C:\\adhd-videos",
    ADHD_VIDEO_PUBLIC_BASE_URL: "https://media.example/adhd/",
    ADHD_VIDEO_MIN_FREE_BYTES: 1_000,
  },
  log: { warn: () => undefined },
};
let oldRepairPersistCalls = 0;
await repairOneYouTubeWatcherMessage(productionRepairContext as never, {} as never, {
  persistVideo: async () => {
    oldRepairPersistCalls += 1;
    return { status: "cached", mediaUrl: "https://media.example/unused.mp4", evictedVideoIds: [] };
  },
});
assert.equal(oldRepairPersistCalls, 0);

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
assert.equal(referenceFallbackJson.includes("i.ytimg.com"), false);
assert.equal(referenceFallbackJson.includes('"type":11'), false);
assert.equal(referenceFallbackUpserts, 2);
assert.deepEqual(referenceFallbackMedia, {
  mediaMode: "google",
  mediaUrl: "https://rr.example.googlevideo.com/video.mp4",
  lastError: "reference_save_error",
});
