import assert from "node:assert/strict";
import { test } from "node:test";
import { PermissionFlagsBits } from "discord.js";
import type { RemindersRow } from "../../core/db/types.js";
import { withReminderDispatchLock } from "./reminderDispatchLock.js";
import {
  clearPendingDispatchUpdate,
  clearRecurringPermanentSkipWarned,
  clearReminderRetryState,
  getReminderRetryState,
  hasPendingDispatchUpdate,
  hasRecurringPermanentSkipWarned,
  markRecurringPermanentSkipWarned,
  recordPendingDispatchUpdate,
  setReminderRetryState,
} from "./reminderDispatchState.js";
import {
  handleReminderHubButton,
  handleReminderHubChannelSelect,
  handleReminderHubModal,
} from "./reminderHubHandlers.js";
import {
  applyDispatchResult,
  cancelUndeliverableReminder,
  computeNextRecurringFireAt,
  isRecurringReminder,
  updateReminderHubContentAndChannel,
} from "./reminderHubRepo.js";
import { sendReminderHubMessage, StructuralReminderDeliveryError } from "./reminderHubSend.js";
import { startReminderScheduler, stopReminderScheduler } from "./reminderScheduler.js";

function makeReminderRow(
  id: string,
  channelId = "ch-1",
  recurrence: { interval_sec: number } | null = null,
  fireAt = "2026-01-01T00:00:00.000Z",
): RemindersRow {
  return {
    id,
    guild_id: "guild-1",
    channel_id: channelId,
    author_id: "user-1",
    body: `body-${id}`,
    fire_at: fireAt,
    status: "pending",
    data: { ev_type: "reminder", title: `title-${id}`, recurrence } as never,
    created_at: new Date("2026-01-01T00:00:00.000Z"),
  };
}

test("computeNextRecurringFireAt skips missed intervals so next fire_at is strictly after now", () => {
  const base = "2026-01-01T00:00:00.000Z";
  const baseMs = Date.parse(base);
  const hourSec = 3600;

  // Normal on-time execution (5 seconds after fire_at)
  assert.equal(
    computeNextRecurringFireAt(base, hourSec, false, baseMs + 5_000).toISOString(),
    "2026-01-01T01:00:00.000Z",
  );

  // Bot was down for 3.5 hours: must jump to +4h, not +1h
  assert.equal(
    computeNextRecurringFireAt(base, hourSec, false, baseMs + 3.5 * 3600 * 1000).toISOString(),
    "2026-01-01T04:00:00.000Z",
  );

  // Exact boundary (now === base + 1h): must jump to +2h
  assert.equal(
    computeNextRecurringFireAt(base, hourSec, false, baseMs + 3600 * 1000).toISOString(),
    "2026-01-01T02:00:00.000Z",
  );

  // forceNow uses now + interval
  assert.equal(
    computeNextRecurringFireAt(base, hourSec, true, baseMs + 123_000).toISOString(),
    new Date(baseMs + 123_000 + hourSec * 1000).toISOString(),
  );
});

test("startReminderScheduler skips overlapping ticks while previous tick is in flight", async () => {
  let queryCalls = 0;
  let releaseQuery!: () => void;
  const firstQueryGate = new Promise<void>((resolve) => {
    releaseQuery = resolve;
  });

  const ctx = {
    log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
  };

  const scheduler = startReminderScheduler(ctx as never, 15, undefined, {
    fetchDuePending: async () => {
      queryCalls += 1;
      if (queryCalls === 1) await firstQueryGate;
      return [];
    },
    getReminderRowById: async () => null,
    sendReminderHubMessage: async () => ({ delivered: true, via: "channel" }),
    applyDispatchResult: async () => ({ updated: 1, recurring: false, nextFireAt: null }),
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 65));
    assert.equal(queryCalls, 1);

    releaseQuery();
    await new Promise((resolve) => setTimeout(resolve, 45));
    assert.ok(queryCalls >= 2);
  } finally {
    await scheduler.stop();
  }
});

test("startReminderScheduler sends before updating DB, handles permanent failures, and backs off transient failures without blocking other rows", async () => {
  const rowPermSingle = makeReminderRow("rem-perm-single", "ch-deleted");
  const rowPermRecurring = makeReminderRow("rem-perm-rec", "ch-deleted", { interval_sec: 3600 });
  const rowTransient = makeReminderRow("rem-transient", "ch-flaky");
  const rowOk = makeReminderRow("rem-ok", "ch-ok");

  const rowsById = new Map<string, RemindersRow>([
    [rowPermSingle.id, rowPermSingle],
    [rowPermRecurring.id, rowPermRecurring],
    [rowTransient.id, rowTransient],
    [rowOk.id, rowOk],
  ]);

  const events: string[] = [];
  const cancelledIds: string[] = [];
  const skippedIds: string[] = [];
  const appliedIds: string[] = [];
  const excludeHistory: string[][] = [];
  const loggedErrors: unknown[][] = [];
  const loggedWarns: unknown[][] = [];

  let nowMs = Date.parse("2026-01-01T00:05:00.000Z");
  let ticks = 0;
  let secondTickDoneResolve!: () => void;
  const secondTickDone = new Promise<void>((resolve) => {
    secondTickDoneResolve = resolve;
  });

  const ctx = {
    log: {
      debug: () => undefined,
      info: () => undefined,
      warn: (...args: unknown[]) => {
        loggedWarns.push(args);
      },
      error: (...args: unknown[]) => {
        loggedErrors.push(args);
      },
    },
  };

  const timer = startReminderScheduler(ctx as never, 15, undefined, {
    now: () => nowMs,
    fetchDuePending: async (_ctx, _nowIso, _limit, excludeIds = []) => {
      ticks += 1;
      excludeHistory.push([...excludeIds]);
      if (ticks === 1) {
        return [rowPermSingle, rowPermRecurring, rowTransient, rowOk];
      }
      if (ticks === 2) {
        // Still within 1-minute backoff window; rowTransient must be excluded
        nowMs += 30_000;
        secondTickDoneResolve();
      }
      return [];
    },
    getReminderRowById: async (_ctx, id) => rowsById.get(id) ?? null,
    sendReminderHubMessage: async (_ctx, row) => {
      events.push(`send:${row.id}`);
      if (row.id === "rem-perm-single" || row.id === "rem-perm-rec") {
        return {
          delivered: false,
          channelError: Object.assign(new Error("Unknown Channel"), { code: 10_003, status: 404 }),
          dmError: Object.assign(new Error("Cannot send messages to this user"), { code: 50_007, status: 403 }),
          permanent: true,
        };
      }
      if (row.id === "rem-transient") {
        return {
          delivered: false,
          channelError: Object.assign(new Error("Service Unavailable"), { status: 503 }),
          dmError: Object.assign(new Error("Service Unavailable"), { status: 503 }),
          permanent: false,
        };
      }
      return { delivered: true, via: "channel" };
    },
    applyDispatchResult: async (_ctx, row) => {
      events.push(`apply:${row.id}`);
      if (row.id === "rem-perm-rec") {
        skippedIds.push(row.id);
        return { updated: 1, recurring: true, nextFireAt: "2026-01-01T01:00:00.000Z" };
      }
      appliedIds.push(row.id);
      return { updated: 1, recurring: false, nextFireAt: null };
    },
    cancelUndeliverableReminder: async (_ctx, row) => {
      cancelledIds.push(row.id);
      return 1;
    },
  });

  try {
    await secondTickDone;
    // Order for delivered row: send BEFORE apply
    assert.ok(events.indexOf("send:rem-ok") < events.indexOf("apply:rem-ok"));
    assert.deepEqual(appliedIds, ["rem-ok"]);
    // Single permanent failure is cancelled; recurring permanent failure is skipped (not cancelled)
    assert.deepEqual(cancelledIds, ["rem-perm-single"]);
    assert.deepEqual(skippedIds, ["rem-perm-rec"]);
    // Transient error does not touch DB and is excluded on next tick while in backoff
    assert.deepEqual(excludeHistory[0], []);
    assert.deepEqual(excludeHistory[1], ["rem-transient"]);
    assert.equal(loggedErrors.length, 1);
    assert.equal(loggedWarns.length, 2);
  } finally {
    await timer.stop();
    clearReminderRetryState(rowTransient.id);
    clearRecurringPermanentSkipWarned(rowPermRecurring.id);
  }
});

test("startReminderScheduler retries single reminders for 24h with capped backoff before cancelling, and skips recurring after 5 consecutive failures", async () => {
  const rowSingle = makeReminderRow("rem-24h-single", "ch-flaky");
  const rowRec = makeReminderRow("rem-5fail-rec", "ch-flaky", { interval_sec: 3600 });
  const rowsById = new Map<string, RemindersRow>([
    [rowSingle.id, rowSingle],
    [rowRec.id, rowRec],
  ]);

  let nowMs = Date.parse("2026-01-01T00:05:00.000Z");
  const cancelledIds: string[] = [];
  const skippedIds: string[] = [];
  const warns: unknown[][] = [];
  const singleBackoffs: number[] = [];
  let singleAttempts = 0;
  let recAttempts = 0;

  let doneResolve!: () => void;
  const done = new Promise<void>((resolve) => {
    doneResolve = resolve;
  });

  const ctx = {
    log: {
      debug: () => undefined,
      info: () => undefined,
      warn: (...args: unknown[]) => {
        warns.push(args);
        if (cancelledIds.length === 1 && skippedIds.length === 1) {
          doneResolve();
        }
      },
      error: (meta: unknown) => {
        const m = meta as { reminderId?: string; retryAfterMs?: number };
        if (m.reminderId === rowSingle.id && typeof m.retryAfterMs === "number") {
          singleBackoffs.push(m.retryAfterMs);
        }
      },
    },
  };

  const timer = startReminderScheduler(ctx as never, 10, undefined, {
    now: () => nowMs,
    fetchDuePending: async (_ctx, _nowIso, _limit, excludeIds = []) => {
      const excluded = new Set(excludeIds);
      const due = [...rowsById.values()].filter((r) => r.status === "pending" && !excluded.has(r.id));
      if (due.length === 0) {
        // Advance time to just past the earliest backoff (<= 30m, below 60m stale TTL)
        const state = getReminderRetryState(rowSingle.id) ?? getReminderRetryState(rowRec.id);
        nowMs = state ? state.nextRetryAtMs + 1_000 : nowMs + 31 * 60_000;
        return [];
      }
      return due;
    },
    getReminderRowById: async (_ctx, id) => rowsById.get(id) ?? null,
    sendReminderHubMessage: async (_ctx, row) => {
      if (row.id === rowSingle.id) singleAttempts += 1;
      if (row.id === rowRec.id) recAttempts += 1;
      return {
        delivered: false,
        channelError: new Error("temporary network error"),
        dmError: new Error("temporary network error"),
        permanent: false,
      };
    },
    applyDispatchResult: async (_ctx, row) => {
      skippedIds.push(row.id);
      row.status = "fired";
      return { updated: 1, recurring: true, nextFireAt: "2026-01-01T02:00:00.000Z" };
    },
    cancelUndeliverableReminder: async (_ctx, row) => {
      cancelledIds.push(row.id);
      row.status = "cancelled";
      return 1;
    },
  });

  try {
    await done;
    assert.ok(singleAttempts > 7);
    assert.equal(recAttempts, 5);
    assert.deepEqual(cancelledIds, ["rem-24h-single"]);
    assert.deepEqual(skippedIds, ["rem-5fail-rec"]);
    assert.equal(warns.length, 2);
    // Exponential backoff capped at 30m (1m, 2m, 4m, 8m, 16m, 30m, 30m)
    assert.deepEqual(singleBackoffs.slice(0, 7), [
      60_000,
      120_000,
      240_000,
      480_000,
      960_000,
      1_800_000,
      1_800_000,
    ]);
  } finally {
    await timer.stop();
    clearReminderRetryState(rowSingle.id);
    clearReminderRetryState(rowRec.id);
  }
});

test("startReminderScheduler queues pending DB updates on applyResult error without resending, and retries DB update on next tick", async () => {
  const row = makeReminderRow("rem-apply-retry", "ch-1");
  const nowMs = Date.parse("2026-01-01T00:05:00.000Z");
  let sendCount = 0;
  let applyAttempts = 0;
  let ticks = 0;
  const excludeHistory: string[][] = [];

  let doneResolve!: () => void;
  const done = new Promise<void>((resolve) => {
    doneResolve = resolve;
  });

  const ctx = {
    log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
  };

  const timer = startReminderScheduler(ctx as never, 10, undefined, {
    now: () => nowMs,
    fetchDuePending: async (_ctx, _nowIso, _limit, excludeIds = []) => {
      ticks += 1;
      excludeHistory.push([...excludeIds]);
      if (ticks === 1) return [row];
      if (ticks === 3) {
        doneResolve();
      }
      return excludeIds.includes(row.id) ? [] : [row];
    },
    getReminderRowById: async () => (row.status === "pending" ? row : null),
    sendReminderHubMessage: async () => {
      sendCount += 1;
      return { delivered: true, via: "channel" };
    },
    applyDispatchResult: async () => {
      applyAttempts += 1;
      if (applyAttempts <= 2) {
        throw new Error("transient DB error");
      }
      row.status = "fired";
      return { updated: 1, recurring: false, nextFireAt: null };
    },
  });

  try {
    await done;
    assert.equal(sendCount, 1);
    assert.equal(applyAttempts, 3);
    // Tick 2 still failed applyResult -> row.id must be excluded from fetchDuePending
    assert.ok(excludeHistory[1]?.includes(row.id));
    // Tick 3 succeeded applyResult -> pending state cleared
    assert.equal(hasPendingDispatchUpdate(row.id), false);
  } finally {
    await timer.stop();
    clearPendingDispatchUpdate(row.id);
  }
});

test("rem_manage_post records pending DB update on applyDispatch failure, prevents duplicate manual post, and scheduler completes DB update", async () => {
  const row = makeReminderRow("rem-manual-apply-fail", "ch-1", { interval_sec: 3600 });
  const sendNowMs = Date.parse("2026-01-01T00:05:00.000Z");
  const expectedNextFireAt = "2026-01-01T01:05:00.000Z";
  let sendCount = 0;
  const applyCalls: Array<{ forceNow: boolean; fixedNextFireAt?: string | null }> = [];
  const editReplies: unknown[] = [];

  const ctx = {
    log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
  };
  const makeInteraction = () => ({
    customId: `rem_manage_post:${row.id}`,
    guild: { id: "guild-1" },
    user: { id: "user-1" },
    deferUpdate: async () => undefined,
    editReply: async (payload: unknown) => {
      editReplies.push(payload);
    },
  });

  // First manual post: send succeeds, DB update fails
  await handleReminderHubButton(makeInteraction() as never, ctx as never, {
    now: () => sendNowMs,
    getReminderRowForAuthor: async () => row,
    sendReminderHubMessage: async () => {
      sendCount += 1;
      return { delivered: true, via: "channel" };
    },
    applyDispatchResult: async (_ctx, _r, forceNow, _db, fixedNextFireAt) => {
      applyCalls.push({ forceNow, fixedNextFireAt });
      throw new Error("db timeout");
    },
    getActiveForAuthor: async () => null,
    listActiveByType: async () => [],
  });

  assert.equal(sendCount, 1);
  assert.equal(hasPendingDispatchUpdate(row.id, row.fire_at), true);

  // Second manual post before DB update succeeds must not resend
  await handleReminderHubButton(makeInteraction() as never, ctx as never, {
    now: () => sendNowMs + 5 * 60_000,
    getReminderRowForAuthor: async () => row,
    sendReminderHubMessage: async () => {
      sendCount += 1;
      return { delivered: true, via: "channel" };
    },
    applyDispatchResult: async (_ctx, _r, forceNow, _db, fixedNextFireAt) => {
      applyCalls.push({ forceNow, fixedNextFireAt });
      return { updated: 1, recurring: true, nextFireAt: expectedNextFireAt };
    },
    getActiveForAuthor: async () => null,
    listActiveByType: async () => [],
  });

  assert.equal(sendCount, 1);
  assert.match(JSON.stringify(editReplies[1]), /すでに送信済み/);

  // Next scheduler tick runs 20 minutes later and retries the pending DB update using the fixed nextFireAt from send time
  let resolvedTick!: () => void;
  const tickDone = new Promise<void>((resolve) => {
    resolvedTick = resolve;
  });
  const timer = startReminderScheduler(ctx as never, 10, undefined, {
    now: () => sendNowMs + 20 * 60_000,
    fetchDuePending: async () => {
      resolvedTick();
      return [];
    },
    getReminderRowById: async () => null,
    sendReminderHubMessage: async () => {
      sendCount += 1;
      return { delivered: true, via: "channel" };
    },
    applyDispatchResult: async (_ctx, _r, forceNow, _db, fixedNextFireAt) => {
      applyCalls.push({ forceNow, fixedNextFireAt });
      return { updated: 1, recurring: true, nextFireAt: fixedNextFireAt ?? expectedNextFireAt };
    },
  });

  try {
    await tickDone;
    assert.equal(sendCount, 1);
    assert.deepEqual(applyCalls, [
      { forceNow: true, fixedNextFireAt: expectedNextFireAt },
      { forceNow: true, fixedNextFireAt: expectedNextFireAt },
    ]);
    assert.equal(hasPendingDispatchUpdate(row.id), false);
  } finally {
    await timer.stop();
    clearPendingDispatchUpdate(row.id);
  }
});

test("startReminderScheduler prunes stale retryState entries at tick start", async () => {
  const staleId = "rem-stale-retry";
  const freshId = "rem-fresh-retry";
  const baseMs = Date.parse("2026-01-01T00:00:00.000Z");
  setReminderRetryState(staleId, { failures: 3, firstFailedAtMs: baseMs - 60_000, nextRetryAtMs: baseMs });
  setReminderRetryState(freshId, { failures: 2, firstFailedAtMs: baseMs, nextRetryAtMs: baseMs + 30 * 60_000 });

  let tickDoneResolve!: () => void;
  const tickDone = new Promise<void>((resolve) => {
    tickDoneResolve = resolve;
  });

  const ctx = {
    log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
  };

  // 60 minutes after staleId.nextRetryAtMs -> staleId must be pruned, freshId kept
  const timer = startReminderScheduler(ctx as never, 10, undefined, {
    now: () => baseMs + 60 * 60_000,
    fetchDuePending: async () => {
      tickDoneResolve();
      return [];
    },
    getReminderRowById: async () => null,
    sendReminderHubMessage: async () => ({ delivered: true, via: "channel" }),
    applyDispatchResult: async () => ({ updated: 1, recurring: false, nextFireAt: null }),
  });

  try {
    await tickDone;
    assert.equal(getReminderRetryState(staleId), undefined);
    assert.ok(getReminderRetryState(freshId));
  } finally {
    await timer.stop();
    clearReminderRetryState(staleId);
    clearReminderRetryState(freshId);
  }
});

test("rem_manage_post and scheduler do not double-post when competing for the same row via dispatch lock", async () => {
  const row = makeReminderRow("rem-race", "ch-1");
  let status: string = "pending";
  let sendCount = 0;

  let tickSentOrSkipped!: () => void;
  const tickDone = new Promise<void>((resolve) => {
    tickSentOrSkipped = resolve;
  });

  const ctx = {
    log: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  };

  const editReplies: unknown[] = [];
  const interaction = {
    customId: "rem_manage_post:rem-race",
    guild: { id: "guild-1" },
    user: { id: "user-1" },
    deferUpdate: async () => undefined,
    editReply: async (payload: unknown) => {
      editReplies.push(payload);
    },
  };

  const getCurrentRow = async () => (status === "pending" ? { ...row, status } : null);
  const markFired = async () => {
    status = "fired";
    return { updated: 1, recurring: false, nextFireAt: null };
  };

  let fetched = false;
  const timer = startReminderScheduler(ctx as never, 10, undefined, {
    now: () => Date.parse("2026-01-01T00:05:00.000Z"),
    fetchDuePending: async () => {
      if (fetched) return [];
      fetched = true;
      return [{ ...row }];
    },
    getReminderRowById: async () => {
      const current = await getCurrentRow();
      tickSentOrSkipped();
      return current;
    },
    sendReminderHubMessage: async () => {
      sendCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { delivered: true, via: "channel" };
    },
    applyDispatchResult: markFired,
  });

  try {
    await Promise.all([
      handleReminderHubButton(interaction as never, ctx as never, {
        getReminderRowForAuthor: getCurrentRow,
        applyDispatchResult: markFired,
        sendReminderHubMessage: async () => {
          sendCount += 1;
          await new Promise((resolve) => setTimeout(resolve, 20));
          return { delivered: true, via: "channel" };
        },
        getActiveForAuthor: async () => null,
        listActiveByType: async () => [],
      }),
      tickDone,
    ]);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(sendCount, 1);
    assert.equal(editReplies.length, 1);
  } finally {
    await timer.stop();
  }
});

test("sendReminderHubMessage falls back to DM on channel failure and marks permanent for permanent error combinations", async () => {
  const row = makeReminderRow("rem-send", "ch-1");

  // 1. Channel fails (50013) -> DM succeeds
  let dmSent = false;
  const ctxDmOk = {
    client: {
      guilds: { fetch: async () => ({ id: "guild-1" }) },
      channels: {
        fetch: async () => ({
          guildId: "guild-1",
          isTextBased: () => true,
          isSendable: () => true,
          send: async () => {
            throw Object.assign(new Error("Missing Permissions"), { code: 50_013, status: 403 });
          },
        }),
      },
      users: {
        fetch: async () => ({
          send: async () => {
            dmSent = true;
          },
        }),
      },
    },
  };
  const dmOkResult = await sendReminderHubMessage(ctxDmOk as never, row);
  assert.deepEqual(dmOkResult, { delivered: true, via: "dm" });
  assert.equal(dmSent, true);

  // 2. Channel fails (10003) AND DM fails (50007) -> permanent: true
  const ctxBothPerm = {
    client: {
      guilds: { fetch: async () => ({ id: "guild-1" }) },
      channels: {
        fetch: async () => {
          throw Object.assign(new Error("Unknown Channel"), { code: 10_003, status: 404 });
        },
      },
      users: {
        fetch: async () => ({
          send: async () => {
            throw Object.assign(new Error("Cannot send messages to this user"), { code: 50_007, status: 403 });
          },
        }),
      },
    },
  };
  const bothPermResult = await sendReminderHubMessage(ctxBothPerm as never, row);
  assert.equal(bothPermResult.delivered, false);
  assert.equal(bothPermResult.permanent, true);

  // 3. Channel fails (50001 Missing Access) AND DM fails (50007) -> permanent: false (transient permission loss)
  const ctxAccessAndDmPerm = {
    client: {
      guilds: { fetch: async () => ({ id: "guild-1" }) },
      channels: {
        fetch: async () => {
          throw Object.assign(new Error("Missing Access"), { code: 50_001, status: 403 });
        },
      },
      users: {
        fetch: async () => ({
          send: async () => {
            throw Object.assign(new Error("Cannot send messages to this user"), { code: 50_007, status: 403 });
          },
        }),
      },
    },
  };
  const accessResult = await sendReminderHubMessage(ctxAccessAndDmPerm as never, row);
  assert.equal(accessResult.delivered, false);
  assert.equal(accessResult.permanent, false);

  // 4. Channel fails (50013 Missing Permissions) AND DM fails (50007) -> permanent: false (transient permission loss)
  const ctxPermAndDmPerm = {
    client: {
      guilds: { fetch: async () => ({ id: "guild-1" }) },
      channels: {
        fetch: async () => {
          throw Object.assign(new Error("Missing Permissions"), { code: 50_013, status: 403 });
        },
      },
      users: {
        fetch: async () => ({
          send: async () => {
            throw Object.assign(new Error("Cannot send messages to this user"), { code: 50_007, status: 403 });
          },
        }),
      },
    },
  };
  const permResult = await sendReminderHubMessage(ctxPermAndDmPerm as never, row);
  assert.equal(permResult.delivered, false);
  assert.equal(permResult.permanent, false);

  // 5. Structural channel error (guild not found) AND DM fails (50007) -> permanent: true
  const ctxGuildMissing = {
    client: {
      guilds: { fetch: async () => null },
      channels: { fetch: async () => null },
      users: {
        fetch: async () => ({
          send: async () => {
            throw Object.assign(new Error("Cannot send messages to this user"), { code: 50_007, status: 403 });
          },
        }),
      },
    },
  };
  const guildMissingResult = await sendReminderHubMessage(ctxGuildMissing as never, row);
  assert.equal(guildMissingResult.delivered, false);
  assert.equal(guildMissingResult.permanent, true);
  assert.ok(guildMissingResult.channelError instanceof StructuralReminderDeliveryError);
  assert.equal(guildMissingResult.channelError.code, "GUILD_NOT_FOUND");

  // 6. Structural channel error (channel not text-sendable) AND DM fails (50007) -> permanent: true
  const ctxChannelNotSendable = {
    client: {
      guilds: { fetch: async () => ({ id: "guild-1" }) },
      channels: {
        fetch: async () => ({
          isTextBased: () => false,
          isSendable: () => false,
        }),
      },
      users: {
        fetch: async () => ({
          send: async () => {
            throw Object.assign(new Error("Cannot send messages to this user"), { code: 50_007, status: 403 });
          },
        }),
      },
    },
  };
  const notSendableResult = await sendReminderHubMessage(ctxChannelNotSendable as never, row);
  assert.equal(notSendableResult.delivered, false);
  assert.equal(notSendableResult.permanent, true);
  assert.ok(notSendableResult.channelError instanceof StructuralReminderDeliveryError);
  assert.equal(notSendableResult.channelError.code, "CHANNEL_NOT_SENDABLE");

  // 7. Structural channel error AND DM fails (503 transient) -> permanent: false
  const ctxStructuralAndTransient = {
    client: {
      guilds: { fetch: async () => ({ id: "guild-1" }) },
      channels: {
        fetch: async () => ({
          isTextBased: () => false,
          isSendable: () => false,
        }),
      },
      users: {
        fetch: async () => ({
          send: async () => {
            throw Object.assign(new Error("Service Unavailable"), { status: 503 });
          },
        }),
      },
    },
  };
  const transientResult = await sendReminderHubMessage(ctxStructuralAndTransient as never, row);
  assert.equal(transientResult.delivered, false);
  assert.equal(transientResult.permanent, false);
});

test("rem_manage_post leaves DB unchanged and shows failure notice when send fails for recurring reminder", async () => {
  const row = makeReminderRow("rem-manual-fail", "ch-1", { interval_sec: 3600 });
  let applyCalls = 0;
  const editReplies: unknown[] = [];

  const ctx = {
    log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
  };
  const interaction = {
    customId: "rem_manage_post:rem-manual-fail",
    guild: { id: "guild-1" },
    user: { id: "user-1" },
    deferUpdate: async () => undefined,
    editReply: async (payload: unknown) => {
      editReplies.push(payload);
    },
  };

  await handleReminderHubButton(interaction as never, ctx as never, {
    getReminderRowForAuthor: async () => row,
    applyDispatchResult: async () => {
      applyCalls += 1;
      return { updated: 1, recurring: true, nextFireAt: "2026-01-01T01:00:00.000Z" };
    },
    sendReminderHubMessage: async () => ({
      delivered: false,
      channelError: Object.assign(new Error("Missing Permissions"), { code: 50_013, status: 403 }),
      dmError: Object.assign(new Error("Cannot send messages to this user"), { code: 50_007, status: 403 }),
      permanent: true,
    }),
    getActiveForAuthor: async () => null,
    listActiveByType: async () => [],
  });

  assert.equal(applyCalls, 0);
  assert.equal(editReplies.length, 1);
  assert.match(JSON.stringify(editReplies[0]), /送信に失敗しました/);
  assert.doesNotMatch(JSON.stringify(editReplies[0]), /即時投稿しました/);
});

test("applyDispatchResult and cancelUndeliverableReminder guard updates with status='pending' and pre-send fire_at", async () => {
  type RowState = { id: string; status: string; fire_at: string };
  const makeFakeDbCtx = (state: RowState) => {
    const db = {
      updateTable: () => {
        let patch: Partial<RowState> = {};
        const conditions: Array<[keyof RowState, string]> = [];
        const builder = {
          set: (values: Partial<RowState>) => {
            patch = values;
            return builder;
          },
          where: (col: keyof RowState, _op: string, val: string) => {
            conditions.push([col, val]);
            return builder;
          },
          executeTakeFirst: async () => {
            const matched = conditions.every(([col, val]) => state[col] === val);
            if (!matched) return { numUpdatedRows: 0n };
            Object.assign(state, patch);
            return { numUpdatedRows: 1n };
          },
        };
        return builder;
      },
    };
    return { db, reminderDb: db };
  };

  // Single reminder edited/cancelled while send was in flight -> applyDispatchResult does not overwrite
  const singleRow = makeReminderRow("rem-single-guard");
  const singleState: RowState = { id: singleRow.id, status: "cancelled", fire_at: singleRow.fire_at };
  const singleCtx = makeFakeDbCtx(singleState);
  const cancelledRes = await applyDispatchResult(singleCtx as never, singleRow, false, singleCtx.db as never);
  assert.equal(cancelledRes.updated, 0);
  assert.equal(singleState.status, "cancelled");

  // Pending single reminder with matching fire_at -> cancelUndeliverableReminder succeeds
  singleState.status = "pending";
  assert.equal(await cancelUndeliverableReminder(singleCtx as never, singleRow, singleCtx.db as never), 1);
  assert.equal(singleState.status, "cancelled");

  // Recurring reminder: user edits fire_at while send is in flight -> applyDispatchResult does not overwrite
  const recRow = makeReminderRow("rem-rec-guard", "ch-1", { interval_sec: 3600 });
  const userEditedFireAt = "2026-02-01T12:00:00.000Z";
  const recState: RowState = { id: recRow.id, status: "pending", fire_at: userEditedFireAt };
  const recCtx = makeFakeDbCtx(recState);
  const recRes = await applyDispatchResult(recCtx as never, recRow, false, recCtx.db as never);
  assert.equal(recRes.updated, 0);
  assert.equal(recState.fire_at, userEditedFireAt);

  // Matching pending recurring reminder updates fire_at
  recState.fire_at = recRow.fire_at;
  const recOk = await applyDispatchResult(recCtx as never, recRow, false, recCtx.db as never);
  assert.equal(recOk.updated, 1);
  assert.equal(recOk.recurring, true);
  assert.ok(recOk.nextFireAt);
  assert.equal(recState.fire_at, recOk.nextFireAt);
});

test("startReminderScheduler retains retry state and queues pending DB update when skip or cancel DB write fails", async () => {
  const recRow = makeReminderRow("rem-skip-db-fail", "ch-1", { interval_sec: 3600 });
  const singleRow = makeReminderRow("rem-cancel-db-fail", "ch-1");
  const nowMs = Date.parse("2026-01-01T00:05:00.000Z");

  // Pre-seed retry state so recRow hits 5th failure immediately and singleRow has prior failure history
  setReminderRetryState(recRow.id, { failures: 4, firstFailedAtMs: nowMs - 60_000, nextRetryAtMs: nowMs - 1_000 });
  setReminderRetryState(singleRow.id, { failures: 2, firstFailedAtMs: nowMs - 60_000, nextRetryAtMs: nowMs - 1_000 });

  let recSendCount = 0;
  let singleSendCount = 0;
  let applyAttempts = 0;
  let cancelAttempts = 0;
  let ticks = 0;
  let retryStatePreservedAfterFail = false;

  let doneResolve!: () => void;
  const done = new Promise<void>((resolve) => {
    doneResolve = resolve;
  });

  const ctx = {
    log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
  };

  const timer = startReminderScheduler(ctx as never, 10, undefined, {
    now: () => nowMs,
    fetchDuePending: async (_ctx, _nowIso, _limit, excludeIds = []) => {
      ticks += 1;
      if (ticks === 1) return [recRow, singleRow];
      if (ticks === 2) {
        retryStatePreservedAfterFail =
          getReminderRetryState(recRow.id) === undefined
          && getReminderRetryState(singleRow.id) === undefined
          && !hasPendingDispatchUpdate(recRow.id)
          && !hasPendingDispatchUpdate(singleRow.id);
        doneResolve();
      }
      return [recRow, singleRow].filter((r) => !excludeIds.includes(r.id) && r.status === "pending");
    },
    getReminderRowById: async (_ctx, id) => {
      if (id === recRow.id) return recRow;
      if (id === singleRow.id) return singleRow;
      return null;
    },
    sendReminderHubMessage: async (_ctx, row) => {
      if (row.id === recRow.id) {
        recSendCount += 1;
        return { delivered: false, channelError: new Error("net"), dmError: new Error("net"), permanent: false };
      }
      singleSendCount += 1;
      return {
        delivered: false,
        channelError: Object.assign(new Error("Unknown Channel"), { code: 10_003 }),
        dmError: Object.assign(new Error("Cannot send"), { code: 50_007 }),
        permanent: true,
      };
    },
    applyDispatchResult: async () => {
      applyAttempts += 1;
      if (applyAttempts === 1) {
        // Retry state must still exist when DB write fails
        assert.ok(getReminderRetryState(recRow.id));
        throw new Error("db error on skip");
      }
      recRow.fire_at = "2026-01-01T01:00:00.000Z";
      return { updated: 1, recurring: true, nextFireAt: recRow.fire_at };
    },
    cancelUndeliverableReminder: async () => {
      cancelAttempts += 1;
      if (cancelAttempts === 1) {
        assert.ok(getReminderRetryState(singleRow.id));
        throw new Error("db error on cancel");
      }
      singleRow.status = "cancelled";
      return 1;
    },
  });

  try {
    await done;
    assert.equal(recSendCount, 1);
    assert.equal(singleSendCount, 1);
    assert.equal(applyAttempts, 2);
    assert.equal(cancelAttempts, 2);
    assert.equal(retryStatePreservedAfterFail, true);
  } finally {
    await timer.stop();
    clearReminderRetryState(recRow.id);
    clearReminderRetryState(singleRow.id);
    clearPendingDispatchUpdate(recRow.id);
    clearPendingDispatchUpdate(singleRow.id);
  }
});

test("startReminderScheduler does not count or log delivered/skipped when conditional DB update affects 0 rows", async () => {
  const rowDelivered = makeReminderRow("rem-0row-delivered", "ch-1");
  const rowSkipped = makeReminderRow("rem-0row-skipped", "ch-1", { interval_sec: 3600 });
  const nowMs = Date.parse("2026-01-01T00:05:00.000Z");

  // Pre-seed retry state so rowSkipped hits 5th transient failure and triggers skip path
  setReminderRetryState(rowSkipped.id, { failures: 4, firstFailedAtMs: nowMs - 60_000, nextRetryAtMs: nowMs - 1_000 });

  const infos: unknown[][] = [];
  const warns: unknown[][] = [];
  let ticks = 0;
  let doneResolve!: () => void;
  const done = new Promise<void>((resolve) => {
    doneResolve = resolve;
  });

  const ctx = {
    log: {
      debug: () => undefined,
      info: (...args: unknown[]) => { infos.push(args); },
      warn: (...args: unknown[]) => { warns.push(args); },
      error: () => undefined,
    },
  };

  const timer = startReminderScheduler(ctx as never, 10, undefined, {
    now: () => nowMs,
    fetchDuePending: async () => {
      ticks += 1;
      if (ticks === 1) return [rowDelivered, rowSkipped];
      if (ticks === 2) doneResolve();
      return [];
    },
    getReminderRowById: async (_ctx, id) => {
      if (id === rowDelivered.id) return rowDelivered;
      if (id === rowSkipped.id) return rowSkipped;
      return null;
    },
    sendReminderHubMessage: async (_ctx, row) => {
      if (row.id === rowDelivered.id) return { delivered: true, via: "channel" };
      return {
        delivered: false,
        channelError: new Error("temporary network error"),
        dmError: new Error("temporary network error"),
        permanent: false,
      };
    },
    applyDispatchResult: async (_ctx, row) => ({
      updated: 0,
      recurring: row.id === rowSkipped.id,
      nextFireAt: row.id === rowSkipped.id ? "2026-01-01T01:00:00.000Z" : null,
    }),
  });

  try {
    await done;
    assert.equal(warns.length, 0);
    // Must not log "reminders delivered", and must log info for both 0-row outcomes
    assert.equal(infos.some((args) => args[1] === "reminders delivered"), false);
    assert.equal(
      infos.some((args) => String(args[1]).includes("not updated because row changed")),
      true,
    );
    assert.equal(
      infos.some((args) => String(args[1]).includes("skip did not update DB")),
      true,
    );
  } finally {
    await timer.stop();
    clearReminderRetryState(rowDelivered.id);
    clearReminderRetryState(rowSkipped.id);
  }
});

test("stopReminderScheduler logs warn with count and ids when pending DB updates remain", async () => {
  const row = makeReminderRow("rem-shutdown-pending", "ch-1");
  const warns: unknown[][] = [];
  let cleared = false;
  const fakeTimer = {} as NodeJS.Timeout;

  try {
    await stopReminderScheduler(fakeTimer, { warn: (...args: unknown[]) => { warns.push(args); } }, () => { cleared = true; });
    assert.equal(cleared, true);
    assert.equal(warns.length, 0);

    recordPendingDispatchUpdate(row, false, "delivered");
    await stopReminderScheduler(fakeTimer, { warn: (...args: unknown[]) => { warns.push(args); } }, () => undefined);
    assert.equal(warns.length, 1);
    assert.deepEqual(warns[0]?.[0], { count: 1, reminderIds: [row.id] });
  } finally {
    clearPendingDispatchUpdate(row.id);
  }
});

test("startReminderScheduler stop waits for active tick, skips remaining rows, and logs pending DB updates after waiting", async () => {
  const row1 = makeReminderRow("rem-stop-1", "ch-1");
  const row2 = makeReminderRow("rem-stop-2", "ch-1");
  const sentIds: string[] = [];
  const events: string[] = [];
  const warns: unknown[][] = [];

  let firstSendStartedResolve!: () => void;
  const firstSendStarted = new Promise<void>((resolve) => {
    firstSendStartedResolve = resolve;
  });
  let releaseFirstSend!: () => void;
  const firstSendGate = new Promise<void>((resolve) => {
    releaseFirstSend = resolve;
  });

  const ctx = {
    log: {
      debug: () => undefined,
      info: () => undefined,
      warn: (...args: unknown[]) => {
        events.push("warn");
        warns.push(args);
      },
      error: () => undefined,
    },
  };

  const scheduler = startReminderScheduler(ctx as never, 10, undefined, {
    now: () => Date.parse("2026-01-01T00:05:00.000Z"),
    fetchDuePending: async () => [row1, row2],
    getReminderRowById: async (_ctx, id) => (id === row1.id ? row1 : id === row2.id ? row2 : null),
    sendReminderHubMessage: async (_ctx, row) => {
      sentIds.push(row.id);
      if (row.id === row1.id) {
        firstSendStartedResolve();
        await firstSendGate;
      }
      return { delivered: true, via: "channel" };
    },
    applyDispatchResult: async () => {
      events.push("apply_fail");
      throw new Error("db error during shutdown");
    },
  });

  try {
    await firstSendStarted;
    let stopResolved = false;
    const stopPromise = scheduler.stop(5_000).then(() => {
      stopResolved = true;
      events.push("stop_resolved");
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(stopResolved, false);

    releaseFirstSend();
    await stopPromise;

    assert.deepEqual(sentIds, [row1.id]);
    assert.deepEqual(events, ["apply_fail", "warn", "stop_resolved"]);
    assert.equal(warns.length, 1);
    assert.deepEqual(warns[0]?.[0], { count: 1, reminderIds: [row1.id] });
  } finally {
    clearPendingDispatchUpdate(row1.id);
    clearPendingDispatchUpdate(row2.id);
  }
});

test("startReminderScheduler stop warns and proceeds when active tick exceeds timeout", async () => {
  const row = makeReminderRow("rem-stop-timeout", "ch-1");
  const warns: unknown[][] = [];

  let sendStartedResolve!: () => void;
  const sendStarted = new Promise<void>((resolve) => {
    sendStartedResolve = resolve;
  });
  let releaseSend!: () => void;
  const sendGate = new Promise<void>((resolve) => {
    releaseSend = resolve;
  });

  const ctx = {
    log: {
      debug: () => undefined,
      info: () => undefined,
      warn: (...args: unknown[]) => {
        warns.push(args);
      },
      error: () => undefined,
    },
  };

  const scheduler = startReminderScheduler(ctx as never, 10, undefined, {
    now: () => Date.parse("2026-01-01T00:05:00.000Z"),
    fetchDuePending: async () => [row],
    getReminderRowById: async () => row,
    sendReminderHubMessage: async () => {
      sendStartedResolve();
      await sendGate;
      return { delivered: true, via: "channel" };
    },
    applyDispatchResult: async () => ({ updated: 1, recurring: false, nextFireAt: null }),
  });

  try {
    await sendStarted;
    await scheduler.stop(30);
    assert.equal(warns.length, 1);
    assert.deepEqual(warns[0]?.[0], { timeoutMs: 30 });
    assert.match(String(warns[0]?.[1]), /timed out/);
    assert.match(String(warns[0]?.[1]), /after DB closes/);
    assert.match(String(warns[0]?.[1]), /duplicate delivery may occur after restart/);
  } finally {
    releaseSend();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
});

test("sendReminderHubMessage skips DM fallback on transient channel errors (5xx, 429, AbortError, network) and allows retry", async () => {
  const row = makeReminderRow("rem-no-dm-transient", "ch-1");
  const transientErrors: unknown[] = [
    Object.assign(new Error("Service Unavailable"), { status: 503 }),
    Object.assign(new Error("Too Many Requests"), { status: 429 }),
    Object.assign(new Error("The operation was aborted"), { name: "AbortError" }),
    new Error("ECONNRESET"),
  ];

  for (const err of transientErrors) {
    let dmFetchCalled = false;
    const ctx = {
      client: {
        guilds: { fetch: async () => ({ id: "guild-1" }) },
        channels: {
          fetch: async () => ({
            guildId: "guild-1",
            isTextBased: () => true,
            isSendable: () => true,
            send: async () => {
              throw err;
            },
          }),
        },
        users: {
          fetch: async () => {
            dmFetchCalled = true;
            return { send: async () => undefined };
          },
        },
      },
    };
    const result = await sendReminderHubMessage(ctx as never, row);
    assert.equal(result.delivered, false);
    assert.equal(result.permanent, false);
    assert.equal(result.channelError, err);
    assert.equal(result.dmError, undefined);
    assert.equal(dmFetchCalled, false);
  }

  // 10004 Unknown Guild still falls back to DM
  let dmSentForUnknownGuild = false;
  const ctxUnknownGuild = {
    client: {
      guilds: {
        fetch: async () => {
          throw Object.assign(new Error("Unknown Guild"), { code: 10_004, status: 404 });
        },
      },
      channels: { fetch: async () => null },
      users: {
        fetch: async () => ({
          send: async () => {
            dmSentForUnknownGuild = true;
          },
        }),
      },
    },
  };
  const unknownGuildRes = await sendReminderHubMessage(ctxUnknownGuild as never, row);
  assert.deepEqual(unknownGuildRes, { delivered: true, via: "dm" });
  assert.equal(dmSentForUnknownGuild, true);
});

test("isRecurringReminder and applyDispatchResult treat negative, zero, non-finite, and non-numeric interval_sec as single reminder", async () => {
  const makeRowWithRawRecurrence = (id: string, recurrence: unknown): RemindersRow => ({
    id,
    guild_id: "guild-1",
    channel_id: "ch-1",
    author_id: "user-1",
    body: `body-${id}`,
    fire_at: "2026-01-01T00:00:00.000Z",
    status: "pending",
    data: { ev_type: "reminder", title: `title-${id}`, recurrence } as never,
    created_at: new Date("2026-01-01T00:00:00.000Z"),
  });

  assert.equal(isRecurringReminder(makeRowWithRawRecurrence("r-pos", { interval_sec: 3600 })), true);
  assert.equal(isRecurringReminder(makeRowWithRawRecurrence("r-str-pos", { interval_sec: "600" })), true);
  assert.equal(isRecurringReminder(makeRowWithRawRecurrence("r-null", null)), false);
  assert.equal(isRecurringReminder(makeRowWithRawRecurrence("r-zero", { interval_sec: 0 })), false);
  assert.equal(isRecurringReminder(makeRowWithRawRecurrence("r-neg", { interval_sec: -60 })), false);
  assert.equal(isRecurringReminder(makeRowWithRawRecurrence("r-nan", { interval_sec: Number.NaN })), false);
  assert.equal(isRecurringReminder(makeRowWithRawRecurrence("r-inf", { interval_sec: Number.POSITIVE_INFINITY })), false);
  assert.equal(isRecurringReminder(makeRowWithRawRecurrence("r-nonnum", { interval_sec: "abc" })), false);

  // Verify applyDispatchResult marks invalid recurrence rows as fired (single reminder)
  for (const invalidRow of [
    makeRowWithRawRecurrence("r-apply-neg", { interval_sec: -30 }),
    makeRowWithRawRecurrence("r-apply-nonnum", { interval_sec: "not-a-number" }),
  ]) {
    let patched: Record<string, unknown> | undefined;
    const fakeDb = {
      updateTable: () => {
        const builder = {
          set: (values: Record<string, unknown>) => {
            patched = values;
            return builder;
          },
          where: () => builder,
          executeTakeFirst: async () => ({ numUpdatedRows: 1n }),
        };
        return builder;
      },
    };
    const res = await applyDispatchResult({} as never, invalidRow, false, fakeDb as never);
    assert.equal(res.recurring, false);
    assert.equal(res.nextFireAt, null);
    assert.deepEqual(patched, { status: "fired" });
  }
});

test("startReminderScheduler applies 24h retry window for 1d-old single reminders and cancels 8d-old single reminders on 5th consecutive failure", async () => {
  // 1. Single reminder 1 day (25h) past fire_at:
  //    5+ consecutive failures within 24h from firstFailedAtMs must NOT cancel; cancels only after 24h from firstFailedAtMs
  {
    const row = makeReminderRow("rem-25h-downtime", "ch-flaky", null, "2026-01-01T00:00:00.000Z");
    clearReminderRetryState(row.id);

    let nowMs = Date.parse("2026-01-02T01:00:00.000Z");
    const firstNowMs = nowMs;
    const cancelledIds: string[] = [];
    let sendAttempts = 0;
    let sawFifthFailureWithoutCancel = false;
    let doneResolve!: () => void;
    const done = new Promise<void>((resolve) => {
      doneResolve = resolve;
    });

    const ctx = {
      log: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => {
          doneResolve();
        },
        error: () => undefined,
      },
    };

    const timer = startReminderScheduler(ctx as never, 10, undefined, {
      now: () => nowMs,
      fetchDuePending: async (_ctx, _nowIso, _limit, excludeIds = []) => {
        if (row.status !== "pending") return [];
        if (excludeIds.includes(row.id)) {
          const state = getReminderRetryState(row.id);
          assert.ok(state);
          assert.equal(state.firstFailedAtMs, firstNowMs);
          if (state.failures === 5) {
            assert.deepEqual(cancelledIds, []);
            sawFifthFailureWithoutCancel = true;
          }
          nowMs = state.nextRetryAtMs + 1_000;
          return [];
        }
        return [row];
      },
      getReminderRowById: async () => row,
      sendReminderHubMessage: async () => {
        sendAttempts += 1;
        return {
          delivered: false,
          channelError: Object.assign(new Error("Service Unavailable"), { status: 503 }),
          dmError: undefined,
          permanent: false,
        };
      },
      cancelUndeliverableReminder: async (_ctx, r) => {
        cancelledIds.push(r.id);
        row.status = "cancelled";
        return 1;
      },
    });

    try {
      await done;
      assert.equal(sawFifthFailureWithoutCancel, true);
      assert.ok(sendAttempts > 5);
      assert.ok(nowMs - firstNowMs > 24 * 60 * 60_000);
      assert.deepEqual(cancelledIds, [row.id]);
      assert.equal(getReminderRetryState(row.id), undefined);
    } finally {
      await timer.stop();
      clearReminderRetryState(row.id);
    }
  }

  // 2. Single reminder 8 days past fire_at starting with empty retry state:
  //    1st..4th transient failures back off without cancelling; 5th failure cancels even within 24h of firstFailedAtMs
  {
    const row = makeReminderRow("rem-fire-at-8d", "ch-flaky", null, "2026-01-01T00:00:00.000Z");
    clearReminderRetryState(row.id);

    let nowMs = Date.parse("2026-01-09T00:00:00.000Z");
    const firstNowMs = nowMs;
    const cancelledIds: string[] = [];
    const warns: unknown[][] = [];
    const observedFailureCounts: number[] = [];
    let sendAttempts = 0;
    let doneResolve!: () => void;
    const done = new Promise<void>((resolve) => {
      doneResolve = resolve;
    });

    const ctx = {
      log: {
        debug: () => undefined,
        info: () => undefined,
        warn: (...args: unknown[]) => {
          warns.push(args);
          doneResolve();
        },
        error: () => undefined,
      },
    };

    const timer = startReminderScheduler(ctx as never, 10, undefined, {
      now: () => nowMs,
      fetchDuePending: async (_ctx, _nowIso, _limit, excludeIds = []) => {
        if (row.status !== "pending") return [];
        if (excludeIds.includes(row.id)) {
          const state = getReminderRetryState(row.id);
          assert.ok(state);
          assert.equal(state.firstFailedAtMs, firstNowMs);
          assert.deepEqual(cancelledIds, []);
          observedFailureCounts.push(state.failures);
          nowMs = state.nextRetryAtMs + 1_000;
          return [];
        }
        return [row];
      },
      getReminderRowById: async () => row,
      sendReminderHubMessage: async () => {
        sendAttempts += 1;
        return {
          delivered: false,
          channelError: new Error("temporary network error"),
          dmError: new Error("temporary network error"),
          permanent: false,
        };
      },
      cancelUndeliverableReminder: async (_ctx, r) => {
        cancelledIds.push(r.id);
        row.status = "cancelled";
        return 1;
      },
    });

    try {
      await done;
      assert.deepEqual(observedFailureCounts, [1, 2, 3, 4]);
      assert.equal(sendAttempts, 5);
      assert.ok(nowMs - firstNowMs < 24 * 60 * 60_000);
      assert.deepEqual(cancelledIds, [row.id]);
      assert.equal(getReminderRetryState(row.id), undefined);
      assert.equal(warns.length, 1);
    } finally {
      await timer.stop();
      clearReminderRetryState(row.id);
    }
  }
});

test("startReminderScheduler does not call sendReminder if stop() is called before send, and marks pending DB warn as provisional on timeout", async () => {
  const row = makeReminderRow("rem-stop-before-send", "ch-1");
  const pendingRow = makeReminderRow("rem-stop-provisional", "ch-1");
  let sendCalls = 0;
  const warns: unknown[][] = [];

  let reloadStartedResolve!: () => void;
  const reloadStarted = new Promise<void>((resolve) => {
    reloadStartedResolve = resolve;
  });
  let releaseReload!: () => void;
  const reloadGate = new Promise<void>((resolve) => {
    releaseReload = resolve;
  });

  const ctx = {
    log: {
      debug: () => undefined,
      info: () => undefined,
      warn: (...args: unknown[]) => {
        warns.push(args);
      },
      error: () => undefined,
    },
  };

  const scheduler = startReminderScheduler(ctx as never, 10, undefined, {
    now: () => Date.parse("2026-01-01T00:05:00.000Z"),
    fetchDuePending: async () => [row],
    getReminderRowById: async () => {
      reloadStartedResolve();
      await reloadGate;
      return row;
    },
    sendReminderHubMessage: async () => {
      sendCalls += 1;
      return { delivered: true, via: "channel" };
    },
    applyDispatchResult: async () => ({ updated: 1, recurring: false, nextFireAt: null }),
  });

  try {
    await reloadStarted;
    recordPendingDispatchUpdate(pendingRow, false, "delivered", null);
    await scheduler.stop(25);

    // Timeout warn + provisional pending DB updates warn
    assert.equal(warns.length, 2);
    assert.match(String(warns[0]?.[1]), /timed out/);
    assert.deepEqual(warns[1]?.[0], {
      count: 1,
      reminderIds: [pendingRow.id],
      provisional: true,
    });
    assert.match(String(warns[1]?.[1]), /provisional/);

    // Even after reload finishes, sendReminder must NOT be called because stopping is true
    releaseReload();
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(sendCalls, 0);
  } finally {
    releaseReload();
    clearPendingDispatchUpdate(pendingRow.id);
  }
});

test("startReminderScheduler preserves future saved nextFireAt on retry, and recomputes when saved nextFireAt is in the past after long DB outage", async () => {
  // 1. Short DB outage: saved nextFireAt (01:00) is still in the future at 00:25 -> preserved
  {
    const row = makeReminderRow("rem-sched-fixed-next-future", "ch-1", { interval_sec: 3600 }, "2026-01-01T00:00:00.000Z");
    let nowMs = Date.parse("2026-01-01T00:05:00.000Z");
    const expectedNextFireAt = "2026-01-01T01:00:00.000Z";
    const applyCalls: Array<{ fixedNextFireAt?: string | null }> = [];
    let ticks = 0;

    let doneResolve!: () => void;
    const done = new Promise<void>((resolve) => {
      doneResolve = resolve;
    });

    const ctx = {
      log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
    };

    const timer = startReminderScheduler(ctx as never, 10, undefined, {
      now: () => nowMs,
      fetchDuePending: async (_ctx, _nowIso, _limit, excludeIds = []) => {
        ticks += 1;
        if (ticks === 1) return [row];
        if (ticks === 2) {
          doneResolve();
        }
        return excludeIds.includes(row.id) ? [] : [];
      },
      getReminderRowById: async () => row,
      sendReminderHubMessage: async () => ({ delivered: true, via: "channel" }),
      applyDispatchResult: async (_ctx, _r, _forceNow, _db, fixedNextFireAt) => {
        applyCalls.push({ fixedNextFireAt });
        if (applyCalls.length === 1) {
          // Advance clock by 20 minutes (still before 01:00)
          nowMs = Date.parse("2026-01-01T00:25:00.000Z");
          throw new Error("db timeout");
        }
        row.fire_at = fixedNextFireAt ?? row.fire_at;
        return { updated: 1, recurring: true, nextFireAt: row.fire_at };
      },
    });

    try {
      await done;
      assert.deepEqual(applyCalls, [
        { fixedNextFireAt: expectedNextFireAt },
        { fixedNextFireAt: expectedNextFireAt },
      ]);
      assert.equal(row.fire_at, expectedNextFireAt);
    } finally {
      await timer.stop();
      clearPendingDispatchUpdate(row.id);
    }
  }

  // 2. Long DB outage: saved nextFireAt (01:00) is already in the past at 02:05 -> recomputed to 03:00
  {
    const row = makeReminderRow("rem-sched-fixed-next-past", "ch-1", { interval_sec: 3600 }, "2026-01-01T00:00:00.000Z");
    let nowMs = Date.parse("2026-01-01T00:05:00.000Z");
    const applyCalls: Array<{ fixedNextFireAt?: string | null }> = [];
    let ticks = 0;

    let doneResolve!: () => void;
    const done = new Promise<void>((resolve) => {
      doneResolve = resolve;
    });

    const ctx = {
      log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
    };

    const timer = startReminderScheduler(ctx as never, 10, undefined, {
      now: () => nowMs,
      fetchDuePending: async (_ctx, _nowIso, _limit, excludeIds = []) => {
        ticks += 1;
        if (ticks === 1) return [row];
        if (ticks === 2) {
          doneResolve();
        }
        return excludeIds.includes(row.id) ? [] : [];
      },
      getReminderRowById: async () => row,
      sendReminderHubMessage: async () => ({ delivered: true, via: "channel" }),
      applyDispatchResult: async (_ctx, _r, _forceNow, _db, fixedNextFireAt) => {
        applyCalls.push({ fixedNextFireAt });
        if (applyCalls.length === 1) {
          // Advance clock by 2 hours past saved nextFireAt (01:00 -> now is 02:05)
          nowMs = Date.parse("2026-01-01T02:05:00.000Z");
          throw new Error("db timeout");
        }
        row.fire_at = fixedNextFireAt ?? row.fire_at;
        return { updated: 1, recurring: true, nextFireAt: row.fire_at };
      },
    });

    try {
      await done;
      assert.deepEqual(applyCalls, [
        { fixedNextFireAt: "2026-01-01T01:00:00.000Z" },
        { fixedNextFireAt: "2026-01-01T03:00:00.000Z" },
      ]);
      assert.equal(row.fire_at, "2026-01-01T03:00:00.000Z");
    } finally {
      await timer.stop();
      clearPendingDispatchUpdate(row.id);
    }
  }

  // 3. Long DB outage for manual post (forceNow = true): saved 01:05 is in the past at 02:05 -> recomputed to 03:05
  {
    const row = makeReminderRow("rem-manual-fixed-next-past", "ch-1", { interval_sec: 3600 }, "2026-01-01T00:00:00.000Z");
    recordPendingDispatchUpdate(row, true, "delivered", "2026-01-01T01:05:00.000Z");
    const applyCalls: Array<{ forceNow: boolean; fixedNextFireAt?: string | null }> = [];
    let doneResolve!: () => void;
    const done = new Promise<void>((resolve) => {
      doneResolve = resolve;
    });
    const ctx = {
      log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
    };
    const timer = startReminderScheduler(ctx as never, 10, undefined, {
      now: () => Date.parse("2026-01-01T02:05:00.000Z"),
      fetchDuePending: async () => {
        doneResolve();
        return [];
      },
      getReminderRowById: async () => null,
      sendReminderHubMessage: async () => ({ delivered: true, via: "channel" }),
      applyDispatchResult: async (_ctx, _r, forceNow, _db, fixedNextFireAt) => {
        applyCalls.push({ forceNow, fixedNextFireAt });
        return { updated: 1, recurring: true, nextFireAt: fixedNextFireAt ?? null };
      },
    });

    try {
      await done;
      assert.deepEqual(applyCalls, [
        { forceNow: true, fixedNextFireAt: "2026-01-01T03:05:00.000Z" },
      ]);
    } finally {
      await timer.stop();
      clearPendingDispatchUpdate(row.id);
    }
  }
});

test("applyDispatchResult uses fixedNextFireAt when provided", async () => {
  const recRow = makeReminderRow("rem-fixed-next-db", "ch-1", { interval_sec: 3600 }, "2026-01-01T00:00:00.000Z");
  const fixedIso = "2026-01-01T01:05:00.000Z";
  let patched: Record<string, unknown> | undefined;
  const fakeDb = {
    updateTable: () => {
      const builder = {
        set: (values: Record<string, unknown>) => {
          patched = values;
          return builder;
        },
        where: () => builder,
        executeTakeFirst: async () => ({ numUpdatedRows: 1n }),
      };
      return builder;
    },
  };
  const res = await applyDispatchResult({} as never, recRow, true, fakeDb as never, fixedIso);
  assert.equal(res.updated, 1);
  assert.equal(res.recurring, true);
  assert.equal(res.nextFireAt, fixedIso);
  assert.deepEqual(patched, { fire_at: fixedIso });
});

test("reminder edit, channel change, and delete handlers defer before waiting on dispatch lock", async () => {
  const ctx = {
    log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
  };

  // 1. Delete handler waits on dispatch lock after deferUpdate
  {
    const rowId = "rem-lock-delete";
    const events: string[] = [];
    let releaseLock!: () => void;
    const lockGate = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    let lockEnteredResolve!: () => void;
    const lockEntered = new Promise<void>((resolve) => {
      lockEnteredResolve = resolve;
    });

    const lockHolder = withReminderDispatchLock(rowId, async () => {
      events.push("lock_acquired");
      lockEnteredResolve();
      await lockGate;
      events.push("lock_released");
    });

    await lockEntered;

    const interaction = {
      customId: `rem_manage_delete:${rowId}`,
      guild: { id: "guild-1" },
      user: { id: "user-1" },
      deferUpdate: async () => {
        events.push("deferUpdate");
      },
      editReply: async () => {
        events.push("editReply");
      },
    };

    const handlerPromise = handleReminderHubButton(interaction as never, ctx as never, {
      getActiveForAuthor: async () => ({
        id: rowId,
        ev_type: "reminder",
        title: "t",
        body: "b",
        channel_id: "123",
        author_id: "user-1",
        fire_at: "2026-01-01T00:00:00.000Z",
        status: "pending",
        recurrence_json: null,
      }),
      cancelReminderForAuthor: async () => {
        events.push("cancel");
        return 1;
      },
      listActiveByType: async () => [],
    });

    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.deepEqual(events, ["lock_acquired", "deferUpdate"]);

    releaseLock();
    await Promise.all([lockHolder, handlerPromise]);
    assert.deepEqual(events, ["lock_acquired", "deferUpdate", "lock_released", "cancel", "editReply"]);
  }

  // 2. Channel select handler waits on dispatch lock after deferUpdate
  {
    const rowId = "rem-lock-channel";
    const events: string[] = [];
    let releaseLock!: () => void;
    const lockGate = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    let lockEnteredResolve!: () => void;
    const lockEntered = new Promise<void>((resolve) => {
      lockEnteredResolve = resolve;
    });

    const lockHolder = withReminderDispatchLock(rowId, async () => {
      events.push("lock_acquired");
      lockEnteredResolve();
      await lockGate;
      events.push("lock_released");
    });

    await lockEntered;

    const view = {
      id: rowId,
      ev_type: "reminder" as const,
      title: "t",
      body: "b",
      channel_id: "999999",
      author_id: "user-1",
      fire_at: "2026-01-01T00:00:00.000Z",
      status: "pending",
      recurrence_json: null,
    };
    const sendableCh = {
      id: "999999",
      guildId: "guild-1",
      isTextBased: () => true,
      isSendable: () => true,
      isThread: () => false,
      permissionsFor: () => ({ has: () => true }),
    };
    const interaction = {
      customId: `rem_manage_channel_pick:${rowId}`,
      guild: {
        id: "guild-1",
        members: { me: { id: "bot-1" } },
        channels: { cache: new Map([["999999", sendableCh]]), fetch: async () => sendableCh },
      },
      user: { id: "user-1" },
      values: ["999999"],
      deferUpdate: async () => {
        events.push("deferUpdate");
      },
      editReply: async () => {
        events.push("editReply");
      },
    };

    const handlerPromise = handleReminderHubChannelSelect(interaction as never, ctx as never, {
      getActiveForAuthor: async () => view,
      updateReminderHubChannel: async () => {
        events.push("updateChannel");
        return 1;
      },
      listActiveByType: async () => [],
    });

    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.deepEqual(events, ["lock_acquired", "deferUpdate"]);

    releaseLock();
    await Promise.all([lockHolder, handlerPromise]);
    assert.deepEqual(events, ["lock_acquired", "deferUpdate", "lock_released", "updateChannel", "editReply"]);
  }

  // 3. Edit modal handler waits on dispatch lock after deferReply
  {
    const rowId = "rem-lock-edit";
    const events: string[] = [];
    let releaseLock!: () => void;
    const lockGate = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    let lockEnteredResolve!: () => void;
    const lockEntered = new Promise<void>((resolve) => {
      lockEnteredResolve = resolve;
    });

    const lockHolder = withReminderDispatchLock(rowId, async () => {
      events.push("lock_acquired");
      lockEnteredResolve();
      await lockGate;
      events.push("lock_released");
    });

    await lockEntered;

    const view = {
      id: rowId,
      ev_type: "reminder" as const,
      title: "updated",
      body: "updated body",
      channel_id: "999999",
      author_id: "user-1",
      fire_at: "2026-01-02T00:00:00.000Z",
      status: "pending",
      recurrence_json: null,
    };
    const fieldsMap: Record<string, string> = {
      title: "updated",
      body: "updated body",
      due_at: "2026-01-02 09:00",
      recurrence: "",
      channel_id: "999999",
    };
    const sendableChannel = {
      id: "999999",
      guildId: "guild-1",
      isTextBased: () => true,
      isSendable: () => true,
    };
    const interaction = {
      customId: `rem_manage_edit_modal:${rowId}:${Date.parse(view.fire_at)}`,
      guild: {
        id: "guild-1",
        channels: {
          cache: new Map([["999999", sendableChannel]]),
          fetch: async (id: string) => (id === "999999" ? sendableChannel : null),
        },
      },
      user: { id: "user-1" },
      fields: {
        getTextInputValue: (key: string) => fieldsMap[key] ?? "",
      },
      deferReply: async () => {
        events.push("deferReply");
      },
      editReply: async () => {
        events.push("editReply");
      },
    };

    const handlerPromise = handleReminderHubModal(interaction as never, ctx as never, {
      getActiveForAuthor: async () => view,
      updateReminderHubContentAndChannel: async () => {
        events.push("updateContentAndChannel");
        return 1;
      },
      listActiveByType: async () => [],
    });

    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.deepEqual(events, ["lock_acquired", "deferReply"]);

    releaseLock();
    await Promise.all([lockHolder, handlerPromise]);
    assert.deepEqual(events, [
      "lock_acquired",
      "deferReply",
      "lock_released",
      "updateContentAndChannel",
      "editReply",
    ]);
  }
});

test("handleReminderHubModal edit preserves scheduler-advanced fire_at when user leaves due_at unchanged, and applies user due_at when changed", async () => {
  const ctx = {
    log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
  };
  const modalFireAt = "2026-01-01T00:00:00.000Z";
  const advancedFireAt = "2026-01-01T01:00:00.000Z";
  const userChangedFireAt = "2026-01-01T03:30:00.000Z";
  const rowId = "rem-edit-fire-at-race";
  const sendableChannel = {
    id: "999999",
    guildId: "guild-1",
    isTextBased: () => true,
    isSendable: () => true,
  };

  // Case A: due_at left unchanged -> preserves advancedFireAt
  {
    let savedFireAtIso: string | null = null;
    let currentFireAt = advancedFireAt;
    const fieldsMap: Record<string, string> = {
      title: "new title",
      body: "new body",
      due_at: modalFireAt,
      recurrence: "1h",
      channel_id: "999999",
    };
    const interaction = {
      customId: `rem_manage_edit_modal:${rowId}:${Date.parse(modalFireAt)}`,
      guild: {
        id: "guild-1",
        channels: {
          cache: new Map([["999999", sendableChannel]]),
          fetch: async (id: string) => (id === "999999" ? sendableChannel : null),
        },
      },
      user: { id: "user-1" },
      fields: { getTextInputValue: (key: string) => fieldsMap[key] ?? "" },
      deferReply: async () => undefined,
      editReply: async () => undefined,
    };

    await handleReminderHubModal(interaction as never, ctx as never, {
      getActiveForAuthor: async () => ({
        id: rowId,
        ev_type: "reminder",
        title: "old",
        body: "old",
        channel_id: "999999",
        author_id: "user-1",
        fire_at: currentFireAt,
        status: "pending",
        recurrence_json: JSON.stringify({ interval_sec: 3600 }),
      }),
      updateReminderHubContentAndChannel: async (_ctx, input) => {
        savedFireAtIso = input.fireAt.toISOString();
        currentFireAt = input.fireAt.toISOString();
        return 1;
      },
      listActiveByType: async () => [],
    });

    assert.equal(savedFireAtIso, advancedFireAt);
  }

  // Case B: due_at changed by user -> applies userChangedFireAt
  {
    let savedFireAtIso: string | null = null;
    let currentFireAt = advancedFireAt;
    const fieldsMap: Record<string, string> = {
      title: "new title",
      body: "new body",
      due_at: userChangedFireAt,
      recurrence: "1h",
      channel_id: "999999",
    };
    const interaction = {
      customId: `rem_manage_edit_modal:${rowId}:${Date.parse(modalFireAt)}`,
      guild: {
        id: "guild-1",
        channels: {
          cache: new Map([["999999", sendableChannel]]),
          fetch: async (id: string) => (id === "999999" ? sendableChannel : null),
        },
      },
      user: { id: "user-1" },
      fields: { getTextInputValue: (key: string) => fieldsMap[key] ?? "" },
      deferReply: async () => undefined,
      editReply: async () => undefined,
    };

    await handleReminderHubModal(interaction as never, ctx as never, {
      getActiveForAuthor: async () => ({
        id: rowId,
        ev_type: "reminder",
        title: "old",
        body: "old",
        channel_id: "999999",
        author_id: "user-1",
        fire_at: currentFireAt,
        status: "pending",
        recurrence_json: JSON.stringify({ interval_sec: 3600 }),
      }),
      updateReminderHubContentAndChannel: async (_ctx, input) => {
        savedFireAtIso = input.fireAt.toISOString();
        currentFireAt = input.fireAt.toISOString();
        return 1;
      },
      listActiveByType: async () => [],
    });

    assert.equal(savedFireAtIso, userChangedFireAt);
  }
});

test("handleReminderHubModal rejects channels outside guild or non-sendable, and sendReminderHubMessage treats cross-guild channel as CHANNEL_NOT_SENDABLE", async () => {
  const ctx = {
    log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
  };
  const nonSendableChannel = {
    id: "777777",
    guildId: "guild-1",
    isTextBased: () => false,
    isSendable: () => false,
  };
  const foreignChannel = {
    id: "888888",
    guildId: "guild-other",
    isTextBased: () => true,
    isSendable: () => true,
  };

  for (const badChannelId of ["888888", "777777", "111111"]) {
    // Edit modal must deferReply before fetching channel, then reject via editReply and not save
    let updated = false;
    const editOrder: string[] = [];
    const editReplies: unknown[] = [];
    const fieldsMap: Record<string, string> = {
      title: "title",
      body: "body",
      due_at: "2026-01-02T00:00:00.000Z",
      recurrence: "",
      channel_id: badChannelId,
    };
    const editInteraction = {
      customId: "rem_manage_edit_modal:rem-bad-ch:1767225600000",
      guild: {
        id: "guild-1",
        channels: {
          cache: new Map<string, unknown>([
            ["777777", nonSendableChannel],
            ["888888", foreignChannel],
          ]),
          fetch: async () => {
            editOrder.push("fetch");
            return null;
          },
        },
      },
      user: { id: "user-1" },
      fields: { getTextInputValue: (key: string) => fieldsMap[key] ?? "" },
      deferReply: async () => {
        editOrder.push("deferReply");
      },
      editReply: async (payload: unknown) => {
        editOrder.push("editReply");
        editReplies.push(payload);
      },
    };
    await handleReminderHubModal(editInteraction as never, ctx as never, {
      getActiveForAuthor: async () => ({
        id: "rem-bad-ch",
        ev_type: "reminder",
        title: "title",
        body: "body",
        channel_id: "999999",
        author_id: "user-1",
        fire_at: "2026-01-01T00:00:00.000Z",
        status: "pending",
        recurrence_json: null,
      }),
      updateReminderHubContentAndChannel: async () => {
        updated = true;
        return 1;
      },
      listActiveByType: async () => [],
    });
    assert.equal(updated, false);
    assert.equal(editReplies.length, 1);
    assert.match(JSON.stringify(editReplies[0]), /このサーバー内の送信可能なテキストチャンネル/);
    if (badChannelId === "111111") {
      assert.deepEqual(editOrder, ["deferReply", "fetch", "editReply"]);
    }

    // Create modal must also deferReply before fetching channel, then reject via editReply
    const createOrder: string[] = [];
    const createReplies: unknown[] = [];
    const createInteraction = {
      customId: "reminder_modal:reminder",
      guild: {
        id: "guild-1",
        channels: {
          cache: new Map<string, unknown>([
            ["777777", nonSendableChannel],
            ["888888", foreignChannel],
          ]),
          fetch: async () => {
            createOrder.push("fetch");
            return null;
          },
        },
      },
      user: { id: "user-1" },
      fields: { getTextInputValue: (key: string) => fieldsMap[key] ?? "" },
      deferReply: async () => {
        createOrder.push("deferReply");
      },
      editReply: async (payload: unknown) => {
        createOrder.push("editReply");
        createReplies.push(payload);
      },
    };
    await handleReminderHubModal(createInteraction as never, ctx as never);
    assert.equal(createReplies.length, 1);
    assert.match(JSON.stringify(createReplies[0]), /このサーバー内の送信可能なテキストチャンネル/);
    if (badChannelId === "111111") {
      assert.deepEqual(createOrder, ["deferReply", "fetch", "editReply"]);
    }
  }

  // Edit modal skips channel validation (and REST fetch) when channel_id is unchanged
  {
    let fetchCalled = false;
    let contentUpdated = false;
    const editReplies: unknown[] = [];
    const unchangedFields: Record<string, string> = {
      title: "updated title",
      body: "updated body",
      due_at: "2026-01-02T00:00:00.000Z",
      recurrence: "",
      channel_id: "999999",
    };
    const interaction = {
      customId: "rem_manage_edit_modal:rem-same-ch:1767225600000",
      guild: {
        id: "guild-1",
        channels: {
          cache: new Map<string, unknown>(),
          fetch: async () => {
            fetchCalled = true;
            return null;
          },
        },
      },
      user: { id: "user-1" },
      fields: { getTextInputValue: (key: string) => unchangedFields[key] ?? "" },
      deferReply: async () => undefined,
      editReply: async (payload: unknown) => {
        editReplies.push(payload);
      },
    };
    const currentView = {
      id: "rem-same-ch",
      ev_type: "reminder" as const,
      title: "old",
      body: "old",
      channel_id: "999999",
      author_id: "user-1",
      fire_at: "2026-01-01T00:00:00.000Z",
      status: "pending",
      recurrence_json: null,
    };
    await handleReminderHubModal(interaction as never, ctx as never, {
      getActiveForAuthor: async () => currentView,
      updateReminderHubContentAndChannel: async () => {
        contentUpdated = true;
        return 1;
      },
      listActiveByType: async () => [],
    });
    assert.equal(fetchCalled, false);
    assert.equal(contentUpdated, true);
    assert.match(JSON.stringify(editReplies[0]), /更新しました/);
  }

  // sendReminderHubMessage must reject cross-guild channel as StructuralReminderDeliveryError(CHANNEL_NOT_SENDABLE)
  const row = makeReminderRow("rem-cross-guild", "888888");
  let foreignSendCalled = false;
  const ctxForeign = {
    client: {
      guilds: { fetch: async () => ({ id: "guild-1" }) },
      channels: {
        fetch: async () => ({
          guildId: "guild-other",
          isTextBased: () => true,
          isSendable: () => true,
          send: async () => {
            foreignSendCalled = true;
          },
        }),
      },
      users: {
        fetch: async () => ({
          send: async () => {
            throw Object.assign(new Error("Cannot send messages to this user"), { code: 50_007, status: 403 });
          },
        }),
      },
    },
  };
  const result = await sendReminderHubMessage(ctxForeign as never, row);
  assert.equal(foreignSendCalled, false);
  assert.equal(result.delivered, false);
  assert.equal(result.permanent, true);
  assert.ok(result.channelError instanceof StructuralReminderDeliveryError);
  assert.equal(result.channelError.code, "CHANNEL_NOT_SENDABLE");
});

test("handleReminderHubModal edit applies pending dispatch update first, and aborts without saving if pending apply fails", async () => {
  const ctx = {
    log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
  };

  // Case 1: Single reminder has pending delivered DB update -> applied first -> becomes fired -> edit reports already processed and does not overwrite
  {
    const row = makeReminderRow("rem-edit-pending-single", "999999", null, "2026-01-01T00:00:30.000Z");
    recordPendingDispatchUpdate(row, false, "delivered", null);
    let dbStatus = "pending";
    let contentUpdated = false;
    const editReplies: unknown[] = [];
    const fieldsMap: Record<string, string> = {
      title: "edited title",
      body: "edited body",
      due_at: "2026-01-01T00:00:00.000Z",
      recurrence: "",
      channel_id: "999999",
    };
    const interaction = {
      customId: `rem_manage_edit_modal:${row.id}:${Date.parse(row.fire_at)}`,
      guild: { id: "guild-1", channels: { cache: new Map(), fetch: async () => null } },
      user: { id: "user-1" },
      fields: { getTextInputValue: (key: string) => fieldsMap[key] ?? "" },
      deferReply: async () => undefined,
      editReply: async (payload: unknown) => {
        editReplies.push(payload);
      },
    };
    try {
      await handleReminderHubModal(interaction as never, ctx as never, {
        now: () => Date.parse("2026-01-01T00:01:00.000Z"),
        getActiveForAuthor: async () =>
          dbStatus === "pending"
            ? {
                id: row.id,
                ev_type: "reminder",
                title: "old",
                body: "old",
                channel_id: "999999",
                author_id: "user-1",
                fire_at: row.fire_at,
                status: dbStatus,
                recurrence_json: null,
              }
            : null,
        applyDispatchResult: async () => {
          dbStatus = "fired";
          return { updated: 1, recurring: false, nextFireAt: null };
        },
        updateReminderHubContentAndChannel: async () => {
          contentUpdated = true;
          return 1;
        },
        listActiveByType: async () => [],
      });
      assert.equal(hasPendingDispatchUpdate(row.id), false);
      assert.equal(contentUpdated, false);
      assert.match(JSON.stringify(editReplies[0]), /すでに送信済み/);
    } finally {
      clearPendingDispatchUpdate(row.id);
    }
  }

  // Case 2: Pending dispatch update fails -> edit does not save and returns temporary error message
  {
    const row = makeReminderRow("rem-edit-pending-fail", "999999", { interval_sec: 3600 }, "2026-01-01T00:00:00.000Z");
    recordPendingDispatchUpdate(row, false, "delivered", "2026-01-01T01:00:00.000Z");
    let contentUpdated = false;
    const editReplies: unknown[] = [];
    const fieldsMap: Record<string, string> = {
      title: "edited title",
      body: "edited body",
      due_at: "2026-01-01T00:00:00.000Z",
      recurrence: "1h",
      channel_id: "999999",
    };
    const interaction = {
      customId: `rem_manage_edit_modal:${row.id}:${Date.parse(row.fire_at)}`,
      guild: { id: "guild-1", channels: { cache: new Map(), fetch: async () => null } },
      user: { id: "user-1" },
      fields: { getTextInputValue: (key: string) => fieldsMap[key] ?? "" },
      deferReply: async () => undefined,
      editReply: async (payload: unknown) => {
        editReplies.push(payload);
      },
    };
    try {
      await handleReminderHubModal(interaction as never, ctx as never, {
        now: () => Date.parse("2026-01-01T00:05:00.000Z"),
        getActiveForAuthor: async () => ({
          id: row.id,
          ev_type: "reminder",
          title: "old",
          body: "old",
          channel_id: "999999",
          author_id: "user-1",
          fire_at: row.fire_at,
          status: "pending",
          recurrence_json: JSON.stringify({ interval_sec: 3600 }),
        }),
        applyDispatchResult: async () => {
          throw new Error("db still down");
        },
        updateReminderHubContentAndChannel: async () => {
          contentUpdated = true;
          return 1;
        },
        listActiveByType: async () => [],
      });
      assert.equal(hasPendingDispatchUpdate(row.id), true);
      assert.equal(contentUpdated, false);
      assert.match(JSON.stringify(editReplies[0]), /送信処理の反映中のため、少し待ってから再度お試しください/);
    } finally {
      clearPendingDispatchUpdate(row.id);
    }
  }
});

test("delete, manual post, and channel change handlers catch DB errors after deferUpdate and recover with V2 editReply or ephemeral followUp", async () => {
  const loggedErrors: unknown[][] = [];
  const ctx = {
    log: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: (...args: unknown[]) => {
        loggedErrors.push(args);
      },
    },
  };

  // 1. Delete button DB error -> refreshes list and V2 editReply with existing rows + error notice
  {
    const editReplies: unknown[] = [];
    const followUps: unknown[] = [];
    const existingRow = {
      id: "rem-err-del",
      ev_type: "reminder" as const,
      title: "keep-me-visible",
      body: "b",
      channel_id: "123",
      author_id: "user-1",
      fire_at: "2026-01-01T00:00:00.000Z",
      status: "pending",
      recurrence_json: null,
    };
    const interaction = {
      customId: "rem_manage_delete:rem-err-del",
      guild: { id: "guild-1" },
      user: { id: "user-1" },
      deferUpdate: async () => undefined,
      editReply: async (payload: unknown) => {
        editReplies.push(payload);
      },
      followUp: async (payload: unknown) => {
        followUps.push(payload);
      },
    };
    const handled = await handleReminderHubButton(interaction as never, ctx as never, {
      getActiveForAuthor: async () => existingRow,
      cancelReminderForAuthor: async () => {
        throw new Error("db write failed");
      },
      listActiveByType: async () => [existingRow],
    });
    assert.equal(handled, true);
    assert.equal(editReplies.length, 1);
    assert.equal(followUps.length, 0);
    assert.match(JSON.stringify(editReplies[0]), /エラーが発生しました/);
    assert.match(JSON.stringify(editReplies[0]), /keep-me-visible/);
    assert.ok((editReplies[0] as { components?: unknown[] }).components?.length);
  }

  // 2. Manual post DB error + list refresh failure -> does NOT overwrite panel (editReply not called), sends ephemeral followUp
  {
    const row = makeReminderRow("rem-err-post", "123");
    const editReplies: unknown[] = [];
    const followUps: unknown[] = [];
    let getRowCalls = 0;
    const interaction = {
      customId: `rem_manage_post:${row.id}`,
      guild: { id: "guild-1" },
      user: { id: "user-1" },
      deferUpdate: async () => undefined,
      editReply: async (payload: unknown) => {
        editReplies.push(payload);
      },
      followUp: async (payload: unknown) => {
        followUps.push(payload);
      },
    };
    const handled = await handleReminderHubButton(interaction as never, ctx as never, {
      getReminderRowForAuthor: async () => {
        getRowCalls += 1;
        if (getRowCalls === 1) return row;
        throw new Error("db read failed inside lock");
      },
      listActiveByType: async () => {
        throw new Error("db still unavailable for list refresh");
      },
    });
    assert.equal(handled, true);
    assert.equal(editReplies.length, 0);
    assert.equal(followUps.length, 1);
    assert.match(JSON.stringify(followUps[0]), /エラーが発生しました/);
  }

  // 3. Manual post DB error + list refresh succeeds but editReply fails -> falls back to ephemeral followUp
  {
    const row = makeReminderRow("rem-err-post-edit-fail", "123");
    const followUps: unknown[] = [];
    let getRowCalls = 0;
    const interaction = {
      customId: `rem_manage_post:${row.id}`,
      guild: { id: "guild-1" },
      user: { id: "user-1" },
      deferUpdate: async () => undefined,
      editReply: async () => {
        throw new Error("editReply rejected");
      },
      followUp: async (payload: unknown) => {
        followUps.push(payload);
      },
    };
    const handled = await handleReminderHubButton(interaction as never, ctx as never, {
      getReminderRowForAuthor: async () => {
        getRowCalls += 1;
        if (getRowCalls === 1) return row;
        throw new Error("db read failed inside lock");
      },
      listActiveByType: async () => [],
    });
    assert.equal(handled, true);
    assert.equal(followUps.length, 1);
    assert.match(JSON.stringify(followUps[0]), /エラーが発生しました/);
  }

  // 4. Channel select DB error -> refreshes list and V2 editReply with existing rows + error notice
  {
    const editReplies: unknown[] = [];
    const existingTodo = {
      id: "rem-err-ch",
      ev_type: "todo" as const,
      title: "keep-todo-visible",
      body: "b",
      channel_id: "123",
      author_id: "user-1",
      fire_at: "2026-01-01T00:00:00.000Z",
      status: "pending",
      recurrence_json: null,
    };
    const sendableCh = {
      id: "999999",
      guildId: "guild-1",
      isTextBased: () => true,
      isSendable: () => true,
      isThread: () => false,
      permissionsFor: () => ({ has: () => true }),
    };
    const interaction = {
      customId: "rem_manage_channel_pick:rem-err-ch",
      guild: {
        id: "guild-1",
        members: { me: { id: "bot-1" } },
        channels: { cache: new Map([["999999", sendableCh]]), fetch: async () => sendableCh },
      },
      user: { id: "user-1" },
      values: ["999999"],
      deferUpdate: async () => undefined,
      editReply: async (payload: unknown) => {
        editReplies.push(payload);
      },
      followUp: async () => undefined,
    };
    const handled = await handleReminderHubChannelSelect(interaction as never, ctx as never, {
      getActiveForAuthor: async () => existingTodo,
      updateReminderHubChannel: async () => {
        throw new Error("db update failed");
      },
      listActiveByType: async () => [existingTodo],
    });
    assert.equal(handled, true);
    assert.equal(editReplies.length, 1);
    assert.match(JSON.stringify(editReplies[0]), /エラーが発生しました/);
    assert.match(JSON.stringify(editReplies[0]), /keep-todo-visible/);
  }

  assert.ok(loggedErrors.length >= 6);
});

test("rem_manage_post skips sending as already_processed when recurring fire_at advanced while waiting on lock", async () => {
  const initialRow = makeReminderRow(
    "rem-post-fire-at-advanced",
    "ch-1",
    { interval_sec: 3600 },
    "2026-01-01T00:00:00.000Z",
  );
  const advancedRow: RemindersRow = {
    ...initialRow,
    fire_at: "2026-01-01T01:00:00.000Z",
  };
  let getRowCalls = 0;
  let sendCount = 0;
  const editReplies: unknown[] = [];

  const ctx = {
    log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
  };
  const interaction = {
    customId: `rem_manage_post:${initialRow.id}`,
    guild: { id: "guild-1" },
    user: { id: "user-1" },
    deferUpdate: async () => undefined,
    editReply: async (payload: unknown) => {
      editReplies.push(payload);
    },
  };

  await handleReminderHubButton(interaction as never, ctx as never, {
    getReminderRowForAuthor: async () => {
      getRowCalls += 1;
      return getRowCalls === 1 ? initialRow : advancedRow;
    },
    sendReminderHubMessage: async () => {
      sendCount += 1;
      return { delivered: true, via: "channel" };
    },
    getActiveForAuthor: async () => ({
      id: advancedRow.id,
      ev_type: "reminder",
      title: `title-${advancedRow.id}`,
      body: advancedRow.body,
      channel_id: advancedRow.channel_id,
      author_id: advancedRow.author_id,
      fire_at: advancedRow.fire_at,
      status: "pending",
      recurrence_json: JSON.stringify({ interval_sec: 3600 }),
    }),
    listActiveByType: async () => [],
  });

  assert.equal(sendCount, 0);
  assert.equal(editReplies.length, 1);
  assert.match(JSON.stringify(editReplies[0]), /すでに送信済み/);
});

test("sendReminderHubMessage falls back to DM on non-transient DiscordAPIError 4xx such as 50083 (archived thread) without changing permanent rules", async () => {
  const row = makeReminderRow("rem-50083", "thread-archived");
  const archivedThreadErr = Object.assign(new Error("Thread is archived"), {
    name: "DiscordAPIError[50083]",
    code: 50_083,
    status: 400,
  });

  // 1. 50083 -> DM fallback succeeds
  let dmSent = false;
  const ctxDmOk = {
    client: {
      guilds: { fetch: async () => ({ id: "guild-1" }) },
      channels: {
        fetch: async () => ({
          guildId: "guild-1",
          isTextBased: () => true,
          isSendable: () => true,
          send: async () => {
            throw archivedThreadErr;
          },
        }),
      },
      users: {
        fetch: async () => ({
          send: async () => {
            dmSent = true;
          },
        }),
      },
    },
  };
  const dmOkResult = await sendReminderHubMessage(ctxDmOk as never, row);
  assert.deepEqual(dmOkResult, { delivered: true, via: "dm" });
  assert.equal(dmSent, true);

  // 2. 50083 + DM 50007 -> DM was attempted, but permanent remains false (permanent criteria unchanged)
  let dmAttempted = false;
  const dmErr = Object.assign(new Error("Cannot send messages to this user"), {
    name: "DiscordAPIError[50007]",
    code: 50_007,
    status: 403,
  });
  const ctxDmFail = {
    client: {
      guilds: { fetch: async () => ({ id: "guild-1" }) },
      channels: {
        fetch: async () => ({
          guildId: "guild-1",
          isTextBased: () => true,
          isSendable: () => true,
          send: async () => {
            throw archivedThreadErr;
          },
        }),
      },
      users: {
        fetch: async () => ({
          send: async () => {
            dmAttempted = true;
            throw dmErr;
          },
        }),
      },
    },
  };
  const dmFailResult = await sendReminderHubMessage(ctxDmFail as never, row);
  assert.equal(dmAttempted, true);
  assert.equal(dmFailResult.delivered, false);
  assert.equal(dmFailResult.channelError, archivedThreadErr);
  assert.equal(dmFailResult.dmError, dmErr);
  assert.equal(dmFailResult.permanent, false);
});

test("handleReminderHubModal edit catches errors after deferReply, replies with save failure message, and logs if editReply also fails", async () => {
  const sendableChannel = {
    id: "999999",
    guildId: "guild-1",
    isTextBased: () => true,
    isSendable: () => true,
  };
  const fieldsMap: Record<string, string> = {
    title: "new title",
    body: "new body",
    due_at: "2026-01-02T00:00:00.000Z",
    recurrence: "",
    channel_id: "999999",
  };
  const currentView = {
    id: "rem-edit-db-err",
    ev_type: "reminder" as const,
    title: "old",
    body: "old",
    channel_id: "999999",
    author_id: "user-1",
    fire_at: "2026-01-01T00:00:00.000Z",
    status: "pending",
    recurrence_json: null,
  };

  // Case 1: DB error after deferReply -> editReply shows save error message and logs error
  {
    const loggedErrors: unknown[][] = [];
    const editReplies: unknown[] = [];
    const ctx = {
      log: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: (...args: unknown[]) => {
          loggedErrors.push(args);
        },
      },
    };
    const interaction = {
      customId: `rem_manage_edit_modal:${currentView.id}:${Date.parse(currentView.fire_at)}`,
      guild: {
        id: "guild-1",
        channels: { cache: new Map([["999999", sendableChannel]]), fetch: async () => sendableChannel },
      },
      user: { id: "user-1" },
      fields: { getTextInputValue: (key: string) => fieldsMap[key] ?? "" },
      deferReply: async () => undefined,
      editReply: async (payload: unknown) => {
        editReplies.push(payload);
      },
    };
    const handled = await handleReminderHubModal(interaction as never, ctx as never, {
      getActiveForAuthor: async () => currentView,
      updateReminderHubContentAndChannel: async () => {
        throw new Error("db write failed during edit");
      },
      listActiveByType: async () => [],
    });
    assert.equal(handled, true);
    assert.equal(editReplies.length, 1);
    assert.match(JSON.stringify(editReplies[0]), /保存に失敗しました。時間をおいて再度お試しください。/);
    assert.equal(loggedErrors.length, 1);
  }

  // Case 2: Both DB error and editReply fail -> does not throw, logs both errors
  {
    const loggedErrors: unknown[][] = [];
    const ctx = {
      log: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: (...args: unknown[]) => {
          loggedErrors.push(args);
        },
      },
    };
    const interaction = {
      customId: `rem_manage_edit_modal:${currentView.id}:${Date.parse(currentView.fire_at)}`,
      guild: {
        id: "guild-1",
        channels: { cache: new Map([["999999", sendableChannel]]), fetch: async () => sendableChannel },
      },
      user: { id: "user-1" },
      fields: { getTextInputValue: (key: string) => fieldsMap[key] ?? "" },
      deferReply: async () => undefined,
      editReply: async () => {
        throw new Error("editReply failed");
      },
    };
    let getActiveCalls = 0;
    const handled = await handleReminderHubModal(interaction as never, ctx as never, {
      getActiveForAuthor: async () => {
        getActiveCalls += 1;
        if (getActiveCalls === 1) return currentView;
        throw new Error("db read failed inside edit lock");
      },
      updateReminderHubContentAndChannel: async () => 1,
      listActiveByType: async () => [],
    });
    assert.equal(handled, true);
    assert.equal(loggedErrors.length, 2);
  }
});

test("rem_manage_post and startReminderScheduler leave dmError undefined when sendReminder throws unexpectedly", async () => {
  const thrownErr = new Error("unexpected sendReminder throw");

  // 1. Manual post (rem_manage_post)
  {
    const row = makeReminderRow("rem-manual-throw", "ch-1");
    const errorMetas: Array<Record<string, unknown>> = [];
    const ctx = {
      log: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: (meta: Record<string, unknown>) => {
          errorMetas.push(meta);
        },
      },
    };
    const interaction = {
      customId: `rem_manage_post:${row.id}`,
      guild: { id: "guild-1" },
      user: { id: "user-1" },
      deferUpdate: async () => undefined,
      editReply: async () => undefined,
    };

    await handleReminderHubButton(interaction as never, ctx as never, {
      getReminderRowForAuthor: async () => row,
      sendReminderHubMessage: async () => {
        throw thrownErr;
      },
      getActiveForAuthor: async () => null,
      listActiveByType: async () => [],
    });

    assert.equal(errorMetas.length, 1);
    assert.equal(errorMetas[0]?.channelError, thrownErr);
    assert.equal(errorMetas[0]?.dmError, undefined);
  }

  // 2. Scheduler (startReminderScheduler)
  {
    const row = makeReminderRow("rem-sched-throw", "ch-1");
    const errorMetas: Array<Record<string, unknown>> = [];
    let loggedResolve!: () => void;
    const loggedDone = new Promise<void>((resolve) => {
      loggedResolve = resolve;
    });
    const ctx = {
      log: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: (meta: Record<string, unknown>) => {
          errorMetas.push(meta);
          loggedResolve();
        },
      },
    };
    let fetched = false;
    const scheduler = startReminderScheduler(ctx as never, 10, undefined, {
      now: () => Date.parse("2026-01-01T00:05:00.000Z"),
      fetchDuePending: async () => {
        if (fetched) return [];
        fetched = true;
        return [row];
      },
      getReminderRowById: async () => row,
      sendReminderHubMessage: async () => {
        throw thrownErr;
      },
    });

    try {
      await loggedDone;
      assert.equal(errorMetas.length, 1);
      assert.equal(errorMetas[0]?.channelError, thrownErr);
      assert.equal(errorMetas[0]?.dmError, undefined);
    } finally {
      await scheduler.stop();
      clearReminderRetryState(row.id);
    }
  }
});

test("startReminderScheduler skips recurring reminder on permanent failure without cancelling, warns once until delivery success or deletion", async () => {
  const row = makeReminderRow("rem-rec-perm-warn-dedup", "ch-deleted", { interval_sec: 3600 }, "2026-01-01T00:00:00.000Z");
  clearRecurringPermanentSkipWarned(row.id);

  let nowMs = Date.parse("2026-01-01T00:05:00.000Z");
  let phase = 0;
  let cancelledCalls = 0;
  let skippedCalls = 0;
  const warns: unknown[][] = [];
  const debugs: unknown[][] = [];

  let doneResolve!: () => void;
  const done = new Promise<void>((resolve) => {
    doneResolve = resolve;
  });

  const ctx = {
    log: {
      debug: (...args: unknown[]) => {
        debugs.push(args);
      },
      info: () => undefined,
      warn: (...args: unknown[]) => {
        warns.push(args);
      },
      error: () => undefined,
    },
  };

  const scheduler = startReminderScheduler(ctx as never, 10, undefined, {
    now: () => nowMs,
    fetchDuePending: async () => {
      phase += 1;
      if (phase === 1) {
        // 1st permanent failure -> skip + warn
        return [row];
      }
      if (phase === 2) {
        // 2nd permanent failure -> skip + debug (no extra warn)
        nowMs = Date.parse("2026-01-01T01:05:00.000Z");
        return [row];
      }
      if (phase === 3) {
        // Delivery succeeds -> resets warn flag
        nowMs = Date.parse("2026-01-01T02:05:00.000Z");
        return [row];
      }
      if (phase === 4) {
        // Permanent failure after success -> warns again
        nowMs = Date.parse("2026-01-01T03:05:00.000Z");
        return [row];
      }
      if (phase === 5) {
        doneResolve();
      }
      return [];
    },
    getReminderRowById: async () => row,
    sendReminderHubMessage: async () => {
      if (phase === 3) {
        return { delivered: true, via: "dm" };
      }
      return {
        delivered: false,
        channelError: Object.assign(new Error("Unknown Channel"), { code: 10_003, status: 404 }),
        dmError: Object.assign(new Error("Cannot send messages to this user"), { code: 50_007, status: 403 }),
        permanent: true,
      };
    },
    applyDispatchResult: async (_ctx, _r, _forceNow, _db, fixedNextFireAt) => {
      if (phase !== 3) skippedCalls += 1;
      row.fire_at = fixedNextFireAt ?? row.fire_at;
      return { updated: 1, recurring: true, nextFireAt: row.fire_at };
    },
    cancelUndeliverableReminder: async () => {
      cancelledCalls += 1;
      return 1;
    },
  });

  try {
    await done;
    assert.equal(cancelledCalls, 0);
    assert.equal(skippedCalls, 3);
    // Warn on phase 1 and phase 4 only; phase 2 is downgraded to debug
    assert.equal(warns.length, 2);
    assert.equal(
      debugs.filter((args) => args[1] === "recurring reminder skipped after delivery failure").length,
      1,
    );
    assert.equal(hasRecurringPermanentSkipWarned(row.id), true);

    // Deleting the reminder via manage button clears the warned flag
    const deleteInteraction = {
      customId: `rem_manage_delete:${row.id}`,
      guild: { id: "guild-1" },
      user: { id: "user-1" },
      deferUpdate: async () => undefined,
      editReply: async () => undefined,
    };
    await handleReminderHubButton(deleteInteraction as never, ctx as never, {
      getActiveForAuthor: async () => ({
        id: row.id,
        ev_type: "reminder",
        title: "t",
        body: "b",
        channel_id: row.channel_id,
        author_id: row.author_id,
        fire_at: row.fire_at,
        status: "pending",
        recurrence_json: JSON.stringify({ interval_sec: 3600 }),
      }),
      cancelReminderForAuthor: async () => 1,
      listActiveByType: async () => [],
    });
    assert.equal(hasRecurringPermanentSkipWarned(row.id), false);
  } finally {
    await scheduler.stop();
    clearReminderRetryState(row.id);
    clearRecurringPermanentSkipWarned(row.id);
  }
});

test("handleReminderHubModal rejects legacy edit modal customId without fire_at, and rem_manage_edit replies with error instead of opening modal when customId exceeds 100 chars", async () => {
  const loggedErrors: unknown[][] = [];
  const ctx = {
    log: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: (...args: unknown[]) => {
        loggedErrors.push(args);
      },
    },
  };

  // 1. Legacy edit modal customId (without fire_at) is rejected without saving
  {
    let saved = false;
    const replies: unknown[] = [];
    const interaction = {
      customId: "rem_manage_edit_modal:rem-legacy-id",
      guild: { id: "guild-1" },
      user: { id: "user-1" },
      reply: async (payload: unknown) => {
        replies.push(payload);
      },
    };
    const handled = await handleReminderHubModal(interaction as never, ctx as never, {
      getActiveForAuthor: async () => {
        throw new Error("should not query DB for legacy modal customId");
      },
      updateReminderHubContentAndChannel: async () => {
        saved = true;
        return 1;
      },
    });
    assert.equal(handled, true);
    assert.equal(saved, false);
    assert.equal(replies.length, 1);
    assert.match(
      JSON.stringify(replies[0]),
      /編集画面が古くなっています。もう一度編集ボタンから開き直してください。/,
    );
  }

  // 2. Edit button when customId would exceed 100 chars logs error and replies ephemerally without calling showModal
  {
    let showModalCalled = false;
    const replies: unknown[] = [];
    const oversizedRowId = "r".repeat(80);
    const buttonInteraction = {
      customId: `rem_manage_edit:${oversizedRowId}`,
      guild: { id: "guild-1" },
      user: { id: "user-1" },
      showModal: async () => {
        showModalCalled = true;
      },
      reply: async (payload: unknown) => {
        replies.push(payload);
      },
    };
    const handled = await handleReminderHubButton(buttonInteraction as never, ctx as never, {
      getActiveForAuthor: async () => ({
        id: oversizedRowId,
        ev_type: "reminder",
        title: "t",
        body: "b",
        channel_id: "999999",
        author_id: "user-1",
        fire_at: "2026-01-01T00:00:00.000Z",
        status: "pending",
        recurrence_json: null,
      }),
    });
    assert.equal(handled, true);
    assert.equal(showModalCalled, false);
    assert.equal(replies.length, 1);
    assert.equal(loggedErrors.length, 1);
  }
});

test("handleReminderHubModal checks bot channel permissions (including threads and fetchMe fallback) on create and edit", async () => {
  const fieldsMap: Record<string, string> = {
    title: "title",
    body: "body",
    due_at: "2026-01-02T00:00:00.000Z",
    recurrence: "",
    channel_id: "555555",
  };
  const makePerms = (allowed: bigint[]) => ({
    has: (flag: bigint) => allowed.includes(flag),
  });

  // 1. Standard channel missing SendMessages -> rejected on both create and edit
  {
    const ctx = {
      log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
    };
    const ch = {
      id: "555555",
      guildId: "guild-1",
      isTextBased: () => true,
      isSendable: () => true,
      isThread: () => false,
      permissionsFor: () => makePerms([PermissionFlagsBits.ViewChannel]),
    };
    const guild = {
      id: "guild-1",
      members: { me: { id: "bot-1" } },
      channels: { cache: new Map([["555555", ch]]), fetch: async () => ch },
    };

    let created = false;
    const createReplies: unknown[] = [];
    await handleReminderHubModal(
      {
        customId: "reminder_modal:reminder",
        guild,
        user: { id: "user-1" },
        fields: { getTextInputValue: (k: string) => fieldsMap[k] ?? "" },
        deferReply: async () => undefined,
        editReply: async (p: unknown) => {
          createReplies.push(p);
        },
      } as never,
      ctx as never,
      {
        createReminderHubEntry: async () => {
          created = true;
          return "new-id";
        },
      },
    );
    assert.equal(created, false);
    assert.match(JSON.stringify(createReplies[0]), /Bot がこのチャンネルに投稿できません（権限: SendMessages）/);

    let updated = false;
    const editReplies: unknown[] = [];
    await handleReminderHubModal(
      {
        customId: "rem_manage_edit_modal:rem-perm-edit:1767225600000",
        guild,
        user: { id: "user-1" },
        fields: { getTextInputValue: (k: string) => fieldsMap[k] ?? "" },
        deferReply: async () => undefined,
        editReply: async (p: unknown) => {
          editReplies.push(p);
        },
      } as never,
      ctx as never,
      {
        getActiveForAuthor: async () => ({
          id: "rem-perm-edit",
          ev_type: "reminder",
          title: "old",
          body: "old",
          channel_id: "999999",
          author_id: "user-1",
          fire_at: "2026-01-01T00:00:00.000Z",
          status: "pending",
          recurrence_json: null,
        }),
        updateReminderHubContentAndChannel: async () => {
          updated = true;
          return 1;
        },
      },
    );
    assert.equal(updated, false);
    assert.match(JSON.stringify(editReplies[0]), /Bot がこのチャンネルに投稿できません（権限: SendMessages）/);
  }

  // 2. Thread channel checks SendMessagesInThreads (not SendMessages)
  {
    const ctx = {
      log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
    };
    const threadCh = {
      id: "555555",
      guildId: "guild-1",
      isTextBased: () => true,
      isSendable: () => true,
      isThread: () => true,
      // Has ViewChannel + SendMessages, but missing SendMessagesInThreads
      permissionsFor: () => makePerms([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]),
    };
    let created = false;
    const replies: unknown[] = [];
    await handleReminderHubModal(
      {
        customId: "reminder_modal:reminder",
        guild: {
          id: "guild-1",
          members: { me: { id: "bot-1" } },
          channels: { cache: new Map([["555555", threadCh]]), fetch: async () => threadCh },
        },
        user: { id: "user-1" },
        fields: { getTextInputValue: (k: string) => fieldsMap[k] ?? "" },
        deferReply: async () => undefined,
        editReply: async (p: unknown) => {
          replies.push(p);
        },
      } as never,
      ctx as never,
      {
        createReminderHubEntry: async () => {
          created = true;
          return "new-id";
        },
      },
    );
    assert.equal(created, false);
    assert.match(JSON.stringify(replies[0]), /Bot がこのチャンネルに投稿できません（権限: SendMessagesInThreads）/);
  }

  // 3. guild.members.me missing -> tries fetchMe(); if fetchMe() returns member, checks permissions; if fetchMe() fails, logs warn and allows save
  {
    let fetchMeCalls = 0;
    const ch = {
      id: "555555",
      guildId: "guild-1",
      isTextBased: () => true,
      isSendable: () => true,
      isThread: () => false,
      permissionsFor: () => makePerms([]),
    };
    const ctxOkFetchMe = {
      log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
    };
    let createdOnFetchMe = false;
    const repliesFetchMe: unknown[] = [];
    await handleReminderHubModal(
      {
        customId: "reminder_modal:reminder",
        guild: {
          id: "guild-1",
          members: {
            me: null,
            fetchMe: async () => {
              fetchMeCalls += 1;
              return { id: "bot-1" };
            },
          },
          channels: { cache: new Map([["555555", ch]]), fetch: async () => ch },
        },
        user: { id: "user-1" },
        fields: { getTextInputValue: (k: string) => fieldsMap[k] ?? "" },
        deferReply: async () => undefined,
        editReply: async (p: unknown) => {
          repliesFetchMe.push(p);
        },
      } as never,
      ctxOkFetchMe as never,
      {
        createReminderHubEntry: async () => {
          createdOnFetchMe = true;
          return "new-id";
        },
      },
    );
    assert.equal(fetchMeCalls, 1);
    assert.equal(createdOnFetchMe, false);
    assert.match(JSON.stringify(repliesFetchMe[0]), /ViewChannel, SendMessages/);

    // fetchMe throws -> logs warn and permits save
    const warns: unknown[][] = [];
    let createdWhenFetchMeFails = false;
    await handleReminderHubModal(
      {
        customId: "reminder_modal:reminder",
        guild: {
          id: "guild-1",
          members: {
            me: null,
            fetchMe: async () => {
              throw new Error("network error");
            },
          },
          channels: { cache: new Map([["555555", ch]]), fetch: async () => ch },
        },
        user: { id: "user-1" },
        fields: { getTextInputValue: (k: string) => fieldsMap[k] ?? "" },
        deferReply: async () => undefined,
        editReply: async () => undefined,
      } as never,
      {
        log: {
          debug: () => undefined,
          info: () => undefined,
          warn: (...args: unknown[]) => {
            warns.push(args);
          },
          error: () => undefined,
        },
      } as never,
      {
        createReminderHubEntry: async () => {
          createdWhenFetchMeFails = true;
          return "new-id";
        },
      },
    );
    assert.equal(createdWhenFetchMeFails, true);
    assert.equal(warns.length, 1);
  }
});

test("updateReminderHubContentAndChannel updates body, fire_at, data, and channel_id in a single UPDATE", async () => {
  let updateCalls = 0;
  let patchedValues: Record<string, unknown> | undefined;
  const existingRow = makeReminderRow("rem-atomic-edit", "ch-old", null, "2026-01-01T00:00:00.000Z");

  const fakeDb = {
    selectFrom: () => {
      const builder = {
        selectAll: () => builder,
        where: () => builder,
        executeTakeFirst: async () => existingRow,
      };
      return builder;
    },
    updateTable: () => {
      updateCalls += 1;
      const builder = {
        set: (values: Record<string, unknown>) => {
          patchedValues = values;
          return builder;
        },
        where: () => builder,
        executeTakeFirst: async () => ({ numUpdatedRows: 1n }),
      };
      return builder;
    },
  };

  const updated = await updateReminderHubContentAndChannel(
    {} as never,
    {
      guildId: "guild-1",
      authorId: "user-1",
      id: existingRow.id,
      title: "new-title",
      body: "new-body",
      fireAt: new Date("2026-01-02T00:00:00.000Z"),
      recurrence: { interval_sec: 1800 },
      channelId: "ch-new",
    },
    fakeDb as never,
  );

  assert.equal(updated, 1);
  assert.equal(updateCalls, 1);
  assert.equal(patchedValues?.body, "new-body");
  assert.equal(patchedValues?.fire_at, "2026-01-02T00:00:00.000Z");
  assert.equal(patchedValues?.channel_id, "ch-new");
  assert.deepEqual(JSON.parse(String(patchedValues?.data)), {
    ev_type: "reminder",
    title: "new-title",
    recurrence: { interval_sec: 1800 },
  });
});

test("rem_manage_channel_pick rejects unsendable or missing-permission channels without saving", async () => {
  const ctx = {
    log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
  };
  const current = {
    id: "rem-ch-perm",
    ev_type: "reminder" as const,
    title: "keep-title",
    body: "keep-body",
    channel_id: "111111",
    author_id: "user-1",
    fire_at: "2026-01-01T00:00:00.000Z",
    status: "pending",
    recurrence_json: null,
  };

  // 1. Not sendable channel -> does not call updateReminderHubChannel, renders V2 detail panel with error notice
  {
    let updateCalled = false;
    const editReplies: unknown[] = [];
    const nonSendableCh = {
      id: "222222",
      guildId: "guild-1",
      isTextBased: () => false,
      isSendable: () => false,
    };
    const handled = await handleReminderHubChannelSelect(
      {
        customId: `rem_manage_channel_pick:${current.id}`,
        guild: {
          id: "guild-1",
          members: { me: { id: "bot-1" } },
          channels: { cache: new Map([["222222", nonSendableCh]]), fetch: async () => nonSendableCh },
        },
        user: { id: "user-1" },
        values: ["222222"],
        deferUpdate: async () => undefined,
        editReply: async (payload: unknown) => {
          editReplies.push(payload);
        },
      } as never,
      ctx as never,
      {
        getActiveForAuthor: async () => current,
        updateReminderHubChannel: async () => {
          updateCalled = true;
          return 1;
        },
      },
    );
    assert.equal(handled, true);
    assert.equal(updateCalled, false);
    assert.equal(editReplies.length, 1);
    assert.match(JSON.stringify(editReplies[0]), /このサーバー内の送信可能なテキストチャンネルを指定してください/);
    assert.match(JSON.stringify(editReplies[0]), /keep-title/);
  }

  // 2. Missing SendMessages permission -> does not call updateReminderHubChannel, displays missing permissions
  {
    let updateCalled = false;
    const editReplies: unknown[] = [];
    const noPermCh = {
      id: "333333",
      guildId: "guild-1",
      isTextBased: () => true,
      isSendable: () => true,
      isThread: () => false,
      permissionsFor: () => ({ has: (flag: bigint) => flag === PermissionFlagsBits.ViewChannel }),
    };
    const handled = await handleReminderHubChannelSelect(
      {
        customId: `rem_manage_channel_pick:${current.id}`,
        guild: {
          id: "guild-1",
          members: { me: { id: "bot-1" } },
          channels: { cache: new Map([["333333", noPermCh]]), fetch: async () => noPermCh },
        },
        user: { id: "user-1" },
        values: ["333333"],
        deferUpdate: async () => undefined,
        editReply: async (payload: unknown) => {
          editReplies.push(payload);
        },
      } as never,
      ctx as never,
      {
        getActiveForAuthor: async () => current,
        updateReminderHubChannel: async () => {
          updateCalled = true;
          return 1;
        },
      },
    );
    assert.equal(handled, true);
    assert.equal(updateCalled, false);
    assert.equal(editReplies.length, 1);
    assert.match(JSON.stringify(editReplies[0]), /Bot がこのチャンネルに投稿できません（権限: SendMessages）/);
    assert.match(JSON.stringify(editReplies[0]), /keep-title/);
  }
});

test("rem_manage_channel_pick applies pending dispatch update first, blocks when already sent or apply fails, and updates recurring when still pending", async () => {
  const ctx = {
    log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
  };
  const sendableCh = {
    id: "999999",
    guildId: "guild-1",
    isTextBased: () => true,
    isSendable: () => true,
    isThread: () => false,
    permissionsFor: () => ({ has: () => true }),
  };
  const makeGuild = () => ({
    id: "guild-1",
    members: { me: { id: "bot-1" } },
    channels: { cache: new Map([["999999", sendableCh]]), fetch: async () => sendableCh },
  });

  // 1. Single reminder with pending delivered DB update -> applied first -> becomes fired -> rejects with already-sent V2 panel
  {
    const row = makeReminderRow("rem-ch-pending-single", "111111", null, "2026-01-01T00:00:30.000Z");
    recordPendingDispatchUpdate(row, false, "delivered", null);
    let dbStatus = "pending";
    let channelUpdated = false;
    const editReplies: unknown[] = [];
    const interaction = {
      customId: `rem_manage_channel_pick:${row.id}`,
      guild: makeGuild(),
      user: { id: "user-1" },
      values: ["999999"],
      deferUpdate: async () => undefined,
      editReply: async (payload: unknown) => {
        editReplies.push(payload);
      },
    };
    try {
      await handleReminderHubChannelSelect(interaction as never, ctx as never, {
        now: () => Date.parse("2026-01-01T00:01:00.000Z"),
        getActiveForAuthor: async () =>
          dbStatus === "pending"
            ? {
                id: row.id,
                ev_type: "reminder",
                title: "old",
                body: "old",
                channel_id: "111111",
                author_id: "user-1",
                fire_at: row.fire_at,
                status: dbStatus,
                recurrence_json: null,
              }
            : null,
        applyDispatchResult: async () => {
          dbStatus = "fired";
          return { updated: 1, recurring: false, nextFireAt: null };
        },
        updateReminderHubChannel: async () => {
          channelUpdated = true;
          return 1;
        },
        listActiveByType: async () => [],
      });
      assert.equal(hasPendingDispatchUpdate(row.id), false);
      assert.equal(channelUpdated, false);
      assert.equal(editReplies.length, 1);
      assert.match(JSON.stringify(editReplies[0]), /このリマインダーはすでに送信済みです/);
    } finally {
      clearPendingDispatchUpdate(row.id);
    }
  }

  // 2. Pending dispatch update fails -> does not update channel and shows retry notice on V2 panel
  {
    const row = makeReminderRow("rem-ch-pending-fail", "111111", { interval_sec: 3600 }, "2026-01-01T00:00:00.000Z");
    recordPendingDispatchUpdate(row, false, "delivered", "2026-01-01T01:00:00.000Z");
    let channelUpdated = false;
    const editReplies: unknown[] = [];
    const interaction = {
      customId: `rem_manage_channel_pick:${row.id}`,
      guild: makeGuild(),
      user: { id: "user-1" },
      values: ["999999"],
      deferUpdate: async () => undefined,
      editReply: async (payload: unknown) => {
        editReplies.push(payload);
      },
    };
    try {
      await handleReminderHubChannelSelect(interaction as never, ctx as never, {
        now: () => Date.parse("2026-01-01T00:05:00.000Z"),
        getActiveForAuthor: async () => ({
          id: row.id,
          ev_type: "reminder",
          title: "keep-title",
          body: "old",
          channel_id: "111111",
          author_id: "user-1",
          fire_at: row.fire_at,
          status: "pending",
          recurrence_json: JSON.stringify({ interval_sec: 3600 }),
        }),
        applyDispatchResult: async () => {
          throw new Error("db still down");
        },
        updateReminderHubChannel: async () => {
          channelUpdated = true;
          return 1;
        },
        listActiveByType: async () => [],
      });
      assert.equal(hasPendingDispatchUpdate(row.id), true);
      assert.equal(channelUpdated, false);
      assert.equal(editReplies.length, 1);
      assert.match(JSON.stringify(editReplies[0]), /送信処理の反映中のため、少し待ってから再度お試しください/);
      assert.match(JSON.stringify(editReplies[0]), /keep-title/);
    } finally {
      clearPendingDispatchUpdate(row.id);
    }
  }

  // 3. Recurring reminder with pending delivered DB update -> applied first -> remains pending -> channel change succeeds
  {
    const row = makeReminderRow("rem-ch-pending-rec", "111111", { interval_sec: 3600 }, "2026-01-01T00:00:00.000Z");
    recordPendingDispatchUpdate(row, false, "delivered", "2026-01-01T01:00:00.000Z");
    let currentFireAt = row.fire_at;
    let currentChannelId = "111111";
    let channelUpdated = false;
    const editReplies: unknown[] = [];
    const interaction = {
      customId: `rem_manage_channel_pick:${row.id}`,
      guild: makeGuild(),
      user: { id: "user-1" },
      values: ["999999"],
      deferUpdate: async () => undefined,
      editReply: async (payload: unknown) => {
        editReplies.push(payload);
      },
    };
    try {
      await handleReminderHubChannelSelect(interaction as never, ctx as never, {
        now: () => Date.parse("2026-01-01T00:05:00.000Z"),
        getActiveForAuthor: async () => ({
          id: row.id,
          ev_type: "reminder",
          title: "rec-title",
          body: "old",
          channel_id: currentChannelId,
          author_id: "user-1",
          fire_at: currentFireAt,
          status: "pending",
          recurrence_json: JSON.stringify({ interval_sec: 3600 }),
        }),
        applyDispatchResult: async (_ctx, _r, _forceNow, _db, fixedNextFireAt) => {
          currentFireAt = fixedNextFireAt ?? "2026-01-01T01:00:00.000Z";
          return { updated: 1, recurring: true, nextFireAt: currentFireAt };
        },
        updateReminderHubChannel: async (_ctx, _g, _u, _id, chId) => {
          channelUpdated = true;
          currentChannelId = chId;
          return 1;
        },
        listActiveByType: async () => [],
      });
      assert.equal(hasPendingDispatchUpdate(row.id), false);
      assert.equal(channelUpdated, true);
      assert.equal(currentChannelId, "999999");
      assert.equal(currentFireAt, "2026-01-01T01:00:00.000Z");
      assert.equal(editReplies.length, 1);
      assert.match(JSON.stringify(editReplies[0]), /投稿先を <#999999> に変更しました/);
    } finally {
      clearPendingDispatchUpdate(row.id);
    }
  }
});

test("rem_manage_edit opens modal with sentinel 0 when fire_at is unparseable, and modal submit with modalFireAtMs === 0 skips rewind check and uses user input", async () => {
  const ctx = {
    log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
  };
  const rowId = "rem-unparseable-fire-at";

  // 1. Edit button opens modal with customId ending in :0
  {
    let shownModal: { toJSON(): unknown } | null = null;
    const buttonInteraction = {
      customId: `rem_manage_edit:${rowId}`,
      guild: { id: "guild-1" },
      user: { id: "user-1" },
      showModal: async (modal: { toJSON(): unknown }) => {
        shownModal = modal;
      },
      reply: async () => {
        throw new Error("should not reply with error for unparseable fire_at");
      },
    };
    const handled = await handleReminderHubButton(buttonInteraction as never, ctx as never, {
      getActiveForAuthor: async () => ({
        id: rowId,
        ev_type: "reminder",
        title: "legacy",
        body: "legacy body",
        channel_id: "999999",
        author_id: "user-1",
        fire_at: "not-a-valid-date",
        status: "pending",
        recurrence_json: null,
      }),
    });
    assert.equal(handled, true);
    assert.ok(shownModal);
    const json = (shownModal as { toJSON(): { custom_id?: string } }).toJSON();
    assert.equal(json.custom_id, `rem_manage_edit_modal:${rowId}:0`);
  }

  // 2. Modal submit with sentinel :0 skips rewind check and adopts user-entered due_at
  {
    let savedFireAtIso: string | null = null;
    const userDueIso = "2026-05-01T12:00:00.000Z";
    const fieldsMap: Record<string, string> = {
      title: "fixed title",
      body: "fixed body",
      due_at: userDueIso,
      recurrence: "",
      channel_id: "999999",
    };
    const editReplies: unknown[] = [];
    const modalInteraction = {
      customId: `rem_manage_edit_modal:${rowId}:0`,
      guild: { id: "guild-1", channels: { cache: new Map(), fetch: async () => null } },
      user: { id: "user-1" },
      fields: { getTextInputValue: (key: string) => fieldsMap[key] ?? "" },
      deferReply: async () => undefined,
      editReply: async (payload: unknown) => {
        editReplies.push(payload);
      },
      reply: async () => {
        throw new Error("should not reject sentinel :0 as legacy customId");
      },
    };
    const handled = await handleReminderHubModal(modalInteraction as never, ctx as never, {
      getActiveForAuthor: async () => ({
        id: rowId,
        ev_type: "reminder",
        title: "legacy",
        body: "legacy body",
        channel_id: "999999",
        author_id: "user-1",
        // Even if DB row has a different valid fire_at, sentinel 0 must skip rewind prevention
        fire_at: "2026-06-01T00:00:00.000Z",
        status: "pending",
        recurrence_json: null,
      }),
      updateReminderHubContentAndChannel: async (_ctx, input) => {
        savedFireAtIso = input.fireAt.toISOString();
        return 1;
      },
      listActiveByType: async () => [],
    });
    assert.equal(handled, true);
    assert.equal(savedFireAtIso, userDueIso);
    assert.equal(editReplies.length, 1);
    assert.match(JSON.stringify(editReplies[0]), /更新しました/);
  }
});

test("channel change and edit modal clear recurringPermanentSkipWarned on success", async () => {
  const ctx = {
    log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
  };
  const sendableCh = {
    id: "999999",
    guildId: "guild-1",
    isTextBased: () => true,
    isSendable: () => true,
    isThread: () => false,
    permissionsFor: () => ({ has: () => true }),
  };
  const makeGuild = () => ({
    id: "guild-1",
    members: { me: { id: "bot-1" } },
    channels: { cache: new Map([["999999", sendableCh]]), fetch: async () => sendableCh },
  });

  // 1. Channel change clears recurringPermanentSkipWarned
  {
    const rowId = "rem-ch-clear-warn";
    markRecurringPermanentSkipWarned(rowId);
    let currentChannelId = "111111";
    const interaction = {
      customId: `rem_manage_channel_pick:${rowId}`,
      guild: makeGuild(),
      user: { id: "user-1" },
      values: ["999999"],
      deferUpdate: async () => undefined,
      editReply: async () => undefined,
    };
    try {
      await handleReminderHubChannelSelect(interaction as never, ctx as never, {
        getActiveForAuthor: async () => ({
          id: rowId,
          ev_type: "reminder",
          title: "rec",
          body: "body",
          channel_id: currentChannelId,
          author_id: "user-1",
          fire_at: "2026-01-01T00:00:00.000Z",
          status: "pending",
          recurrence_json: JSON.stringify({ interval_sec: 3600 }),
        }),
        updateReminderHubChannel: async (_ctx, _g, _u, _id, chId) => {
          currentChannelId = chId;
          return 1;
        },
        listActiveByType: async () => [],
      });
      assert.equal(hasRecurringPermanentSkipWarned(rowId), false);
    } finally {
      clearRecurringPermanentSkipWarned(rowId);
    }
  }

  // 2. Edit modal clears recurringPermanentSkipWarned
  {
    const rowId = "rem-edit-clear-warn";
    const fireAt = "2026-01-01T00:00:00.000Z";
    markRecurringPermanentSkipWarned(rowId);
    const fieldsMap: Record<string, string> = {
      title: "edited",
      body: "edited body",
      due_at: fireAt,
      recurrence: "1h",
      channel_id: "999999",
    };
    const interaction = {
      customId: `rem_manage_edit_modal:${rowId}:${Date.parse(fireAt)}`,
      guild: makeGuild(),
      user: { id: "user-1" },
      fields: { getTextInputValue: (key: string) => fieldsMap[key] ?? "" },
      deferReply: async () => undefined,
      editReply: async () => undefined,
    };
    try {
      await handleReminderHubModal(interaction as never, ctx as never, {
        getActiveForAuthor: async () => ({
          id: rowId,
          ev_type: "reminder",
          title: "rec",
          body: "body",
          channel_id: "111111",
          author_id: "user-1",
          fire_at: fireAt,
          status: "pending",
          recurrence_json: JSON.stringify({ interval_sec: 3600 }),
        }),
        updateReminderHubContentAndChannel: async () => 1,
        listActiveByType: async () => [],
      });
      assert.equal(hasRecurringPermanentSkipWarned(rowId), false);
    } finally {
      clearRecurringPermanentSkipWarned(rowId);
    }
  }
});

test("channel change and edit modal show cancelled notice when pending dispatch update action is cancel", async () => {
  const ctx = {
    log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
  };
  const sendableCh = {
    id: "999999",
    guildId: "guild-1",
    isTextBased: () => true,
    isSendable: () => true,
    isThread: () => false,
    permissionsFor: () => ({ has: () => true }),
  };
  const makeGuild = () => ({
    id: "guild-1",
    members: { me: { id: "bot-1" } },
    channels: { cache: new Map([["999999", sendableCh]]), fetch: async () => sendableCh },
  });

  // 1. Channel change with pending cancel action
  {
    const row = makeReminderRow("rem-ch-pending-cancel", "111111", null, "2026-01-01T00:00:30.000Z");
    recordPendingDispatchUpdate(row, false, "cancel");
    let dbStatus = "pending";
    let channelUpdated = false;
    const editReplies: unknown[] = [];
    const interaction = {
      customId: `rem_manage_channel_pick:${row.id}`,
      guild: makeGuild(),
      user: { id: "user-1" },
      values: ["999999"],
      deferUpdate: async () => undefined,
      editReply: async (payload: unknown) => {
        editReplies.push(payload);
      },
    };
    try {
      await handleReminderHubChannelSelect(interaction as never, ctx as never, {
        getActiveForAuthor: async () =>
          dbStatus === "pending"
            ? {
                id: row.id,
                ev_type: "reminder",
                title: "old",
                body: "old",
                channel_id: "111111",
                author_id: "user-1",
                fire_at: row.fire_at,
                status: dbStatus,
                recurrence_json: null,
              }
            : null,
        cancelUndeliverableReminder: async () => {
          dbStatus = "cancelled";
          return 1;
        },
        updateReminderHubChannel: async () => {
          channelUpdated = true;
          return 1;
        },
        listActiveByType: async () => [],
      });
      assert.equal(hasPendingDispatchUpdate(row.id), false);
      assert.equal(channelUpdated, false);
      assert.equal(editReplies.length, 1);
      assert.match(JSON.stringify(editReplies[0]), /このリマインダーは送信できなかったため取り消されました/);
      assert.doesNotMatch(JSON.stringify(editReplies[0]), /すでに送信済み/);
    } finally {
      clearPendingDispatchUpdate(row.id);
    }
  }

  // 2. Edit modal with pending cancel action
  {
    const row = makeReminderRow("rem-edit-pending-cancel", "999999", null, "2026-01-01T00:00:30.000Z");
    recordPendingDispatchUpdate(row, false, "cancel");
    let dbStatus = "pending";
    let contentUpdated = false;
    const editReplies: unknown[] = [];
    const fieldsMap: Record<string, string> = {
      title: "edited title",
      body: "edited body",
      due_at: "2026-01-01T00:00:00.000Z",
      recurrence: "",
      channel_id: "999999",
    };
    const interaction = {
      customId: `rem_manage_edit_modal:${row.id}:${Date.parse(row.fire_at)}`,
      guild: makeGuild(),
      user: { id: "user-1" },
      fields: { getTextInputValue: (key: string) => fieldsMap[key] ?? "" },
      deferReply: async () => undefined,
      editReply: async (payload: unknown) => {
        editReplies.push(payload);
      },
    };
    try {
      await handleReminderHubModal(interaction as never, ctx as never, {
        getActiveForAuthor: async () =>
          dbStatus === "pending"
            ? {
                id: row.id,
                ev_type: "reminder",
                title: "old",
                body: "old",
                channel_id: "999999",
                author_id: "user-1",
                fire_at: row.fire_at,
                status: dbStatus,
                recurrence_json: null,
              }
            : null,
        cancelUndeliverableReminder: async () => {
          dbStatus = "cancelled";
          return 1;
        },
        updateReminderHubContentAndChannel: async () => {
          contentUpdated = true;
          return 1;
        },
        listActiveByType: async () => [],
      });
      assert.equal(hasPendingDispatchUpdate(row.id), false);
      assert.equal(contentUpdated, false);
      assert.equal(editReplies.length, 1);
      assert.match(JSON.stringify(editReplies[0]), /このリマインダーは送信できなかったため取り消されました/);
      assert.doesNotMatch(JSON.stringify(editReplies[0]), /すでに送信済み/);
    } finally {
      clearPendingDispatchUpdate(row.id);
    }
  }
});

test("checkSendableGuildChannel classifies channel fetch errors into not_sendable, missing_permissions, and temporary_error without saving", async () => {
  const fieldsMap: Record<string, string> = {
    title: "title",
    body: "body",
    due_at: "2026-01-02T00:00:00.000Z",
    recurrence: "",
    channel_id: "555555",
  };

  const cases: Array<{
    name: string;
    err: Error;
    expectedPattern: RegExp;
    expectWarn: boolean;
  }> = [
    {
      name: "10003 Unknown Channel -> not_sendable",
      err: Object.assign(new Error("Unknown Channel"), { code: 10_003, status: 404 }),
      expectedPattern: /このサーバー内の送信可能なテキストチャンネルを指定してください。/,
      expectWarn: false,
    },
    {
      name: "404 Not Found -> not_sendable",
      err: Object.assign(new Error("Not Found"), { status: 404 }),
      expectedPattern: /このサーバー内の送信可能なテキストチャンネルを指定してください。/,
      expectWarn: false,
    },
    {
      name: "50001 Missing Access -> missing_permissions (ViewChannel)",
      err: Object.assign(new Error("Missing Access"), { code: 50_001, status: 403 }),
      expectedPattern: /Bot がこのチャンネルに投稿できません（権限: ViewChannel）/,
      expectWarn: false,
    },
    {
      name: "50013 Missing Permissions -> missing_permissions (ViewChannel)",
      err: Object.assign(new Error("Missing Permissions"), { code: 50_013, status: 403 }),
      expectedPattern: /Bot がこのチャンネルに投稿できません（権限: ViewChannel）/,
      expectWarn: false,
    },
    {
      name: "403 Forbidden -> missing_permissions (ViewChannel)",
      err: Object.assign(new Error("Forbidden"), { status: 403 }),
      expectedPattern: /Bot がこのチャンネルに投稿できません（権限: ViewChannel）/,
      expectWarn: false,
    },
    {
      name: "503 Service Unavailable -> temporary_error",
      err: Object.assign(new Error("Service Unavailable"), { status: 503 }),
      expectedPattern: /Discord との通信に失敗しました。少し待ってから再度お試しください。/,
      expectWarn: true,
    },
    {
      name: "429 Too Many Requests -> temporary_error",
      err: Object.assign(new Error("Too Many Requests"), { status: 429 }),
      expectedPattern: /Discord との通信に失敗しました。少し待ってから再度お試しください。/,
      expectWarn: true,
    },
    {
      name: "network error -> temporary_error",
      err: new Error("ECONNRESET"),
      expectedPattern: /Discord との通信に失敗しました。少し待ってから再度お試しください。/,
      expectWarn: true,
    },
  ];

  for (const tc of cases) {
    const warns: unknown[][] = [];
    const ctx = {
      log: {
        debug: () => undefined,
        info: () => undefined,
        warn: (...args: unknown[]) => {
          warns.push(args);
        },
        error: () => undefined,
      },
    };
    const guild = {
      id: "guild-1",
      members: { me: { id: "bot-1" } },
      channels: {
        cache: new Map(),
        fetch: async () => {
          throw tc.err;
        },
      },
    };

    // Create modal
    let created = false;
    const createReplies: unknown[] = [];
    await handleReminderHubModal(
      {
        customId: "reminder_modal:reminder",
        guild,
        user: { id: "user-1" },
        fields: { getTextInputValue: (k: string) => fieldsMap[k] ?? "" },
        deferReply: async () => undefined,
        editReply: async (p: unknown) => {
          createReplies.push(p);
        },
      } as never,
      ctx as never,
      {
        createReminderHubEntry: async () => {
          created = true;
          return "new-id";
        },
      },
    );
    assert.equal(created, false, tc.name);
    assert.equal(createReplies.length, 1, tc.name);
    assert.match(JSON.stringify(createReplies[0]), tc.expectedPattern, tc.name);
    assert.equal(warns.length, tc.expectWarn ? 1 : 0, tc.name);

    // Channel select
    let updated = false;
    const selectReplies: unknown[] = [];
    await handleReminderHubChannelSelect(
      {
        customId: "rem_manage_channel_pick:rem-fetch-err",
        guild,
        user: { id: "user-1" },
        values: ["555555"],
        deferUpdate: async () => undefined,
        editReply: async (p: unknown) => {
          selectReplies.push(p);
        },
      } as never,
      ctx as never,
      {
        getActiveForAuthor: async () => ({
          id: "rem-fetch-err",
          ev_type: "reminder",
          title: "old",
          body: "old",
          channel_id: "111111",
          author_id: "user-1",
          fire_at: "2026-01-01T00:00:00.000Z",
          status: "pending",
          recurrence_json: null,
        }),
        updateReminderHubChannel: async () => {
          updated = true;
          return 1;
        },
        listActiveByType: async () => [],
      },
    );
    assert.equal(updated, false, tc.name);
    assert.equal(selectReplies.length, 1, tc.name);
    assert.match(JSON.stringify(selectReplies[0]), tc.expectedPattern, tc.name);
  }
});

test("handleReminderHubModal create catches errors after deferReply, replies with save failure message, and logs if editReply also fails", async () => {
  const sendableChannel = {
    id: "999999",
    guildId: "guild-1",
    isTextBased: () => true,
    isSendable: () => true,
  };
  const fieldsMap: Record<string, string> = {
    title: "new title",
    body: "new body",
    due_at: "2026-01-02T00:00:00.000Z",
    recurrence: "",
    channel_id: "999999",
  };

  // Case 1: createEntry fails after deferReply -> logs error and edits ephemeral reply with save failure message
  {
    const loggedErrors: unknown[][] = [];
    const editReplies: unknown[] = [];
    const ctx = {
      log: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: (...args: unknown[]) => {
          loggedErrors.push(args);
        },
      },
    };
    const interaction = {
      customId: "reminder_modal:reminder",
      guild: {
        id: "guild-1",
        channels: { cache: new Map([["999999", sendableChannel]]), fetch: async () => sendableChannel },
      },
      user: { id: "user-1" },
      fields: { getTextInputValue: (key: string) => fieldsMap[key] ?? "" },
      deferReply: async () => undefined,
      editReply: async (payload: unknown) => {
        editReplies.push(payload);
      },
    };
    const handled = await handleReminderHubModal(interaction as never, ctx as never, {
      createReminderHubEntry: async () => {
        throw new Error("db insert failed");
      },
    });
    assert.equal(handled, true);
    assert.equal(editReplies.length, 1);
    assert.match(JSON.stringify(editReplies[0]), /保存に失敗しました。時間をおいて再度お試しください。/);
    assert.equal(loggedErrors.length, 1);
  }

  // Case 2: Both final editReply and fallback editReply fail -> does not throw, logs both errors
  {
    const loggedErrors: unknown[][] = [];
    const ctx = {
      log: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: (...args: unknown[]) => {
          loggedErrors.push(args);
        },
      },
    };
    const interaction = {
      customId: "reminder_modal:reminder",
      guild: {
        id: "guild-1",
        channels: { cache: new Map([["999999", sendableChannel]]), fetch: async () => sendableChannel },
      },
      user: { id: "user-1" },
      fields: { getTextInputValue: (key: string) => fieldsMap[key] ?? "" },
      deferReply: async () => undefined,
      editReply: async () => {
        throw new Error("editReply failed");
      },
    };
    const handled = await handleReminderHubModal(interaction as never, ctx as never, {
      createReminderHubEntry: async () => "created-id-1",
    });
    assert.equal(handled, true);
    assert.equal(loggedErrors.length, 2);
  }
});
