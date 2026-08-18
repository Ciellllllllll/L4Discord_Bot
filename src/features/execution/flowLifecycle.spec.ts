import assert from "node:assert/strict";
import {
  FlowDeadlineTimers,
  FlowTargetLocks,
  persistTerminalState,
  PollFlowStateStore,
  claimPollAdminApproval,
  commitClaimedPollTerminal,
} from "./flowLifecycle.js";
import { tallyChoices, pickSingleWinner } from "./twoStagePollRuntime.js";
import Database from "better-sqlite3";
import { createKysely } from "../../core/db/kysely.js";

{
  const sqlite = new Database(":memory:");
  sqlite.exec(`CREATE TABLE polls (
    id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, message_id TEXT,
    kind TEXT NOT NULL, status TEXT NOT NULL, state TEXT NOT NULL,
    state_revision INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
  )`);
  const initial = { phase: "admin_pending", admin_button_fired: false };
  sqlite.prepare("INSERT INTO polls (id, guild_id, channel_id, kind, status, state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run("terminal-flow", "guild", "channel", "execution", "open", JSON.stringify(initial), "2026-01-01T00:00:00.000Z");
  const db = createKysely(sqlite);
  const store = new PollFlowStateStore(db);
  const current = await store.findOpen("terminal-flow", "execution", (value) => value as typeof initial);
  assert.ok(current);
  assert.equal(await claimPollAdminApproval({ store, id: "terminal-flow", state: current.state, stateRevision: current.stateRevision, rawState: current.rawState }), true);
  assert.equal(await commitClaimedPollTerminal({ store, id: "terminal-flow", state: current.state, stateRevision: current.stateRevision, terminalPhase: "completed" }), true);
  const row = await db.selectFrom("polls").select(["status", "state_revision"]).where("id", "=", "terminal-flow").executeTakeFirstOrThrow();
  assert.equal(row.status, "completed");
  assert.equal(row.state_revision, 2);
  await db.destroy();
  sqlite.close();
}

{
  const locks = new FlowTargetLocks();

  assert.equal(locks.acquire("execution", "guild-1", "target-1"), true);
  assert.equal(locks.acquire("execution", "guild-1", "target-1"), false);
  assert.equal(locks.acquire("timeout-extend", "guild-1", "target-1"), true);
}

{
  const events: string[] = [];
  const completed = await persistTerminalState(
    async () => {
      events.push("persist");
    },
    () => events.push("cleanup"),
  );
  assert.deepEqual(completed, { ok: true });
  assert.deepEqual(events, ["persist", "cleanup"]);

  const failedEvents: string[] = [];
  const failed = await persistTerminalState(
    async () => {
      failedEvents.push("persist");
      throw new Error("database unavailable");
    },
    () => failedEvents.push("cleanup"),
  );
  assert.equal(failed.ok, false);
  assert.match(String(failed.error), /database unavailable/);
  assert.deepEqual(failedEvents, ["persist"]);
}

{
  const locks = new FlowTargetLocks();
  locks.acquire("execution", "guild-1", "target-1");
  locks.release("execution", "guild-1", "target-1");

  assert.equal(locks.acquire("execution", "guild-1", "target-1"), true);
}

{
  const scheduled: Array<{ delayMs: number; callback: () => void; handle: object }> = [];
  const cleared: object[] = [];
  const timers = new FlowDeadlineTimers({
    setTimeout(callback, delayMs) {
      const handle = {};
      scheduled.push({ delayMs, callback, handle });
      return handle;
    },
    clearTimeout(handle) {
      cleared.push(handle);
    },
  });

  timers.schedule("flow-1", 1_000, () => undefined);
  timers.schedule("flow-1", 2_000, () => undefined);
  timers.clear("flow-1");

  assert.deepEqual(scheduled.map((entry) => entry.delayMs), [1_000, 2_000]);
  assert.deepEqual(cleared, [scheduled[0]!.handle, scheduled[1]!.handle]);
}

{
  const scheduled: Array<{ delayMs: number; callback: () => void; handle: object }> = [];
  const timers = new FlowDeadlineTimers({
    setTimeout(callback, delayMs) {
      const handle = {};
      scheduled.push({ delayMs, callback, handle });
      return handle;
    },
    clearTimeout() {},
  });
  let calls = 0;

  timers.schedule("flow-1", 100, () => {
    calls += 1;
  });
  timers.schedule("flow-1", 200, () => {
    calls += 10;
  });
  scheduled[0]!.callback();
  scheduled[1]!.callback();
  scheduled[1]!.callback();

  assert.equal(calls, 10);
  assert.equal(timers.has("flow-1"), false);

  timers.schedule("flow-2", 100, () => {
    throw new Error("callback failed");
  });
  assert.throws(() => scheduled[2]!.callback(), /callback failed/);
  assert.equal(timers.has("flow-2"), false);
}

{
  const scheduled: number[] = [];
  const timers = new FlowDeadlineTimers({
    setTimeout(_callback, delayMs) {
      scheduled.push(delayMs);
      return {};
    },
    clearTimeout() {},
  });

  timers.schedule("nan", Number.NaN, () => undefined);
  timers.schedule("infinity", Number.POSITIVE_INFINITY, () => undefined);
  timers.schedule("negative", -1, () => undefined);

  assert.deepEqual(scheduled, [0, 0, 0]);
}

{
  const counts = tallyChoices(
    { user1: "timeout", user2: "kick", user3: "timeout", user4: "toString", user5: "unknown" },
    ["timeout", "kick", "ban"],
  );
  assert.deepEqual(counts, { timeout: 2, kick: 1, ban: 0 });
  assert.equal(pickSingleWinner({ timeout: 2, kick: 2, ban: 0 }, ["timeout", "kick", "ban"]), null);
  assert.equal(pickSingleWinner({ timeout: 3, kick: 2, ban: 0 }, ["timeout", "kick", "ban"]), "timeout");
}

{
  const sqlite = new Database(":memory:");
  sqlite.exec(`CREATE TABLE polls (
    id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    message_id TEXT,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    state TEXT NOT NULL,
    state_revision INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  )`);
  sqlite.prepare("INSERT INTO polls (id, guild_id, channel_id, kind, status, state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run("flow", "guild", "channel", "execution", "open", JSON.stringify({ phase: "poll1_pending", votes: {} }), "2026-01-01T00:00:00.000Z");
  const db = createKysely(sqlite);
  const store = new PollFlowStateStore(db);
  const current = await store.findOpen("flow", "execution", (value) => value as { phase: string; votes: Record<string, string> });
  assert.ok(current);
  const first = await store.compareAndSwap({
    id: "flow",
    expectedPhase: "poll1_pending",
    expectedRevision: current.stateRevision,
    expectedRawState: current.rawState,
    nextState: { phase: "poll1_pending", votes: { user1: "yes" } },
  });
  assert.equal(first, true);
  const stale = await store.compareAndSwap({
    id: "flow",
    expectedPhase: "poll1_pending",
    expectedRevision: current.stateRevision,
    expectedRawState: current.rawState,
    nextState: { phase: "poll2_pending", votes: {} },
  });
  assert.equal(stale, false);
  const phaseMismatch = await store.compareAndSwap({
    id: "flow",
    expectedPhase: "admin_pending",
    expectedRevision: current.stateRevision + 1,
    expectedRawState: JSON.stringify({ phase: "poll1_pending", votes: { user1: "yes" } }),
    nextState: { phase: "admin_pending", votes: {} },
  });
  assert.equal(phaseMismatch, false);
  const merged = await store.mergeVoteWithRetry({
    id: "flow",
    kind: "execution",
    expectedPhase: "poll1_pending",
    parse: (value) => value as { phase: string; votes: Record<string, string> },
    merge: (state) => ({ ...state, votes: { ...state.votes, user2: "no" } }),
  });
  assert.deepEqual(merged, { phase: "poll1_pending", votes: { user1: "yes", user2: "no" } });
  await db.destroy();
  sqlite.close();
}

{
  const sqlite = new Database(":memory:");
  sqlite.exec(`CREATE TABLE polls (
    id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    message_id TEXT,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    state TEXT NOT NULL,
    state_revision INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  )`);
  const unclaimed = { phase: "admin_pending", admin_button_fired: false };
  const claimed = { phase: "admin_pending", admin_button_fired: true };
  sqlite.prepare("INSERT INTO polls (id, guild_id, channel_id, kind, status, state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run("claimed-flow", "guild", "channel", "execution", "open", JSON.stringify(unclaimed), "2026-01-01T00:00:00.000Z");
  const db = createKysely(sqlite);
  const store = new PollFlowStateStore(db);
  const beforeClaim = await store.findOpen("claimed-flow", "execution", (value) => value as typeof unclaimed);
  assert.ok(beforeClaim);
  await store.compareAndSwap({
    id: "claimed-flow",
    expectedPhase: "admin_pending",
    expectedRevision: beforeClaim.stateRevision,
    expectedRawState: beforeClaim.rawState,
    nextState: claimed,
  });
  const cancelled = await store.cancelOpenFlow({
    id: "claimed-flow",
    kind: "execution",
    expectedPhase: "admin_pending",
    parse: (value) => value as typeof unclaimed,
    expected: beforeClaim,
    canCancel: (state) => state.admin_button_fired === false,
  });
  assert.equal(cancelled, null, "claim 後に到着した timeout/cancel は claimed flow を終端化しない");
  await db.destroy();
  sqlite.close();
}

console.log("flowLifecycle.spec.ts: all assertions passed");
