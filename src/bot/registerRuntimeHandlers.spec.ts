import assert from "node:assert/strict";
import { test } from "node:test";
import { createRuntimeResourceLifecycle, createRuntimeShutdown, initializeJapaneseRuntime, respondToInteractionError, shouldStartYouTubeVideoCacheMaintenance, shutdownModerationFlowRuntimes, startClientReadyBackgroundServices } from "./registerRuntimeHandlers.js";

test("interaction errors reply, edit deferred replies, and fall back to follow-up", async () => {
  const calls: string[] = [];
  await respondToInteractionError({
    replied: false,
    deferred: false,
    reply: async () => { calls.push("reply"); },
  } as never);
  await respondToInteractionError({
    replied: false,
    deferred: true,
    editReply: async () => { calls.push("edit"); },
  } as never);
  await respondToInteractionError({
    replied: true,
    deferred: false,
    followUp: async () => { calls.push("followUp"); },
  } as never);
  await respondToInteractionError({
    replied: false,
    deferred: true,
    editReply: async () => { calls.push("editFail"); throw new Error("edit failed"); },
    followUp: async () => { calls.push("fallback"); },
  } as never);
  const failures: string[] = [];
  await respondToInteractionError({
    replied: false,
    deferred: false,
    reply: async () => { throw new Error("reply failed"); },
    followUp: async () => { calls.push("replyFallback"); },
  } as never, (_error, method) => { failures.push(method); });
  assert.deepEqual(calls, ["reply", "edit", "followUp", "editFail", "fallback", "replyFallback"]);
  assert.deepEqual(failures, ["reply"]);
});

test("runtime shutdown stops timers, watcher, worker, VC sweep, and Discord client", async () => {
  const calls: string[] = [];
  const shutdown = createRuntimeShutdown({
    presenceTimer: { marker: "presence" } as unknown as NodeJS.Timeout,
    reminderTimer: { marker: "reminder" } as unknown as NodeJS.Timeout,
    gameDealWatcher: { stop: async () => { calls.push("deals"); } },
    clearInterval: (timer) => { calls.push((timer as unknown as { marker: string }).marker); },
    lolWatcher: { stop: async () => { calls.push("lol"); } },
    japaneseWorker: { stop: async () => { calls.push("worker"); } },
    vcTemp: { stopSweep: () => { calls.push("vc"); } },
    client: { destroy: () => { calls.push("client"); } },
  });
  await shutdown();
  assert.deepEqual(calls, ["presence", "reminder", "deals", "lol", "worker", "vc", "client"]);
});

test("runtime shutdown stops resources registered after clientReady", async () => {
  const calls: string[] = [];
  const lifecycle = createRuntimeResourceLifecycle({
    vcTemp: { stopSweep: () => { calls.push("vc"); } },
    client: { destroy: () => { calls.push("client"); } },
    clearInterval: (timer) => { calls.push((timer as unknown as { marker: string }).marker); },
  });

  await lifecycle.setClientReadyResources({
    presenceTimer: { marker: "presence" } as unknown as NodeJS.Timeout,
    reminderTimer: { marker: "reminder" } as unknown as NodeJS.Timeout,
    gameDealWatcher: { stop: async () => { calls.push("deals"); } },
    lolWatcher: { stop: async () => { calls.push("lol"); } },
  });

  await lifecycle.shutdown();
  assert.deepEqual(calls, ["presence", "reminder", "deals", "lol", "vc", "client"]);
});

test("runtime shutdown attempts every resource when a watcher stop fails", async () => {
  const calls: string[] = [];
  const shutdown = createRuntimeShutdown({
    presenceTimer: { marker: "presence" } as unknown as NodeJS.Timeout,
    clearInterval: () => { calls.push("presence"); },
    lolWatcher: { stop: async () => { calls.push("lol"); throw new Error("lol stop failed"); } },
    japaneseWorker: { stop: async () => { calls.push("worker"); } },
    vcTemp: { stopSweep: () => { calls.push("vc"); } },
    client: { destroy: () => { calls.push("client"); } },
  });

  await assert.rejects(shutdown(), /lol stop failed/);
  assert.deepEqual(calls, ["presence", "lol", "worker", "vc", "client"]);
});

test("resources registered after shutdown are stopped instead of being retained", async () => {
  const calls: string[] = [];
  const lifecycle = createRuntimeResourceLifecycle({
    vcTemp: { stopSweep: () => { calls.push("vc"); } },
    client: { destroy: () => { calls.push("client"); } },
    clearInterval: (timer) => { calls.push((timer as unknown as { marker: string }).marker); },
  });

  await lifecycle.shutdown();
  await lifecycle.setClientReadyResources({
    presenceTimer: { marker: "presence" } as unknown as NodeJS.Timeout,
    lolWatcher: { stop: async () => { calls.push("lol"); } },
  });
  await lifecycle.setJapaneseWorker({ stop: async () => { calls.push("worker"); } });

  assert.deepEqual(calls, ["vc", "client", "presence", "lol", "worker"]);
});

test("lifecycle clears deferred command synchronization timer during shutdown", async () => {
  const calls: string[] = [];
  const lifecycle = createRuntimeResourceLifecycle({
    vcTemp: { stopSweep: () => { calls.push("vc"); } },
    client: { destroy: () => { calls.push("client"); } },
    setTimeout: () => ({ marker: "sync" } as unknown as NodeJS.Timeout),
    clearTimeout: (timer) => { calls.push((timer as unknown as { marker: string }).marker); },
  });

  lifecycle.scheduleTimeout(() => { calls.push("callback"); }, 100);
  await lifecycle.shutdown();

  assert.equal(lifecycle.isClosed(), true);
  assert.deepEqual(calls, ["sync", "vc", "client"]);
});

test("runtime lifecycle runs moderation flow cleanup before destroying the Discord client", async () => {
  const calls: string[] = [];
  const lifecycle = createRuntimeResourceLifecycle({
    vcTemp: { stopSweep: () => { calls.push("vc"); } },
    client: { destroy: () => { calls.push("client"); } },
    shutdownModerationFlows: () => { calls.push("flows"); },
  });

  await lifecycle.shutdown();

  assert.deepEqual(calls, ["flows", "vc", "client"]);
  assert.equal(typeof shutdownModerationFlowRuntimes, "function");
});

test("closed lifecycle prevents clientReady background services from starting", async () => {
  const calls: string[] = [];
  const lifecycle = createRuntimeResourceLifecycle({
    vcTemp: { stopSweep: () => undefined },
    client: { destroy: () => undefined },
  });
  await lifecycle.shutdown();

  const started = await startClientReadyBackgroundServices({
    lifecycle,
    startPresence: () => { calls.push("presence"); return {} as NodeJS.Timeout; },
    startReminder: () => { calls.push("reminder"); return {} as NodeJS.Timeout; },
    startGameDeal: () => { calls.push("deals"); return { stop: async () => undefined }; },
    startLolWatcher: async () => { calls.push("lol"); return null; },
    startYouTubeWatcher: () => { calls.push("youtube"); return null; },
    logError: () => undefined,
  });

  assert.equal(started, false);
  assert.deepEqual(calls, []);
});

test("Lol watcher startup failure stops already registered clientReady timers", async () => {
  const calls: string[] = [];
  const errors: unknown[] = [];
  const lifecycle = createRuntimeResourceLifecycle({
    vcTemp: { stopSweep: () => undefined },
    client: { destroy: () => undefined },
    clearInterval: (timer) => { calls.push((timer as unknown as { marker: string }).marker); },
  });

  const started = await startClientReadyBackgroundServices({
    lifecycle,
    startPresence: () => ({ marker: "presence" } as unknown as NodeJS.Timeout),
    startReminder: () => ({ marker: "reminder" } as unknown as NodeJS.Timeout),
    startGameDeal: () => ({ stop: async () => { calls.push("deals"); } }),
    startLolWatcher: async () => { throw new Error("Lol startup failed"); },
    startYouTubeWatcher: () => ({ stop: () => { calls.push("youtube"); } }),
    logError: (error) => { errors.push(error); },
  });

  assert.equal(started, false);
  assert.deepEqual(calls, ["presence", "reminder", "deals"]);
  assert.equal(errors.length, 1);
});

test("Japanese runtime startup failure shuts down the lifecycle before propagating", async () => {
  const calls: string[] = [];
  const lifecycle = createRuntimeResourceLifecycle({
    vcTemp: { stopSweep: () => { calls.push("vc"); } },
    client: { destroy: () => { calls.push("client"); } },
  });

  await assert.rejects(
    () => initializeJapaneseRuntime({
      lifecycle,
      initTokenizer: async () => { throw new Error("kuromoji unavailable"); },
      startWorker: async () => null,
      logError: () => undefined,
    }),
    /kuromoji unavailable/,
  );
  assert.deepEqual(calls, ["vc", "client"]);
  assert.equal(lifecycle.isClosed(), true);
});

test("YouTube cache maintenance starts in production when either preview path is enabled", async () => {
  assert.equal(shouldStartYouTubeVideoCacheMaintenance({
    BOT_PROFILE: "production", YOUTUBE_PREVIEW_ENABLED: true, ADHD_WATCHER_ENABLED: false,
  } as never), true);
  assert.equal(shouldStartYouTubeVideoCacheMaintenance({
    BOT_PROFILE: "production", YOUTUBE_PREVIEW_ENABLED: false, ADHD_WATCHER_ENABLED: true,
  } as never), true);
  assert.equal(shouldStartYouTubeVideoCacheMaintenance({
    BOT_PROFILE: "production", YOUTUBE_PREVIEW_ENABLED: false, ADHD_WATCHER_ENABLED: false,
  } as never), false);
  assert.equal(shouldStartYouTubeVideoCacheMaintenance({
    BOT_PROFILE: "debug", YOUTUBE_PREVIEW_ENABLED: true, ADHD_WATCHER_ENABLED: true,
  } as never), false);
});

test("cache maintenance starts before the watcher and lifecycle shutdown stops it", async () => {
  const calls: string[] = [];
  const lifecycle = createRuntimeResourceLifecycle({
    vcTemp: { stopSweep: () => { calls.push("vc"); } },
    client: { destroy: () => { calls.push("client"); } },
  });
  const started = await startClientReadyBackgroundServices({
    lifecycle,
    startPresence: () => ({ marker: "presence" } as never),
    startReminder: () => ({ marker: "reminder" } as never),
    startGameDeal: () => ({ stop: async () => { calls.push("deals"); } }),
    startYouTubeVideoCacheMaintenance: async () => {
      calls.push("maintenance:start");
      return { stop: () => { calls.push("maintenance:stop"); } };
    },
    startLolWatcher: async () => { calls.push("lol"); return null; },
    startYouTubeWatcher: () => { calls.push("youtube"); return { stop: () => { calls.push("youtube:stop"); } }; },
    logError: () => undefined,
  });
  assert.equal(started, true);
  assert.deepEqual(calls.slice(0, 3), ["maintenance:start", "lol", "youtube"]);
  await lifecycle.shutdown();
  assert.equal(calls.includes("maintenance:stop"), true);
});

test("cache maintenance startup failure clears already registered resources", async () => {
  const calls: string[] = [];
  const lifecycle = createRuntimeResourceLifecycle({
    vcTemp: { stopSweep: () => undefined },
    client: { destroy: () => undefined },
    clearInterval: (timer) => { calls.push((timer as unknown as { marker: string }).marker); },
  });
  const started = await startClientReadyBackgroundServices({
    lifecycle,
    startPresence: () => ({ marker: "presence" } as never),
    startReminder: () => ({ marker: "reminder" } as never),
    startGameDeal: () => ({ stop: async () => { calls.push("deals"); } }),
    startYouTubeVideoCacheMaintenance: async () => { throw new Error("cleanup unavailable"); },
    startLolWatcher: async () => { calls.push("lol"); return null; },
    startYouTubeWatcher: () => null,
    logError: () => undefined,
  });
  assert.equal(started, false);
  assert.deepEqual(calls, ["presence", "reminder", "deals"]);
});
