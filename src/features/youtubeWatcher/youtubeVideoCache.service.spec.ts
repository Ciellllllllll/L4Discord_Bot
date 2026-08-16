import assert from "node:assert/strict";
import { ComponentType } from "discord.js";
import {
  createYouTubeVideoCacheMaintenanceService,
  type YouTubeVideoCacheReference,
} from "./youtubeVideoCache.service.js";

const ref = (messageId: string, mediaMode: "vps" | "google" | "none" = "vps"): YouTubeVideoCacheReference => ({
  messageId,
  videoId: "video-1",
  guildId: "guild-1",
  channelId: "channel-1",
  youtubeUrl: "https://www.youtube.com/watch?v=video-1",
  mediaMode,
  lastError: null,
});

function message(edit: (payload: unknown) => Promise<void>) {
  return {
    author: { id: "bot-1" },
    components: [{
      toJSON: () => ({
        type: ComponentType.Container,
        components: [{
          type: ComponentType.Section,
          components: [{ type: ComponentType.TextDisplay, content: "本文" }],
          accessory: { type: ComponentType.Thumbnail, media: { url: "https://yt3.ggpht.com/icon.jpg" } },
        }, {
          type: ComponentType.MediaGallery,
          items: [{ media: { url: "https://expired.example/video.mp4" } }],
        }],
      }),
    }],
    edit,
  };
}

async function run(): Promise<void> {
  const updates: Array<[string, string, string | null]> = [];
  const deleted: string[] = [];
  const edits: unknown[] = [];
  let resolverCalls = 0;
  const references = [ref("message-1"), ref("message-2")];
  const service = createYouTubeVideoCacheMaintenanceService({
    repo: {
      listVpsVideoCacheReferences: async (videoId?: string) => videoId ? references.filter((item) => item.videoId === videoId) : references,
      listVideoCacheReferences: async (_videoId, mode) => references.filter((item) => !mode || item.mediaMode === mode),
      updateVideoCacheReferenceMedia: async (messageId, mode, error) => { updates.push([messageId, mode, error]); },
      deleteVideoCacheReference: async (messageId) => { deleted.push(messageId); },
    },
    client: {
      user: { id: "bot-1" },
      channels: { fetch: async () => ({ messages: { fetch: async () => message(async (payload) => { edits.push(payload); }) } }) },
    },
    resolveMedia: async () => {
      resolverCalls += 1;
      return { status: "ok", mediaUrl: "https://rr1---sn.googlevideo.com/videoplayback?expire=1" };
    },
    cleanup: async () => ({ evictedVideoIds: [] }),
    videoExists: async () => true,
  });
  await service.fallbackVideos(["video-1"]);
  assert.equal(resolverCalls, 1);
  assert.equal(edits.length, 2);
  assert.equal(edits.every((payload) => JSON.stringify(payload).includes('"type":11') === false), true);
  assert.deepEqual(updates.map(([id, mode]) => [id, mode]), [["message-1", "google"], ["message-2", "google"]]);

  const deletedService = createYouTubeVideoCacheMaintenanceService({
    repo: {
      listVpsVideoCacheReferences: async () => [ref("missing-message")],
      listVideoCacheReferences: async () => [],
      updateVideoCacheReferenceMedia: async () => undefined,
      deleteVideoCacheReference: async (messageId) => { deleted.push(messageId); },
    },
    client: { user: { id: "bot-1" }, channels: { fetch: async () => ({ messages: { fetch: async () => { throw { code: 10008 }; } } }) } },
    resolveMedia: async () => ({ status: "fallback", reason: "unavailable" }),
    cleanup: async () => ({ evictedVideoIds: [] }),
    videoExists: async () => true,
  });
  await deletedService.fallbackVideos(["video-1"]);
  assert.deepEqual(deleted, ["missing-message"]);

  const retryUpdates: Array<[string, string, string | null]> = [];
  const retryService = createYouTubeVideoCacheMaintenanceService({
    repo: {
      listVpsVideoCacheReferences: async () => [ref("retry-message")], listVideoCacheReferences: async () => [],
      updateVideoCacheReferenceMedia: async (id, mode, error) => { retryUpdates.push([id, mode, error]); }, deleteVideoCacheReference: async () => undefined,
    },
    client: { user: { id: "bot-1" }, channels: { fetch: async () => ({ messages: { fetch: async () => message(async () => { throw new Error("missing permission"); }) } }) } },
    resolveMedia: async () => ({ status: "ok", mediaUrl: "https://rr1---sn.googlevideo.com/videoplayback?expire=1" }), cleanup: async () => ({ evictedVideoIds: [] }), videoExists: async () => true,
  });
  await retryService.fallbackVideos(["video-1"]);
  assert.equal(retryUpdates[0]?.[1], "vps");
  assert.match(retryUpdates[0]?.[2] ?? "", /missing permission/);

  let retryMode: "vps" | "google" | "none" = "vps";
  let retryEdits = 0;
  let retryResolverCalls = 0;
  const maintenanceRetryService = createYouTubeVideoCacheMaintenanceService({
    repo: {
      listVpsVideoCacheReferences: async () => retryMode === "vps" ? [ref("maintenance-retry", retryMode)] : [],
      listVideoCacheReferences: async () => [],
      updateVideoCacheReferenceMedia: async (_id, mode) => { retryMode = mode; },
      deleteVideoCacheReference: async () => undefined,
    },
    client: { user: { id: "bot-1" }, channels: { fetch: async () => ({ messages: { fetch: async () => message(async () => {
      retryEdits += 1;
      if (retryEdits === 1) throw new Error("temporary Discord outage");
    }) } }) } },
    resolveMedia: async () => {
      retryResolverCalls += 1;
      return { status: "ok", mediaUrl: "https://rr1---sn.googlevideo.com/videoplayback?expire=1" };
    },
    cleanup: async () => ({ evictedVideoIds: retryResolverCalls === 0 ? ["video-1"] : [] }),
    videoExists: async () => false,
  });
  await maintenanceRetryService.runMaintenance();
  assert.equal(retryMode, "vps");
  await maintenanceRetryService.runMaintenance();
  assert.equal(retryMode, "google");
  assert.equal(retryEdits, 2);

  let dedupeResolverCalls = 0;
  const dedupeService = createYouTubeVideoCacheMaintenanceService({
    repo: {
      listVpsVideoCacheReferences: async () => [ref("dedupe")], listVideoCacheReferences: async () => [],
      updateVideoCacheReferenceMedia: async () => undefined, deleteVideoCacheReference: async () => undefined,
    },
    client: { user: { id: "bot-1" }, channels: { fetch: async () => ({ messages: { fetch: async () => message(async () => undefined) } }) } },
    resolveMedia: async () => { dedupeResolverCalls += 1; return { status: "fallback", reason: "unavailable" }; },
    cleanup: async () => ({ evictedVideoIds: ["video-1"] }), videoExists: async () => false,
  });
  await dedupeService.runMaintenance();
  assert.equal(dedupeResolverCalls, 1);

  const lockScope: string[] = [];
  const lockedMaintenanceService = createYouTubeVideoCacheMaintenanceService({
    repo: {
      listVpsVideoCacheReferences: async () => [ref("locked")], listVideoCacheReferences: async () => [],
      updateVideoCacheReferenceMedia: async () => undefined, deleteVideoCacheReference: async () => undefined,
    },
    client: { user: { id: "bot-1" }, channels: { fetch: async () => ({ messages: { fetch: async () => message(async () => undefined) } }) } },
    cleanup: async () => { lockScope.push("cleanup"); return { evictedVideoIds: ["video-1"] }; },
    resolveMedia: async () => { lockScope.push("fallback"); return { status: "fallback", reason: "unavailable" }; },
    videoExists: async () => true,
    withLock: async (run) => {
      lockScope.push("lock:start");
      const result = await run({
        listVpsVideoCacheReferences: async () => [ref("locked")],
        listVideoCacheReferences: async () => [],
        updateVideoCacheReferenceMedia: async () => undefined,
        deleteVideoCacheReference: async () => undefined,
      });
      lockScope.push("lock:end");
      return result;
    },
  });
  await lockedMaintenanceService.runMaintenance();
  assert.deepEqual(lockScope, ["lock:start", "cleanup", "fallback", "lock:end"]);

  const outerMaintenanceCalls: string[] = [];
  const lockedMaintenanceCalls: string[] = [];
  const lockedMaintenanceRepo = {
    listVpsVideoCacheReferences: async () => { lockedMaintenanceCalls.push("list:vps"); return [ref("locked-maintenance")]; },
    listVideoCacheReferences: async () => { lockedMaintenanceCalls.push("list:all"); return []; },
    updateVideoCacheReferenceMedia: async () => { lockedMaintenanceCalls.push("update"); },
    deleteVideoCacheReference: async () => { lockedMaintenanceCalls.push("delete"); },
  };
  const boundMaintenanceService = createYouTubeVideoCacheMaintenanceService({
    repo: {
      listVpsVideoCacheReferences: async () => { outerMaintenanceCalls.push("list:vps"); return []; },
      listVideoCacheReferences: async () => { outerMaintenanceCalls.push("list:all"); return []; },
      updateVideoCacheReferenceMedia: async () => { outerMaintenanceCalls.push("update"); },
      deleteVideoCacheReference: async () => { outerMaintenanceCalls.push("delete"); },
    },
    client: { user: { id: "bot-1" }, channels: { fetch: async () => ({ messages: { fetch: async () => message(async () => undefined) } }) } },
    cleanup: async () => ({ evictedVideoIds: ["video-1"] }),
    resolveMedia: async () => ({ status: "fallback", reason: "unavailable" }),
    videoExists: async () => true,
    withLock: async (run) => run(lockedMaintenanceRepo),
  });
  await boundMaintenanceService.runMaintenance();
  assert.deepEqual(outerMaintenanceCalls, []);
  assert.deepEqual(lockedMaintenanceCalls, ["list:vps", "list:vps", "update"]);

  const fallbackDbFailureUpdates: string[] = [];
  const fallbackDbFailureService = createYouTubeVideoCacheMaintenanceService({
    repo: {
      listVpsVideoCacheReferences: async () => [ref("fallback-db-failure")], listVideoCacheReferences: async () => [],
      updateVideoCacheReferenceMedia: async (_id, mode) => {
        fallbackDbFailureUpdates.push(mode);
        throw new Error("database unavailable");
      }, deleteVideoCacheReference: async () => undefined,
    },
    client: { user: { id: "bot-1" }, channels: { fetch: async () => ({ messages: { fetch: async () => message(async () => undefined) } }) } },
    resolveMedia: async () => ({ status: "ok", mediaUrl: "https://rr.example.googlevideo.com/video.mp4" }), cleanup: async () => ({ evictedVideoIds: [] }), videoExists: async () => true,
  });
  await fallbackDbFailureService.fallbackVideos(["video-1"]);
  assert.deepEqual(fallbackDbFailureUpdates, ["google"]);

  const fallbackUnknownUpdates: string[] = [];
  const fallbackUnknownDeletes: string[] = [];
  const fallbackUnknownService = createYouTubeVideoCacheMaintenanceService({
    repo: {
      listVpsVideoCacheReferences: async () => [ref("fallback-unknown")], listVideoCacheReferences: async () => [],
      updateVideoCacheReferenceMedia: async (_id, mode) => { fallbackUnknownUpdates.push(mode); },
      deleteVideoCacheReference: async (id) => { fallbackUnknownDeletes.push(id); },
    },
    client: { user: { id: "bot-1" }, channels: { fetch: async () => ({ messages: { fetch: async () => message(async () => { throw { code: 10003 }; }) } }) } },
    resolveMedia: async () => ({ status: "ok", mediaUrl: "https://rr.example.googlevideo.com/video.mp4" }), cleanup: async () => ({ evictedVideoIds: [] }), videoExists: async () => true,
  });
  await fallbackUnknownService.fallbackVideos(["video-1"]);
  assert.deepEqual(fallbackUnknownDeletes, ["fallback-unknown"]);
  assert.deepEqual(fallbackUnknownUpdates, []);

  const restoreOrder: string[] = [];
  const restoreEditFailureService = createYouTubeVideoCacheMaintenanceService({
    repo: {
      listVpsVideoCacheReferences: async () => [], listVideoCacheReferences: async () => [ref("restore-edit-failure", "google")],
      updateVideoCacheReferenceMedia: async (_id, mode) => { restoreOrder.push(`db:${mode}`); }, deleteVideoCacheReference: async () => undefined,
    },
    client: { user: { id: "bot-1" }, channels: { fetch: async () => ({ messages: { fetch: async () => message(async () => { restoreOrder.push("edit:vps"); throw new Error("discord unavailable"); }) } }) } },
    resolveMedia: async () => ({ status: "fallback", reason: "unused" }), cleanup: async () => ({ evictedVideoIds: [] }), videoExists: async () => true,
  });
  await restoreEditFailureService.restoreCachedVideo("video-1", "https://media.example/video-1.mp4");
  assert.deepEqual(restoreOrder, ["db:vps", "edit:vps", "db:google"]);

  const restoreUnknownUpdates: string[] = [];
  const restoreUnknownDeletes: string[] = [];
  const restoreUnknownService = createYouTubeVideoCacheMaintenanceService({
    repo: {
      listVpsVideoCacheReferences: async () => [], listVideoCacheReferences: async () => [ref("restore-unknown", "google")],
      updateVideoCacheReferenceMedia: async (_id, mode) => { restoreUnknownUpdates.push(mode); },
      deleteVideoCacheReference: async (id) => { restoreUnknownDeletes.push(id); },
    },
    client: { user: { id: "bot-1" }, channels: { fetch: async () => ({ messages: { fetch: async () => message(async () => { throw { code: 10008 }; }) } }) } },
    resolveMedia: async () => ({ status: "fallback", reason: "unused" }), cleanup: async () => ({ evictedVideoIds: [] }), videoExists: async () => true,
  });
  await restoreUnknownService.restoreCachedVideo("video-1", "https://media.example/video-1.mp4");
  assert.deepEqual(restoreUnknownDeletes, ["restore-unknown"]);
  assert.deepEqual(restoreUnknownUpdates, ["vps"]);

  const restored: Array<[string, string]> = [];
  const restoreService = createYouTubeVideoCacheMaintenanceService({
    repo: {
      listVpsVideoCacheReferences: async () => [], listVideoCacheReferences: async (_id, mode) => [ref("google", mode ?? "google"), ref("none", mode ?? "none")],
      updateVideoCacheReferenceMedia: async (id, mode) => { restored.push([id, mode]); }, deleteVideoCacheReference: async () => undefined,
    },
    client: { user: { id: "bot-1" }, channels: { fetch: async () => ({ messages: { fetch: async () => message(async () => undefined) } }) } },
    resolveMedia: async () => ({ status: "fallback", reason: "unused" }), cleanup: async () => ({ evictedVideoIds: [] }), videoExists: async () => true,
  });
  await restoreService.restoreCachedVideo("video-1", "https://media.example/video-1.mp4");
  assert.deepEqual(restored, [["google", "vps"], ["none", "vps"]]);

  const scheduled: Array<() => void> = [];
  const cleared: unknown[] = [];
  let cleanupCalls = 0;
  const startupService = createYouTubeVideoCacheMaintenanceService({
    repo: { listVpsVideoCacheReferences: async () => [ref("startup")], listVideoCacheReferences: async () => [], updateVideoCacheReferenceMedia: async () => undefined, deleteVideoCacheReference: async () => undefined },
    client: { user: { id: "bot-1" }, channels: { fetch: async () => ({ messages: { fetch: async () => message(async () => undefined) } }) } },
    resolveMedia: async () => ({ status: "fallback", reason: "missing" }),
    cleanup: async () => { cleanupCalls += 1; return { evictedVideoIds: [] }; },
    videoExists: async () => false,
    setInterval: (callback, delay) => { assert.equal(delay, 60 * 60 * 1000); scheduled.push(callback); return "timer" as never; },
    clearInterval: (timer) => { cleared.push(timer); },
  });
  const controller = await startupService.start();
  assert.equal(cleanupCalls, 1);
  assert.equal(scheduled.length, 1);
  controller.stop();
  assert.deepEqual(cleared, ["timer"]);

  const startupErrors: string[] = [];
  const retryTimers: Array<() => void> = [];
  let startupAttempts = 0;
  const retryStartService = createYouTubeVideoCacheMaintenanceService({
    repo: { listVpsVideoCacheReferences: async () => [], listVideoCacheReferences: async () => [], updateVideoCacheReferenceMedia: async () => undefined, deleteVideoCacheReference: async () => undefined },
    client: { user: { id: "bot-1" }, channels: { fetch: async () => null } },
    resolveMedia: async () => ({ status: "fallback", reason: "unused" }),
    cleanup: async () => { startupAttempts += 1; if (startupAttempts === 1) throw new Error("initial cleanup failed"); return { evictedVideoIds: [] }; },
    videoExists: async () => true,
    onError: (error) => { startupErrors.push(String((error as Error).message)); },
    setInterval: (callback) => { retryTimers.push(callback); return "retry-timer" as never; },
    clearInterval: () => undefined,
  });
  const retryController = await retryStartService.start();
  await retryStartService.start();
  assert.deepEqual(startupErrors, ["initial cleanup failed"]);
  assert.equal(retryTimers.length, 1);
  retryTimers[0]!();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(startupAttempts, 2);
  retryController.stop();
}

run().then(() => console.log("youtubeVideoCache.service.spec.ts: all assertions passed")).catch((error) => {
  console.error(error);
  process.exit(1);
});
