import assert from "node:assert/strict";
import { flowTargetLocks } from "./flowLifecycle.js";

type PollRow = {
  id: string;
  guild_id: string;
  status: string;
  message_id: string | null;
  state: Record<string, unknown> | string;
  state_revision?: number | string;
  updated_at: Date;
};

function executionState(targetId: string, deadlineMs: number): Record<string, unknown> {
  return {
    phase: "poll1_pending",
    invoker_id: "invoker",
    target_id: targetId,
    channel_id: "channel",
    precheck_message_id: null,
    poll1_message_id: "poll1",
    poll2_message_id: null,
    votes_poll1: {},
    votes_poll2: {},
    poll1_deadline_ms: deadlineMs,
    poll2_deadline_ms: null,
    admin_message_id: null,
    resolved_action: null,
    duration_seconds: null,
    admin_button_fired: false,
  };
}

function executionAdminState(targetId: string): Record<string, unknown> {
  return {
    ...executionState(targetId, 0),
    phase: "admin_pending",
    resolved_action: "kick",
  };
}

function timeoutExtendState(targetId: string, deadlineMs: number): Record<string, unknown> {
  return {
    phase: "poll1_pending",
    invoker_id: "invoker",
    target_id: targetId,
    channel_id: "channel",
    poll1_message_id: "poll1",
    poll2_message_id: null,
    admin_message_id: null,
    votes_poll1: {},
    votes_poll2: {},
    poll1_deadline_ms: deadlineMs,
    poll2_deadline_ms: null,
    resolved_extend: null,
    duration_seconds: null,
    admin_button_fired: false,
  };
}

function createContext(rows: PollRow[], options: { channel: "missing" | "text"; failUpdates?: boolean }) {
  const updates: Array<{ id: string; values: Record<string, unknown> }> = [];
  const logs: Array<Record<string, unknown>> = [];
  // 実DBでは追加migrationのDEFAULT 0が必ず入る。旧fixtureも同じ読取契約にする。
  const byId = new Map(rows.map((row) => [row.id, { ...row, state_revision: row.state_revision ?? 0 }]));

  const db = {
    selectFrom() {
      let id: string | undefined;
      const query = {
        select() {
          return query;
        },
        where(column: string, _operator: string, value: string) {
          if (column === "id") id = value;
          return query;
        },
        async execute() {
          return rows;
        },
        async executeTakeFirst() {
          return id ? byId.get(id) : undefined;
        },
      };
      return query;
    },
    updateTable() {
      let values: Record<string, unknown> = {};
      let id = "";
      const query = {
        set(next: Record<string, unknown>) { values = next; return query; },
        where(column: string, _operator: string, value: string | number) {
          if (column === "id") id = String(value);
          return query;
        },
        async execute() {
          if (options.failUpdates) throw new Error("database unavailable");
          updates.push({ id, values });
        },
        async executeTakeFirst() {
          if (options.failUpdates) throw new Error("database unavailable");
          updates.push({ id, values });
          return { numUpdatedRows: 1n };
        },
      };
      return query;
    },
  };

  const textChannel = {
    isTextBased: () => true,
    messages: { fetch: async () => null },
  };
  const ctx = {
    db,
    client: { channels: { fetch: async () => (options.channel === "text" ? textChannel : null) } },
    config: { EXEC_ADMIN_WAIT_SECONDS: 60, EXEC_VOTE_SECONDS: 60, TIMEOUT_EXTEND_ADMIN_WAIT_SECONDS: 60 },
    log: {
      warn: (details: Record<string, unknown>) => logs.push(details),
      error: (details: Record<string, unknown>) => logs.push(details),
      info: (details: Record<string, unknown>) => logs.push(details),
    },
  };
  return { ctx, updates, logs };
}

const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
const timers: Array<{ callback: () => void; delayMs: number; handle: object }> = [];
const cleared: object[] = [];

globalThis.setTimeout = ((callback: () => void, delayMs: number) => {
  const handle = {};
  timers.push({ callback, delayMs, handle });
  return handle as ReturnType<typeof setTimeout>;
}) as typeof setTimeout;
globalThis.clearTimeout = ((handle: object) => {
  cleared.push(handle);
}) as typeof clearTimeout;

try {
  const { reconcileExecutionFlows, shutdownExecutionFlowRuntime } = await import("./executionFlow.js");
  const { reconcileTimeoutExtendFlows, shutdownTimeoutExtendFlowRuntime } = await import("./timeoutExtendFlow.js");
  const now = Date.now();

  {
    const rows: PollRow[] = [
      { id: "winner", guild_id: "guild", status: "open", message_id: null, state: executionState("target", now + 50), updated_at: new Date(now) },
      { id: "duplicate", guild_id: "guild", status: "open", message_id: null, state: executionState("target", now + 50), updated_at: new Date(now) },
    ];
    const { ctx, updates } = createContext(rows, { channel: "text" });
    await reconcileExecutionFlows(ctx as never);

    assert.equal(updates.length, 1);
    assert.equal(updates[0]?.id, "duplicate");
    assert.equal(updates[0]?.values.status, "cancelled");
    assert.equal(timers.length, 1);

    rows[0] = { ...rows[0]!, state: executionAdminState("target"), updated_at: new Date(now) };
    await reconcileExecutionFlows(ctx as never);
    assert.ok(cleared.includes(timers[0]!.handle));
  }

  flowTargetLocks.clear();
  {
    const rows: PollRow[] = [
      { id: "sqlite-execution-state", guild_id: "guild-sqlite-execution", status: "open", message_id: null, state: JSON.stringify(executionState("target-sqlite-execution", now + 60_000)), updated_at: new Date(now) },
    ];
    const { ctx } = createContext(rows, { channel: "text" });
    const timerCount = timers.length;
    await reconcileExecutionFlows(ctx as never);
    assert.equal(timers.length, timerCount + 1, "SQLite の TEXT JSON state も execution flow を復元する");
  }

  flowTargetLocks.clear();
  {
    const rows: PollRow[] = [
      { id: "sqlite-timeout-state", guild_id: "guild-sqlite-timeout", status: "open", message_id: null, state: JSON.stringify(timeoutExtendState("target-sqlite-timeout", now + 60_000)), updated_at: new Date(now) },
    ];
    const { ctx } = createContext(rows, { channel: "text" });
    const timerCount = timers.length;
    await reconcileTimeoutExtendFlows(ctx as never);
    assert.equal(timers.length, timerCount + 1, "SQLite の TEXT JSON state も timeout flow を復元する");
  }

  flowTargetLocks.clear();
  {
    const claimed = { ...executionAdminState("target-claimed"), admin_button_fired: true };
    const rows: PollRow[] = [{ id: "execution-claimed", guild_id: "guild-claimed", status: "open", message_id: null, state: claimed, updated_at: new Date(now) }];
    const { ctx, updates, logs } = createContext(rows, { channel: "text" });
    await reconcileExecutionFlows(ctx as never);
    assert.equal(updates.length, 0, "claim済みのexecution flowは再起動中止処理でcancelしない");
    assert.ok(logs.some((entry) => entry.flowId === "execution-claimed" && entry.guildId === "guild-claimed" && entry.phase === "admin_pending"));
  }

  flowTargetLocks.clear();
  {
    const rows: PollRow[] = [
      { id: "missing-channel", guild_id: "guild-2", status: "open", message_id: null, state: executionState("target-2", now - 1), updated_at: new Date(now) },
    ];
    const { ctx, updates, logs } = createContext(rows, { channel: "missing" });
    await reconcileExecutionFlows(ctx as never);

    assert.equal(updates[0]?.values.status, "cancelled");
    assert.ok(logs.length === 0, "winner が未確定ならチャンネル副作用を行わずに中止する");
  }

  flowTargetLocks.clear();
  {
    const rows: PollRow[] = [
      { id: "persistence-failure", guild_id: "guild-3", status: "open", message_id: null, state: executionState("target-3", now - 1), updated_at: new Date(now) },
    ];
    const { ctx } = createContext(rows, { channel: "missing", failUpdates: true });
    await reconcileExecutionFlows(ctx as never);

    assert.equal(flowTargetLocks.has("execution", "guild-3", "target-3"), true);
  }

  flowTargetLocks.clear();
  {
    const rows: PollRow[] = [
      { id: "timeout-missing-channel", guild_id: "guild-4", status: "open", message_id: null, state: timeoutExtendState("target-4", now - 1), updated_at: new Date(now) },
    ];
    const { ctx, updates, logs } = createContext(rows, { channel: "missing" });
    await reconcileTimeoutExtendFlows(ctx as never);

    assert.equal(updates[0]?.values.status, "cancelled");
    assert.ok(logs.length === 0, "timeout flow もwinner未確定ならチャンネル副作用を行わずに中止する");
  }

  flowTargetLocks.clear();
  {
    const claimed = { ...timeoutExtendState("target-5", now + 60_000), phase: "admin_pending", admin_button_fired: true, resolved_extend: "extend", duration_seconds: 60 };
    const rows: PollRow[] = [{ id: "timeout-claimed", guild_id: "guild-5", status: "open", message_id: null, state: claimed, updated_at: new Date(now) }];
    const { ctx, updates, logs } = createContext(rows, { channel: "text" });
    await reconcileTimeoutExtendFlows(ctx as never);
    assert.equal(updates.length, 0, "claim済みのtimeout flowは再起動中止処理でcancelしない");
    assert.ok(logs.some((entry) => entry.flowId === "timeout-claimed" && entry.guildId === "guild-5" && entry.phase === "admin_pending"));
  }

  flowTargetLocks.clear();
  {
    const executionRows: PollRow[] = [
      { id: "execution-shutdown-poll", guild_id: "shutdown-guild", status: "open", message_id: null, state: executionState("execution-poll-target", now + 60_000), updated_at: new Date(now) },
      {
        id: "execution-shutdown-admin",
        guild_id: "shutdown-guild",
        status: "open",
        message_id: null,
        state: { ...executionAdminState("execution-admin-target"), admin_message_id: "admin" },
        updated_at: new Date(now),
      },
    ];
    const timeoutRows: PollRow[] = [
      { id: "timeout-shutdown-poll", guild_id: "shutdown-guild", status: "open", message_id: null, state: timeoutExtendState("timeout-poll-target", now + 60_000), updated_at: new Date(now) },
      {
        id: "timeout-shutdown-admin",
        guild_id: "shutdown-guild",
        status: "open",
        message_id: null,
        state: {
          ...timeoutExtendState("timeout-admin-target", now + 60_000),
          phase: "admin_pending",
          admin_message_id: "admin",
          resolved_extend: "extend",
          duration_seconds: 60,
        },
        updated_at: new Date(now),
      },
    ];
    const execution = createContext(executionRows, { channel: "text" });
    const timeout = createContext(timeoutRows, { channel: "text" });
    const timerStart = timers.length;
    await reconcileExecutionFlows(execution.ctx as never);
    await reconcileTimeoutExtendFlows(timeout.ctx as never);
    const scheduled = timers.slice(timerStart);
    assert.equal(scheduled.length, 4, "poll と admin の期限タイマーを両フローで登録する");

    shutdownExecutionFlowRuntime();
    shutdownTimeoutExtendFlowRuntime();

    for (const timer of scheduled) {
      assert.ok(cleared.includes(timer.handle), "shutdown は登録済み期限タイマーを解除する");
      timer.callback();
    }
    assert.equal(execution.updates.length, 0, "shutdown 後に処刑フロー期限コールバックを実行しない");
    assert.equal(timeout.updates.length, 0, "shutdown 後に延長フロー期限コールバックを実行しない");
    assert.equal(flowTargetLocks.has("execution", "shutdown-guild", "execution-poll-target"), false);
    assert.equal(flowTargetLocks.has("timeout-extend", "shutdown-guild", "timeout-poll-target"), false);
  }
} finally {
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
  flowTargetLocks.clear();
}

console.log("executionFlow.reconcile.spec.ts: all assertions passed");
