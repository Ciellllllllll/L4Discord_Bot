import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createKysely } from "../../core/db/kysely.js";
import { FlowDeadlineTimers, PollFlowStateStore } from "./flowLifecycle.js";
import { createTwoStagePollRuntime } from "./twoStagePollRuntime.js";

type TestState = {
  phase: string;
  target_id: string;
  channel_id: string;
  poll1_message_id: string | null;
  poll2_message_id: string | null;
  admin_message_id: string | null;
  poll1_deadline_ms: number;
  poll2_deadline_ms: number | null;
  votes_poll1: Record<string, "yes" | "no">;
  votes_poll2: Record<string, "short" | "long">;
  admin_button_fired: boolean;
};

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const sqlite = new Database(":memory:");
sqlite.exec(`CREATE TABLE polls (
  id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, message_id TEXT,
  kind TEXT NOT NULL, status TEXT NOT NULL, state TEXT NOT NULL,
  state_revision INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
)`);
const initial: TestState = {
  phase: "poll1_pending",
  target_id: "target",
  channel_id: "channel",
  poll1_message_id: "message",
  poll2_message_id: null,
  admin_message_id: null,
  poll1_deadline_ms: Date.now() + 60_000,
  poll2_deadline_ms: null,
  votes_poll1: {},
  votes_poll2: {},
  admin_button_fired: false,
};
sqlite.prepare("INSERT INTO polls (id, guild_id, channel_id, message_id, kind, status, state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
  .run("flow", "guild", "channel", "message", "test_flow", "open", JSON.stringify(initial), "2026-01-01T00:00:00.000Z");
const db = createKysely(sqlite);
const store = new PollFlowStateStore(db);
const parse = (value: unknown): TestState | null => value && typeof value === "object" ? value as TestState : null;
const edits: string[] = [];
let blockActiveEdit = false;
let activeEditEntered = deferred();
let releaseActiveEdit = deferred();
const message = {
  async edit(payload: { content?: string }) {
    if (blockActiveEdit && payload.content?.startsWith("active:")) {
      activeEditEntered.resolve();
      await releaseActiveEdit.promise;
    }
    edits.push(payload.content ?? "");
  },
};
const channel = {
  isTextBased: () => true,
  isDMBased: () => false,
  messages: { fetch: async () => message },
};
const ctx = {
  db,
  log: {
    warn: (_fields: Record<string, unknown>, _message: string) => undefined,
    error: (_fields: Record<string, unknown>, _message: string) => undefined,
  },
};
const timers = new FlowDeadlineTimers<ReturnType<typeof setTimeout>>({ setTimeout, clearTimeout });
let begins = 0;
let approvals = 0;
let denials = 0;
let aborts = 0;
let releases = 0;
let beginBarrier: ReturnType<typeof deferred> | null = null;
let failPoll1 = false;
let failPoll2 = false;
const runtime = createTwoStagePollRuntime<typeof ctx, TestState, "yes" | "no", "short" | "long">({
  namespace: "test",
  kind: "test_flow",
  votePrefix: "vote:",
  approvalPrefix: "approve:",
  timers,
  parse,
  targetId: (state) => state.target_id,
  retainTarget: () => true,
  releaseTarget: () => undefined,
  releaseAllTargets: () => { releases += 1; },
  isAdmin: () => true,
  approvalComponents: () => [],
  canExecuteFinal: () => true,
  executeFinal: async () => { approvals += 1; return { ok: true }; },
  notifyDenied: async () => { denials += 1; },
  cleanupFinal: async () => undefined,
  afterApproved: () => undefined,
  voteDurationMs: () => 60_000,
  adminWaitMs: () => 60_000,
  toPoll1Pending: (state, deadline) => ({ ...state, phase: "poll1_pending", poll1_message_id: null, poll1_deadline_ms: deadline, votes_poll1: {} }),
  poll1Published: (state, messageId) => ({ ...state, poll1_message_id: messageId }),
  resolvePoll1: (state, _winner, deadline) => ({ destination: "poll2", state: { ...state, phase: "poll2_pending", poll2_message_id: null, poll2_deadline_ms: deadline, votes_poll2: {} } }),
  poll2Published: (state, messageId) => ({ ...state, poll2_message_id: messageId }),
  resolvePoll2: (state) => ({ state: { ...state, phase: "admin_pending" }, adminText: "admin" }),
  adminPublished: (state) => state,
  publishPoll1: async () => {
    begins += 1;
    if (beginBarrier) await beginBarrier.promise;
    return failPoll1 ? null : { id: "message", delete: async () => undefined };
  },
  publishPoll2: async () => failPoll2 ? null : { id: "poll2", delete: async () => undefined },
  publishAdmin: async () => ({ id: "admin", delete: async () => undefined }),
  disablePoll1: async () => { edits.push("disabled"); },
  disablePoll2: async () => undefined,
  discardMessage: async () => undefined,
  stopMessages: async () => { aborts += 1; },
  poll1Choices: ["yes", "no"],
  poll2Choices: ["short", "long"],
  poll1Labels: { yes: "賛成", no: "反対" },
  poll2Labels: { short: "短い", long: "長い" },
  renderPoll1: (state) => ({ content: `active:${Object.keys(state.votes_poll1).length}` }),
  renderPoll2: (state) => ({ content: `active:${Object.keys(state.votes_poll2).length}` }),
  adminPending: () => false,
  adminDeadline: () => 0,
  claimed: () => false,
  unpublished: () => false,
  poll1Deadline: (state) => state.phase === "poll1_pending" ? state.poll1_deadline_ms : null,
  poll2Deadline: (state) => state.phase === "poll2_pending" ? state.poll2_deadline_ms : null,
  restoredDeadlineExpiredHeading: "expired",
  adminTimeoutHeading: "admin timeout",
  duplicateTargetHeading: "duplicate",
  unpublishedHeading: "unpublished",
  poll1NoWinnerHeading: "no winner",
  poll2NoWinnerHeading: "no winner",
  poll1PublishFailureHeading: "publish failed",
  poll2PublishFailureHeading: "publish failed",
  adminPublishFailureHeading: "publish failed",
});

function interaction(userId: string, choice: "yes" | "no", replies: string[], flowId = "flow") {
  return {
    customId: `vote:${flowId}:${choice}`,
    user: { id: userId, bot: false },
    channelId: "channel",
    guildId: "guild",
    channel,
    reply: async ({ content }: { content: string }) => { replies.push(content); },
  };
}

{
  sqlite.prepare("INSERT INTO polls (id, guild_id, channel_id, message_id, kind, status, state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run("publication-flow", "guild", "channel", null, "test_flow", "open", JSON.stringify(initial), "2026-01-01T00:00:00.000Z");
  beginBarrier = deferred();
  const beforeBegins = begins;
  const start = runtime.beginPoll1(ctx, "publication-flow", initial, "guild");
  while (begins === beforeBegins) await Promise.resolve();
  await runtime.handleVote(interaction("early-voter", "yes", [], "publication-flow") as never, ctx);
  beginBarrier.resolve();
  assert.equal(await start, true);
  beginBarrier = null;
  const stored = await store.findOpen("publication-flow", "test_flow", parse);
  assert.equal(stored?.state.poll1_message_id, "message");
  assert.equal(stored?.state.votes_poll1["early-voter"], "yes", "投稿ID保存は送信中に入った票を維持する");
}

{
  sqlite.prepare("INSERT INTO polls (id, guild_id, channel_id, message_id, kind, status, state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run("poll1-failure", "guild", "channel", null, "test_flow", "open", JSON.stringify(initial), "2026-01-01T00:00:00.000Z");
  failPoll1 = true;
  assert.equal(await runtime.beginPoll1(ctx, "poll1-failure", initial, "guild"), false);
  failPoll1 = false;
  const row = sqlite.prepare("SELECT status FROM polls WHERE id = ?").get("poll1-failure") as { status: string };
  assert.equal(row.status, "cancelled", "poll1送信失敗後にopenフローを残さない");
}

{
  const state = { ...initial, votes_poll1: { voter: "yes" as const } };
  sqlite.prepare("INSERT INTO polls (id, guild_id, channel_id, message_id, kind, status, state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run("poll2-failure", "guild", "channel", "message", "test_flow", "open", JSON.stringify(state), "2026-01-01T00:00:00.000Z");
  failPoll2 = true;
  await runtime.transitionPoll1(ctx, "poll2-failure", "guild");
  failPoll2 = false;
  const row = sqlite.prepare("SELECT status FROM polls WHERE id = ?").get("poll2-failure") as { status: string };
  assert.equal(row.status, "cancelled", "poll2送信失敗後にopenフローを残さない");
}

function approvalInteraction(flowId: string, action: "approve" | "deny", replies: string[], updates: number[]) {
  return {
    customId: `approve:${flowId}:${action}`,
    user: { id: `admin-${updates.length}`, bot: false },
    channelId: "channel",
    guildId: "guild",
    guild: { members: { fetch: async () => ({}) } },
    channel,
    reply: async ({ content }: { content: string }) => { replies.push(content); },
    update: async () => { updates.push(1); },
  };
}

{
  const replies: string[] = [];
  await Promise.all([
    runtime.handleVote(interaction("user-1", "yes", replies) as never, ctx),
    runtime.handleVote(interaction("user-2", "no", replies) as never, ctx),
  ]);
  const latest = await store.findOpen("flow", "test_flow", parse);
  assert.deepEqual(latest?.state.votes_poll1, { "user-1": "yes", "user-2": "no" }, "同時投票を失わない");
  assert.equal(edits.at(-1), "active:2", "最後の表示は最新の票数を使う");
  assert.equal(replies.filter((reply) => reply === "投票しました。").length, 2);
}

{
  const replies: string[] = [];
  await runtime.handleVote(interaction("user-1", "no", replies) as never, ctx);
  assert.deepEqual(replies, ["投票先を 反対 に変更しました。"]);
}

{
  const replies: string[] = [];
  await Promise.all([
    runtime.handleVote(interaction("user-5", "yes", replies) as never, ctx),
    runtime.handleVote(interaction("user-5", "no", replies) as never, ctx),
  ]);
  assert.equal(replies.filter((reply) => reply === "投票しました。").length, 1);
  assert.equal(replies.filter((reply) => reply.startsWith("投票先を ")).length, 1, "CAS再試行で実際に変更した票を返信へ反映する");
}

{
  edits.length = 0;
  blockActiveEdit = true;
  activeEditEntered = deferred();
  releaseActiveEdit = deferred();
  const vote = runtime.handleVote(interaction("user-3", "yes", []) as never, ctx);
  await activeEditEntered.promise;
  const transition = runtime.transitionPoll1(ctx, "flow", "guild");
  await Promise.resolve();
  assert.deepEqual(edits, [], "投票表示の更新中は締切表示を追い越さない");
  releaseActiveEdit.resolve();
  await Promise.all([vote, transition]);
  assert.deepEqual(edits, ["active:4", "disabled"], "締切表示を最後に適用する");
}

{
  const current = await store.findOpen("flow", "test_flow", parse);
  assert.ok(current);
  sqlite.prepare("UPDATE polls SET state = ?, state_revision = state_revision + 1 WHERE id = ?")
    .run(JSON.stringify({ ...current.state, phase: "poll1_pending", poll1_message_id: "message", poll2_message_id: null, poll1_deadline_ms: Date.now() - 1 }), "flow");
  const replies: string[] = [];
  await runtime.handleVote(interaction("user-4", "yes", replies) as never, ctx);
  const latest = await store.findOpen("flow", "test_flow", parse);
  assert.equal(latest?.state.votes_poll1["user-4"], undefined, "締切後の票は保存しない");
  assert.deepEqual(replies, ["締切を過ぎています。"]);
}

{
  const adminState = { ...initial, phase: "admin_pending", admin_button_fired: false };
  sqlite.prepare("INSERT INTO polls (id, guild_id, channel_id, message_id, kind, status, state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run("approval:flow", "guild", "channel", "message", "test_flow", "open", JSON.stringify(adminState), "2026-01-01T00:00:00.000Z");
  const replies: string[] = [];
  const updates: number[] = [];
  const before = approvals;
  await Promise.all([
    runtime.handleApproval(approvalInteraction("approval:flow", "approve", replies, updates) as never, ctx),
    runtime.handleApproval(approvalInteraction("approval:flow", "approve", replies, updates) as never, ctx),
  ]);
  const row = sqlite.prepare("SELECT status FROM polls WHERE id = ?").get("approval:flow") as { status: string };
  assert.equal(row.status, "completed");
  assert.equal(approvals, before + 1, "同時承認でも最終処理は一度だけ実行する");
  assert.equal(updates.length, 1);
  assert.equal(replies.includes("すでに処理済みです。"), true);
}

{
  const adminState = { ...initial, phase: "admin_pending", admin_button_fired: false };
  sqlite.prepare("INSERT INTO polls (id, guild_id, channel_id, message_id, kind, status, state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run("deny-flow", "guild", "channel", "message", "test_flow", "open", JSON.stringify(adminState), "2026-01-01T00:00:00.000Z");
  const before = denials;
  await runtime.handleApproval(approvalInteraction("deny-flow", "deny", [], []) as never, ctx);
  const row = sqlite.prepare("SELECT status FROM polls WHERE id = ?").get("deny-flow") as { status: string };
  assert.equal(row.status, "cancelled");
  assert.equal(denials, before + 1);
}

{
  const adminState = { ...initial, phase: "admin_pending", admin_button_fired: false };
  sqlite.prepare("INSERT INTO polls (id, guild_id, channel_id, message_id, kind, status, state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run("claim-error", "guild", "channel", "message", "test_flow", "open", JSON.stringify(adminState), "2026-01-01T00:00:00.000Z");
  const errors: string[] = [];
  const failingDb = new Proxy(db, {
    get(target, property) {
      if (property === "updateTable") return () => { throw new Error("db claim failed"); };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const replies: string[] = [];
  await runtime.handleApproval(approvalInteraction("claim-error", "approve", replies, []) as never, {
    db: failingDb,
    log: { warn: () => undefined, error: (_fields: Record<string, unknown>, message: string) => { errors.push(message); } },
  });
  assert.deepEqual(replies, ["状態の保存に失敗しました。再試行してください。"]);
  assert.deepEqual(errors, ["test: approval claim failed"]);
}

beginBarrier = deferred();
const inFlightBegin = runtime.beginPoll1(ctx, "flow", initial, "guild");
await Promise.resolve();
const firstShutdown = runtime.shutdown();
assert.equal(runtime.shutdown(), firstShutdown, "重複shutdownは同じ完了Promiseを返す");
let shutdownFinished = false;
void firstShutdown.then(() => { shutdownFinished = true; });
await Promise.resolve();
assert.equal(shutdownFinished, false, "shutdownは開始済みの公開操作を待つ");
beginBarrier.resolve();
await Promise.all([inFlightBegin, firstShutdown]);
const stateAtShutdown = await store.findOpen("flow", "test_flow", parse);
assert.ok(stateAtShutdown);
const afterShutdownCounters = { begins, approvals, aborts, releases, edits: edits.length };
assert.equal(await runtime.handleVote(interaction("late-user", "yes", []) as never, ctx), false);
assert.equal(await runtime.handleApproval({} as never, ctx), false);
assert.equal(await runtime.beginPoll1(ctx, "flow", initial, "guild"), false);
await runtime.transitionPoll1(ctx, "flow", "guild");
await runtime.transitionPoll2(ctx, "flow", "guild");
assert.equal(await runtime.abort(ctx, "flow", initial, "closed"), false);
await runtime.reconcile(ctx);
const afterShutdown = await store.findOpen("flow", "test_flow", parse);
assert.equal(afterShutdown?.stateRevision, stateAtShutdown.stateRevision, "shutdown後は投票状態を更新しない");
assert.deepEqual({ begins, approvals, aborts, releases, edits: edits.length }, afterShutdownCounters, "shutdown後の公開操作は副作用を起こさない");
await db.destroy();
sqlite.close();

console.log("twoStagePollRuntime.spec.ts: all assertions passed");
