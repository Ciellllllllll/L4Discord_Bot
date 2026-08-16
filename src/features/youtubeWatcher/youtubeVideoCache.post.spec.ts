import assert from "node:assert/strict";
import { ComponentType } from "discord.js";
import { cacheYouTubeVideoForPost, saveYouTubeVideoCacheReferenceForPost, YouTubeVideoCacheReferenceRecoveryError } from "./youtubeVideoCache.service.js";

const input = {
  videoId: "video-1",
  videoUrl: "https://www.youtube.com/watch?v=video-1",
};

const callOrder: string[] = [];
const cached = await cacheYouTubeVideoForPost({
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
} as never, input, {
  repo: {
    withVideoCacheLock: async (run) => {
      callOrder.push("lock:start");
      const value = await run({} as never);
      callOrder.push("lock:end");
      return value;
    },
  },
  persistVideo: async (_input, options) => {
    callOrder.push(`persist:${options.cacheMaxBytes}:${options.retentionDays}`);
    return {
      status: "cached",
      mediaUrl: "https://media.example/adhd/video-1.mp4",
      evictedVideoIds: ["expired-video"],
    };
  },
  resolveMedia: async () => ({ status: "fallback", reason: "unused" }),
  maintenance: {
    fallbackVideos: async (ids) => { callOrder.push(`fallback:${ids.join(",")}`); },
    restoreCachedVideo: async (videoId, mediaUrl) => { callOrder.push(`restore:${videoId}:${mediaUrl}`); },
  },
});
assert.deepEqual(cached, {
  mediaMode: "vps",
  mediaUrl: "https://media.example/adhd/video-1.mp4",
  lastError: null,
});
assert.deepEqual(callOrder, [
  "lock:start",
  "persist:2000:7",
  "fallback:expired-video",
  "restore:video-1:https://media.example/adhd/video-1.mp4",
  "lock:end",
]);

const referenceOrder: string[] = [];
const missingVpsMedia = await saveYouTubeVideoCacheReferenceForPost({
  config: {
    ADHD_VIDEO_FILES_DIR: "C:\\adhd-videos",
    ADHD_VIDEO_PUBLIC_BASE_URL: "https://media.example/adhd/",
    YOUTUBE_REQUEST_TIMEOUT_MS: 3_000,
  },
  log: { warn: () => undefined },
} as never, {
  withVideoCacheLock: async <T>(run: () => Promise<T>): Promise<T> => {
    referenceOrder.push("lock:start");
    const result = await run();
    referenceOrder.push("lock:end");
    return result;
  },
  upsertVideoCacheReference: async (reference: { mediaMode: string }) => { referenceOrder.push(`upsert:${reference.mediaMode}`); },
  updateVideoCacheReferenceMedia: async (_id: string, mode: "vps" | "google" | "none") => { referenceOrder.push(`update:${mode}`); },
} as never, { guildId: "guild-1", channelId: "channel-1" }, input, {
  message: {
    id: "message-1",
    components: [{ toJSON: () => ({ type: ComponentType.Container, components: [] }) }],
    edit: async () => { referenceOrder.push("edit:fallback"); },
  },
  media: { mediaMode: "vps", mediaUrl: "https://media.example/video-1.mp4", lastError: null },
}, {
  videoExists: async () => { referenceOrder.push("exists:false"); return false; },
  resolveMedia: async () => { referenceOrder.push("resolve"); return { status: "ok", mediaUrl: "https://rr.example.googlevideo.com/video.mp4" }; },
});
assert.deepEqual(missingVpsMedia, {
  mediaMode: "google",
  mediaUrl: "https://rr.example.googlevideo.com/video.mp4",
  lastError: "vps_file_missing",
});
assert.deepEqual(referenceOrder, [
  "lock:start", "exists:false", "resolve", "edit:fallback", "upsert:google", "lock:end",
]);

let outerReferenceUpserts = 0;
let lockedReferenceUpserts = 0;
await saveYouTubeVideoCacheReferenceForPost({
  config: { ADHD_VIDEO_FILES_DIR: "C:\\adhd-videos", YOUTUBE_REQUEST_TIMEOUT_MS: 3_000 }, log: { warn: () => undefined },
} as never, {
  withVideoCacheLock: async <T>(run: (lockedRepo: unknown) => Promise<T>): Promise<T> => run({
    upsertVideoCacheReference: async () => { lockedReferenceUpserts += 1; },
  }),
  upsertVideoCacheReference: async () => { outerReferenceUpserts += 1; },
  updateVideoCacheReferenceMedia: async () => undefined,
} as never, { guildId: "guild-1", channelId: "channel-1" }, input, {
  message: {
    id: "message-locked-reference",
    components: [{ toJSON: () => ({ type: ComponentType.Container, components: [] }) }],
    edit: async () => undefined,
  },
  media: { mediaMode: "none", lastError: "cache_persist_error" },
}, { videoExists: async () => false });
assert.equal(outerReferenceUpserts, 0);
assert.equal(lockedReferenceUpserts, 1);

for (const media of [
  { mediaMode: "google" as const, mediaUrl: "https://rr.example.googlevideo.com/original.mp4", lastError: "cache_persist_error" },
  { mediaMode: "none" as const, lastError: "cache_persist_error" },
]) {
  const promotionOrder: string[] = [];
  const promoted = await saveYouTubeVideoCacheReferenceForPost({
    config: {
      ADHD_VIDEO_FILES_DIR: "C:\\adhd-videos",
      ADHD_VIDEO_PUBLIC_BASE_URL: "https://media.example/adhd/",
      YOUTUBE_REQUEST_TIMEOUT_MS: 3_000,
    },
    log: { warn: () => undefined },
  } as never, {
    withVideoCacheLock: async <T>(run: () => Promise<T>): Promise<T> => {
      promotionOrder.push("lock:start");
      const value = await run();
      promotionOrder.push("lock:end");
      return value;
    },
    upsertVideoCacheReference: async (reference: { mediaMode: string; mediaUrl?: string }) => {
      promotionOrder.push(`upsert:${reference.mediaMode}:${reference.mediaUrl ?? ""}`);
    },
    updateVideoCacheReferenceMedia: async () => undefined,
  } as never, { guildId: "guild-1", channelId: "channel-1" }, input, {
    message: {
      id: `message-promote-${media.mediaMode}`,
      components: [{ toJSON: () => ({ type: ComponentType.Container, components: [] }) }],
      edit: async () => { promotionOrder.push("edit:vps"); },
    },
    media,
  }, {
    videoExists: async () => { promotionOrder.push("exists:true"); return true; },
  });
  assert.deepEqual(promoted, {
    mediaMode: "vps",
    mediaUrl: "https://media.example/adhd/video-1.mp4",
    lastError: null,
  });
  assert.deepEqual(promotionOrder, [
    "lock:start",
    "exists:true",
    "edit:vps",
    "upsert:vps:",
    "lock:end",
  ]);
}

let deletedPromotionUpserts = 0;
await assert.rejects(
  () => saveYouTubeVideoCacheReferenceForPost({
    config: {
      ADHD_VIDEO_FILES_DIR: "C:\\adhd-videos",
      ADHD_VIDEO_PUBLIC_BASE_URL: "https://media.example/adhd/",
      YOUTUBE_REQUEST_TIMEOUT_MS: 3_000,
    },
    log: { warn: () => undefined },
  } as never, {
    withVideoCacheLock: async <T>(run: () => Promise<T>): Promise<T> => run(),
    upsertVideoCacheReference: async () => { deletedPromotionUpserts += 1; },
    updateVideoCacheReferenceMedia: async () => undefined,
  } as never, { guildId: "guild-1", channelId: "channel-1" }, input, {
    message: {
      id: "message-deleted-promotion",
      components: [{ toJSON: () => ({ type: ComponentType.Container, components: [] }) }],
      edit: async () => { throw { code: 10008 }; },
    },
    media: { mediaMode: "google", mediaUrl: "https://rr.example.googlevideo.com/original.mp4", lastError: null },
  }, { videoExists: async () => true }),
  (error: unknown) => error instanceof YouTubeVideoCacheReferenceRecoveryError && error.messageDeleted,
);
assert.equal(deletedPromotionUpserts, 0);

let deletedFallbackUpserts = 0;
await assert.rejects(
  () => saveYouTubeVideoCacheReferenceForPost({
    config: { ADHD_VIDEO_FILES_DIR: "C:\\adhd-videos", YOUTUBE_REQUEST_TIMEOUT_MS: 3_000 }, log: { warn: () => undefined },
  } as never, {
    withVideoCacheLock: async <T>(run: () => Promise<T>): Promise<T> => run(),
    upsertVideoCacheReference: async () => { deletedFallbackUpserts += 1; },
    updateVideoCacheReferenceMedia: async () => undefined,
  } as never, { guildId: "guild-1", channelId: "channel-1" }, input, {
    message: {
      id: "message-deleted-fallback",
      components: [{ toJSON: () => ({ type: ComponentType.Container, components: [] }) }],
      edit: async () => { throw { code: 10003 }; },
    },
    media: { mediaMode: "vps", mediaUrl: "https://media.example/video-1.mp4", lastError: null },
  }, {
    videoExists: async () => false,
    resolveMedia: async () => ({ status: "ok", mediaUrl: "https://rr.example.googlevideo.com/fallback.mp4" }),
  }),
  (error: unknown) => error instanceof YouTubeVideoCacheReferenceRecoveryError && error.messageDeleted,
);
assert.equal(deletedFallbackUpserts, 0);

const missingEditFailure = await saveYouTubeVideoCacheReferenceForPost({
  config: { ADHD_VIDEO_FILES_DIR: "C:\\adhd-videos", YOUTUBE_REQUEST_TIMEOUT_MS: 3_000 }, log: { warn: () => undefined },
} as never, {
  withVideoCacheLock: async <T>(run: () => Promise<T>): Promise<T> => run(),
  upsertVideoCacheReference: async () => undefined,
  updateVideoCacheReferenceMedia: async () => { throw new Error("must keep existing vps ref"); },
} as never, { guildId: "guild-1", channelId: "channel-1" }, input, {
  message: {
    id: "message-missing-edit", components: [{ toJSON: () => ({ type: ComponentType.Container, components: [] }) }],
    edit: async () => { throw new Error("discord unavailable"); },
  },
  media: { mediaMode: "vps", mediaUrl: "https://media.example/video-1.mp4", lastError: null },
}, { videoExists: async () => false, resolveMedia: async () => ({ status: "fallback", reason: "unused" }) });
assert.deepEqual(missingEditFailure, { mediaMode: "vps", mediaUrl: "https://media.example/video-1.mp4", lastError: null });

let existingGoogleResolverCalls = 0;
let existingGoogleUpserts = 0;
const existingGoogle = await saveYouTubeVideoCacheReferenceForPost({
  config: { ADHD_VIDEO_FILES_DIR: "C:\\adhd-videos", YOUTUBE_REQUEST_TIMEOUT_MS: 3_000 },
  log: { warn: () => undefined },
} as never, {
  withVideoCacheLock: async <T>(run: () => Promise<T>): Promise<T> => run(),
  upsertVideoCacheReference: async () => { existingGoogleUpserts += 1; if (existingGoogleUpserts === 1) throw new Error("database unavailable"); },
  updateVideoCacheReferenceMedia: async () => undefined,
} as never, { guildId: "guild-1", channelId: "channel-1" }, input, {
  message: {
    id: "message-google", components: [{ toJSON: () => ({ type: ComponentType.Container, components: [] }) }], edit: async () => undefined,
  },
  media: { mediaMode: "google", mediaUrl: "https://rr.example.googlevideo.com/existing.mp4", lastError: "cache_persist_error" },
}, {
  resolveMedia: async () => { existingGoogleResolverCalls += 1; return { status: "fallback", reason: "unexpected" }; },
});
assert.equal(existingGoogleResolverCalls, 0);
assert.equal(existingGoogleUpserts, 2);
assert.equal(existingGoogle.mediaUrl, "https://rr.example.googlevideo.com/existing.mp4");

let googleUpserts = 0;
await saveYouTubeVideoCacheReferenceForPost({
  config: { ADHD_VIDEO_FILES_DIR: "C:\\adhd-videos", YOUTUBE_REQUEST_TIMEOUT_MS: 3_000 }, log: { warn: () => undefined },
} as never, {
  withVideoCacheLock: async <T>(run: () => Promise<T>): Promise<T> => run(),
  upsertVideoCacheReference: async () => { googleUpserts += 1; if (googleUpserts === 1) throw new Error("first failure"); },
  updateVideoCacheReferenceMedia: async () => undefined,
} as never, { guildId: "guild-1", channelId: "channel-1" }, input, {
  message: { id: "message-google-retry", components: [{ toJSON: () => ({ type: ComponentType.Container, components: [] }) }], edit: async () => undefined },
  media: { mediaMode: "google", mediaUrl: "https://rr.example.googlevideo.com/existing.mp4", lastError: null },
}, { resolveMedia: async () => { throw new Error("existing google must not resolve"); } });
assert.equal(googleUpserts, 2);

await assert.rejects(
  () => saveYouTubeVideoCacheReferenceForPost({
    config: { ADHD_VIDEO_FILES_DIR: "C:\\adhd-videos", YOUTUBE_REQUEST_TIMEOUT_MS: 3_000 }, log: { warn: () => undefined },
  } as never, {
    withVideoCacheLock: async <T>(run: () => Promise<T>): Promise<T> => run(),
    upsertVideoCacheReference: async () => { throw new Error("database unavailable"); },
    updateVideoCacheReferenceMedia: async () => undefined,
  } as never, { guildId: "guild-1", channelId: "channel-1" }, input, {
    message: {
      id: "message-delete", components: [{ toJSON: () => ({ type: ComponentType.Container, components: [] }) }],
      edit: async () => { throw new Error("discord unavailable"); }, delete: async () => undefined,
    },
    media: { mediaMode: "vps", mediaUrl: "https://media.example/video-1.mp4", lastError: null },
  }, { resolveMedia: async () => ({ status: "fallback", reason: "unavailable" }) }),
  (error: unknown) => error instanceof YouTubeVideoCacheReferenceRecoveryError && error.messageDeleted,
);

await assert.rejects(
  () => saveYouTubeVideoCacheReferenceForPost({
    config: { ADHD_VIDEO_FILES_DIR: "C:\\adhd-videos", YOUTUBE_REQUEST_TIMEOUT_MS: 3_000 }, log: { warn: () => undefined },
  } as never, {
    withVideoCacheLock: async <T>(run: () => Promise<T>): Promise<T> => run(),
    upsertVideoCacheReference: async () => { throw new Error("database unavailable"); }, updateVideoCacheReferenceMedia: async () => undefined,
  } as never, { guildId: "guild-1", channelId: "channel-1" }, input, {
    message: { id: "message-10008", components: [{ toJSON: () => ({ type: ComponentType.Container, components: [] }) }], edit: async () => { throw new Error("discord unavailable"); }, delete: async () => { throw { code: 10008 }; } },
    media: { mediaMode: "none", lastError: "cache_failed" },
  }, { resolveMedia: async () => ({ status: "fallback", reason: "unused" }) }),
  (error: unknown) => error instanceof YouTubeVideoCacheReferenceRecoveryError && error.messageDeleted,
);

const googleFallback = await cacheYouTubeVideoForPost({
  config: {
    BOT_PROFILE: "production",
    ADHD_VIDEO_PUBLIC_BASE_URL: undefined,
    YOUTUBE_REQUEST_TIMEOUT_MS: 3_000,
  },
  log: { warn: () => undefined },
} as never, input, {
  repo: { withVideoCacheLock: async (run) => run({} as never) },
  persistVideo: async () => { throw new Error("public base 未設定では保存しない"); },
  resolveMedia: async () => ({ status: "ok", mediaUrl: "https://rr.example.googlevideo.com/video.mp4" }),
  maintenance: { fallbackVideos: async () => undefined, restoreCachedVideo: async () => undefined },
});
assert.deepEqual(googleFallback, {
  mediaMode: "google",
  mediaUrl: "https://rr.example.googlevideo.com/video.mp4",
  lastError: "invalid_public_base_url",
});

const insecureGoogleFallback = await cacheYouTubeVideoForPost({
  config: { BOT_PROFILE: "production", ADHD_VIDEO_PUBLIC_BASE_URL: undefined, YOUTUBE_REQUEST_TIMEOUT_MS: 3_000 }, log: { warn: () => undefined },
} as never, input, {
  repo: { withVideoCacheLock: async (run) => run({} as never) },
  maintenance: { fallbackVideos: async () => undefined, restoreCachedVideo: async () => undefined },
  resolveMedia: async () => ({ status: "ok", mediaUrl: "http://rr.example.googlevideo.com/video.mp4" }),
});
assert.equal(insecureGoogleFallback.mediaMode, "none");

let debugPersistCalls = 0;
const debug = await cacheYouTubeVideoForPost({
  config: { BOT_PROFILE: "debug" },
  log: { warn: () => undefined },
} as never, input, {
  repo: { withVideoCacheLock: async (run) => run({} as never) },
  persistVideo: async () => {
    debugPersistCalls += 1;
    return { status: "cached", mediaUrl: "https://media.example/unexpected.mp4", evictedVideoIds: [] };
  },
  maintenance: { fallbackVideos: async () => undefined, restoreCachedVideo: async () => undefined },
});
assert.deepEqual(debug, { mediaMode: "none", lastError: null });
assert.equal(debugPersistCalls, 0);

console.log("youtubeVideoCache.post.spec.ts: all assertions passed");
