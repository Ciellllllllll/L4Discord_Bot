import assert from "node:assert/strict";
import { test } from "node:test";
import { createGameDealWatcherController, groupSubscriptionNotificationHits } from "./gameDealWatcher.js";
import type { GameDealSubscriptionHit } from "./gameDealTypes.js";

type ScheduledTimer = {
  callback: () => void;
  delay: number;
  cleared: boolean;
};

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  return { promise: new Promise<void>((done) => { resolve = done; }), resolve };
}

function subscriptionHit(id: string, userId: string): GameDealSubscriptionHit {
  return {
    subscription: { id, guildId: "guild", channelId: "channel", userId, platform: "steam", targetId: "10", url: "https://example.test/10", title: null, lastStateKey: null, active: true },
    title: "Game", url: "https://example.test/10", imageUrl: null, originalPrice: 1000, currentPrice: 500, discountPercent: 50, stateKey: "steam:10:500:50", platform: "steam",
  };
}

test("subscription hits update each subscription and group matching notifications", async () => {
  const updated: string[] = [];
  const grouped = await groupSubscriptionNotificationHits(
    [subscriptionHit("sub-1", "user-1"), subscriptionHit("sub-2", "user-2")],
    { updateSubscriptionSeen: async (hit) => { updated.push(hit.subscription.id); return { shouldNotify: true }; } },
  );
  assert.deepEqual(updated, ["sub-1", "sub-2"]);
  assert.equal(grouped.detectedCount, 2);
  const group = [...grouped.groups.values()][0]!;
  assert.deepEqual(group.subscriptionIds, ["sub-1", "sub-2"]);
  assert.deepEqual([...group.userIds], ["user-1", "user-2"]);
});

test("subscription hit processing stops before state updates when aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  let updated = false;
  await assert.rejects(
    groupSubscriptionNotificationHits([subscriptionHit("sub-1", "user-1")], { updateSubscriptionSeen: async () => { updated = true; return { shouldNotify: true }; } }, controller.signal),
  );
  assert.equal(updated, false);
});

test("game deal watcher shutdown clears scheduled work and waits for an in-flight tick", async () => {
  const timers: ScheduledTimer[] = [];
  const running = deferred();
  let tickCount = 0;
  const watcher = createGameDealWatcherController({
    intervalMs: 60_000,
    startDelayMs: 8_000,
    stopGraceMs: 1_000,
    setTimeout: (callback, delay) => {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer as unknown as NodeJS.Timeout;
    },
    clearTimeout: (timer) => { (timer as unknown as ScheduledTimer).cleared = true; },
    setInterval: (callback, delay) => {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer as unknown as NodeJS.Timeout;
    },
    clearInterval: (timer) => { (timer as unknown as ScheduledTimer).cleared = true; },
    tick: async () => {
      tickCount += 1;
      await running.promise;
    },
  });

  timers.find((timer) => timer.delay === 8_000)!.callback();
  await Promise.resolve();
  const stopped = watcher.stop();
  assert.equal(tickCount, 1);
  assert.equal(timers.filter((timer) => timer.delay !== 1_000).every((timer) => timer.cleared), true);

  running.resolve();
  await stopped;
  timers.find((timer) => timer.delay === 60_000)!.callback();
  await Promise.resolve();
  assert.equal(tickCount, 1);
});

test("game deal watcher aborts an overdue in-flight tick before it finishes shutdown", async () => {
  const stopped = deferred();
  let aborted = false;
  const watcher = createGameDealWatcherController({
    intervalMs: 60_000,
    startDelayMs: 0,
    stopGraceMs: 0,
    tick: async (signal) => {
      signal.addEventListener("abort", () => {
        aborted = true;
        stopped.resolve();
      }, { once: true });
      await stopped.promise;
    },
  });

  await Promise.resolve();
  await watcher.stop();
  assert.equal(aborted, true);
});
