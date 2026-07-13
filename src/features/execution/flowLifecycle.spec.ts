import assert from "node:assert/strict";
import {
  FlowDeadlineTimers,
  FlowTargetLocks,
  remainingDeadlineDelayMs,
  scheduleRestoredDeadline,
  tallyChoices,
  pickSingleWinner,
  persistTerminalState,
  PollFlowStateStore,
  FlowOrchestrator,
  saveOpenPollState,
  publishReservedPollMessage,
  claimPollAdminApproval,
  commitClaimedPollTerminal,
} from "./flowLifecycle.js";
import Database from "better-sqlite3";
import { createKysely } from "../../core/db/kysely.js";

{
  const timers = new FlowDeadlineTimers<ReturnType<typeof setTimeout>>({
    setTimeout() { return {} as ReturnType<typeof setTimeout>; },
    clearTimeout() {},
  });
  const orchestrator = new FlowOrchestrator({
    namespace: "test",
    timers,
    parse: (value: unknown) => value as { phase: string; target_id: string },
    targetId: (state) => state.target_id,
    clearTimers: () => undefined,
    retainTarget: () => true,
    releaseTarget: () => undefined,
    releaseAllTargets: () => undefined,
    listOpen: async () => [],
    findOpen: async () => null,
    cancelMalformed: async () => undefined,
    settleTerminal: async () => undefined,
    abort: async () => true,
    transitionPoll1: async () => undefined,
    transitionPoll2: async () => undefined,
    adminPending: () => false,
    adminDeadline: () => 0,
    claimed: () => false,
    unpublished: () => false,
    poll1Deadline: () => null,
    poll2Deadline: () => null,
    restoredDeadlineExpiredHeading: "expired",
    adminTimeoutHeading: "admin timeout",
    duplicateTargetHeading: "duplicate",
    claimedHeading: "claimed",
    unpublishedHeading: "unpublished",
    log: () => undefined,
  });
  assert.equal(orchestrator.timerKey("poll1", "flow-1"), "poll1:flow-1");
}

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
  const sqlite = new Database(":memory:");
  sqlite.exec(`CREATE TABLE polls (
    id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, message_id TEXT,
    kind TEXT NOT NULL, status TEXT NOT NULL, state TEXT NOT NULL,
    state_revision INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
  )`);
  sqlite.prepare("INSERT INTO polls (id, guild_id, channel_id, kind, status, state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run("publish-flow", "guild", "channel", "execution", "open", JSON.stringify({ phase: "draft", reserved: false, message_id: null }), "2026-01-01T00:00:00.000Z");
  const db = createKysely(sqlite);
  const store = new PollFlowStateStore(db);
  type State = { phase: string; reserved: boolean; message_id: string | null };
  const parse = (value: unknown) => value as State;
  const initial = await store.findOpen("publish-flow", "execution", parse);
  assert.ok(initial);
  const saved = await saveOpenPollState({ store, id: "publish-flow", kind: "execution", parse, nextState: { ...initial.state, phase: "reserved", reserved: true } });
  assert.equal(saved, true);
  const published = await publishReservedPollMessage({
    store,
    id: "publish-flow",
    kind: "execution",
    parse,
    isReserved: (state) => state.phase === "reserved" && state.reserved,
    publish: async () => ({ id: "discord-message" }),
    publishedState: (state, message) => ({ ...state, reserved: false, message_id: message.id }),
    messageId: (message) => message.id,
    discard: async () => undefined,
  });
  assert.equal(published?.id, "discord-message");
  const persisted = await store.findOpen("publish-flow", "execution", parse);
  assert.deepEqual(persisted?.state, { phase: "reserved", reserved: false, message_id: "discord-message" });
  await db.destroy();
  sqlite.close();
}

{
  const events: string[] = [];
  const timers = new FlowDeadlineTimers<ReturnType<typeof setTimeout>>({
    setTimeout() { return {} as ReturnType<typeof setTimeout>; },
    clearTimeout() {},
  });
  const orchestrator = new FlowOrchestrator<{}, { phase: string; target_id: string }>({
    namespace: "test",
    timers,
    parse: (value) => value as { phase: string; target_id: string },
    targetId: (state) => state.target_id,
    clearTimers: (id) => events.push(`clear:${id}`),
    retainTarget: () => true,
    releaseTarget: () => undefined,
    releaseAllTargets: () => events.push("release-all"),
    listOpen: async () => [{ id: "expired", guild_id: "guild", state: { phase: "poll1_pending", target_id: "target" }, updated_at: new Date(0) }],
    findOpen: async () => null,
    cancelMalformed: async () => undefined,
    settleTerminal: async () => undefined,
    abort: async () => true,
    transitionPoll1: async (_ctx, id) => { events.push(`poll1:${id}`); },
    transitionPoll2: async () => undefined,
    adminPending: () => false,
    adminDeadline: () => 0,
    claimed: () => false,
    unpublished: () => false,
    poll1Deadline: (state) => state.phase === "poll1_pending" ? 10 : null,
    poll2Deadline: () => null,
    restoredDeadlineExpiredHeading: "expired",
    adminTimeoutHeading: "admin timeout",
    duplicateTargetHeading: "duplicate",
    claimedHeading: "claimed",
    unpublishedHeading: "unpublished",
    log: () => undefined,
  });
  await orchestrator.reconcile({}, 10);
  assert.deepEqual(events, ["release-all", "clear:expired", "poll1:expired"]);
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
  assert.equal(remainingDeadlineDelayMs(1_500, 1_000), 500);
  assert.equal(remainingDeadlineDelayMs(500, 1_000), 0);
  assert.equal(remainingDeadlineDelayMs(Number.NaN, 1_000), 0);

  const scheduled: Array<{ delayMs: number; handle: object }> = [];
  const timers = new FlowDeadlineTimers({
    setTimeout(_callback, delayMs) {
      const handle = {};
      scheduled.push({ delayMs, handle });
      return handle;
    },
    clearTimeout() {},
  });
  scheduleRestoredDeadline(timers, "flow-1", 900, () => undefined, 1_000);
  assert.equal(scheduled[0]?.delayMs, 0);
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
