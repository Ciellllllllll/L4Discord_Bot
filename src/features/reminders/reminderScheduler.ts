import type { BotContext } from "../../bot/context.js";
import { withReminderDispatchLock } from "./reminderDispatchLock.js";
import {
  clearPendingDispatchUpdate,
  clearRecurringPermanentSkipWarned,
  clearReminderRetryState,
  getBackoffExcludedReminderIds,
  getPendingDispatchUpdateIds,
  getReminderRetryState,
  hasPendingDispatchUpdate,
  hasRecurringPermanentSkipWarned,
  listPendingDispatchUpdates,
  markRecurringPermanentSkipWarned,
  pruneExpiredReminderRetryStates,
  recordPendingDispatchUpdate,
  setReminderRetryState,
  type PendingDispatchUpdate,
} from "./reminderDispatchState.js";
import {
  applyDispatchResult,
  cancelUndeliverableReminder,
  computeNextFireAtForRow,
  fetchDuePending,
  getReminderRowById,
  isRecurringReminder,
} from "./reminderHubRepo.js";
import { sendReminderHubMessage, type ReminderSendResult } from "./reminderHubSend.js";

const MAX_CONSECUTIVE_FAILURES = 5;
const SINGLE_REMINDER_MAX_RETRY_WINDOW_MS = 24 * 60 * 60_000;
const SINGLE_REMINDER_MAX_AGE_AFTER_FIRE_AT_MS = 7 * 24 * 60 * 60_000;
const INITIAL_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 30 * 60_000;
const RETRY_STATE_STALE_MS = MAX_BACKOFF_MS * 2;
const DEFAULT_STOP_TIMEOUT_MS = 10_000;

function resolvePendingRetryNextFireAt(
  pending: PendingDispatchUpdate,
  nowMs: number,
): string | null {
  const saved = pending.nextFireAt;
  if (saved !== null) {
    const savedMs = Date.parse(saved);
    if (Number.isFinite(savedMs) && savedMs > nowMs) {
      return saved;
    }
  }
  const recomputed = computeNextFireAtForRow(pending.row, pending.forceNow, nowMs);
  if (saved === null) return recomputed;
  if (recomputed === null) return saved;
  const savedMs = Date.parse(saved);
  const recomputedMs = Date.parse(recomputed);
  if (!Number.isFinite(savedMs)) return recomputed;
  if (!Number.isFinite(recomputedMs)) return saved;
  return recomputedMs >= savedMs ? recomputed : saved;
}

export type ApplyPendingDispatchUpdateDeps = {
  applyDispatchResult?: typeof applyDispatchResult;
  cancelUndeliverableReminder?: typeof cancelUndeliverableReminder;
  now?: () => number;
};

/**
 * すでに dispatch lock を保持している状態で、指定した pending DB 更新を 1 件適用する。
 */
export async function applyPendingDispatchUpdate(
  ctx: BotContext,
  pending: PendingDispatchUpdate,
  deps: ApplyPendingDispatchUpdateDeps = {},
): Promise<void> {
  if (!hasPendingDispatchUpdate(pending.row.id, pending.fireAt)) {
    return;
  }
  const applyResult = deps.applyDispatchResult ?? applyDispatchResult;
  const cancelUndeliverable = deps.cancelUndeliverableReminder ?? cancelUndeliverableReminder;
  const nowFn = deps.now ?? Date.now;

  if (pending.action === "cancel") {
    const updated = await cancelUndeliverable(ctx, pending.row);
    clearPendingDispatchUpdate(pending.row.id);
    clearReminderRetryState(pending.row.id);
    if (updated === 0) {
      ctx.log.info(
        { reminderId: pending.row.id, channelId: pending.row.channel_id },
        "pending reminder cancel did not update DB because row changed",
      );
    } else {
      ctx.log.warn(
        { reminderId: pending.row.id, channelId: pending.row.channel_id },
        "reminder cancelled after pending DB update retry",
      );
    }
  } else {
    const retryNextFireAt = resolvePendingRetryNextFireAt(pending, nowFn());
    const res = await applyResult(ctx, pending.row, pending.forceNow, undefined, retryNextFireAt);
    clearPendingDispatchUpdate(pending.row.id);
    clearReminderRetryState(pending.row.id);
    if (res.updated === 0) {
      ctx.log.info(
        { reminderId: pending.row.id, channelId: pending.row.channel_id, action: pending.action },
        pending.action === "skip"
          ? "pending recurring reminder skip did not update DB because row changed"
          : "pending reminder DB update skipped because row changed",
      );
    } else if (pending.action === "skip") {
      const logPayload = {
        reminderId: pending.row.id,
        channelId: pending.row.channel_id,
        nextFireAt: res.nextFireAt,
        permanent: Boolean(pending.permanent),
      };
      if (pending.permanent) {
        if (hasRecurringPermanentSkipWarned(pending.row.id)) {
          ctx.log.debug(logPayload, "recurring reminder skipped after pending DB update retry");
        } else {
          markRecurringPermanentSkipWarned(pending.row.id);
          ctx.log.warn(logPayload, "recurring reminder skipped after pending DB update retry");
        }
      } else {
        ctx.log.warn(logPayload, "recurring reminder skipped after pending DB update retry");
      }
    }
  }
}

export type ReminderSchedulerHandle = {
  stop(timeoutMs?: number, log?: Pick<BotContext["log"], "warn">): Promise<void>;
};

function isReminderSchedulerHandle(
  target: ReminderSchedulerHandle | NodeJS.Timeout,
): target is ReminderSchedulerHandle {
  return "stop" in target && typeof target.stop === "function";
}

export async function stopReminderScheduler(
  target: ReminderSchedulerHandle | NodeJS.Timeout,
  log: Pick<BotContext["log"], "warn">,
  clearTimer: (t: NodeJS.Timeout) => void = clearInterval,
  timeoutMs = DEFAULT_STOP_TIMEOUT_MS,
): Promise<void> {
  if (isReminderSchedulerHandle(target)) {
    await target.stop(timeoutMs, log);
    return;
  }
  clearTimer(target);
  const pendingIds = getPendingDispatchUpdateIds();
  if (pendingIds.length > 0) {
    log.warn(
      { count: pendingIds.length, reminderIds: pendingIds },
      "reminder scheduler stopped with pending DB updates",
    );
  }
}

export type ReminderSchedulerDeps = {
  fetchDuePending?: typeof fetchDuePending;
  getReminderRowById?: typeof getReminderRowById;
  sendReminderHubMessage?: typeof sendReminderHubMessage;
  applyDispatchResult?: typeof applyDispatchResult;
  cancelUndeliverableReminder?: typeof cancelUndeliverableReminder;
  now?: () => number;
};

export function startReminderScheduler(
  ctx: BotContext,
  intervalMs = 30_000,
  onTick?: () => void,
  deps: ReminderSchedulerDeps = {},
): ReminderSchedulerHandle {
  const fetchDue = deps.fetchDuePending ?? fetchDuePending;
  const getRowById = deps.getReminderRowById ?? getReminderRowById;
  const sendReminder = deps.sendReminderHubMessage ?? sendReminderHubMessage;
  const applyResult = deps.applyDispatchResult ?? applyDispatchResult;
  const cancelUndeliverable = deps.cancelUndeliverableReminder ?? cancelUndeliverableReminder;
  const nowFn = deps.now ?? Date.now;

  ctx.log.debug({ intervalMs }, "reminder scheduler started");
  let running = false;
  let stopping = false;
  let activeTickPromise: Promise<void> | null = null;

  const timer = setInterval(() => {
    if (stopping) return;
    onTick?.();
    if (running) return;
    running = true;
    const tickPromise = (async () => {
      try {
        const tickNowMs = nowFn();
        pruneExpiredReminderRetryStates(tickNowMs, RETRY_STATE_STALE_MS);

        for (const pending of listPendingDispatchUpdates()) {
          if (stopping) break;
          try {
            await withReminderDispatchLock(pending.row.id, async () => {
              await applyPendingDispatchUpdate(ctx, pending, {
                applyDispatchResult: applyResult,
                cancelUndeliverableReminder: cancelUndeliverable,
                now: nowFn,
              });
            });
          } catch (err) {
            ctx.log.error(
              { err, reminderId: pending.row.id, channelId: pending.row.channel_id, action: pending.action },
              "reminder pending DB update retry failed",
            );
          }
        }

        if (stopping) return;

        const excludeIds = new Set<string>(getBackoffExcludedReminderIds(tickNowMs));
        for (const id of getPendingDispatchUpdateIds()) {
          excludeIds.add(id);
        }
        const rows = await fetchDue(ctx, new Date(tickNowMs).toISOString(), 50, [...excludeIds]);
        let deliveredCount = 0;
        for (const r of rows) {
          if (stopping) break;
          try {
            await withReminderDispatchLock(r.id, async () => {
              if (stopping) return;
              const fresh = await getRowById(ctx, r.id);
              if (!fresh || fresh.status !== "pending") {
                clearReminderRetryState(r.id);
                clearRecurringPermanentSkipWarned(r.id);
                return;
              }
              if (hasPendingDispatchUpdate(fresh.id, fresh.fire_at)) {
                return;
              }
              const currentNowIso = new Date(nowFn()).toISOString();
              if (fresh.fire_at !== r.fire_at || fresh.fire_at > currentNowIso) {
                return;
              }
              if (stopping) return;

              let sendResult: ReminderSendResult;
              try {
                sendResult = await sendReminder(ctx, fresh);
              } catch (err) {
                sendResult = { delivered: false, channelError: err, dmError: undefined, permanent: false };
              }

              if (sendResult.delivered) {
                clearReminderRetryState(fresh.id);
                clearRecurringPermanentSkipWarned(fresh.id);
                const nextFireAt = computeNextFireAtForRow(fresh, false, nowFn());
                try {
                  const applied = await applyResult(ctx, fresh, false, undefined, nextFireAt);
                  if (applied.updated === 0) {
                    ctx.log.info(
                      { reminderId: fresh.id, channelId: fresh.channel_id },
                      "reminder delivered but DB was not updated because row changed during dispatch",
                    );
                  } else {
                    deliveredCount += 1;
                  }
                } catch (applyErr) {
                  recordPendingDispatchUpdate(fresh, false, "delivered", nextFireAt);
                  ctx.log.error(
                    { err: applyErr, reminderId: fresh.id, channelId: fresh.channel_id },
                    "reminder delivered but DB update failed; queued for retry",
                  );
                }
                return;
              }

              const recurring = isRecurringReminder(fresh);
              const prevRetryState = getReminderRetryState(fresh.id);
              const failNowMs = nowFn();
              const failures = (prevRetryState?.failures ?? 0) + 1;
              const firstFailedAtMs = prevRetryState?.firstFailedAtMs ?? failNowMs;
              const fireAtMs = Date.parse(fresh.fire_at);
              // 単発リマインダーの再試行枠は最初の送信失敗時刻（firstFailedAtMs）から24時間とする。
              // prune や再起動で firstFailedAtMs が失われた場合は再試行が延びる側に倒れる（配信を失うより安全）。
              // fire_at から7日を超えた場合は、prevRetryState が存在し連続失敗回数が4以上（今回が5回目以上の失敗）であれば再試行を打ち切る。
              // これにより、長期停止後の短い障害（1〜2回の失敗）では取り消さず、再起動のたびに firstFailedAtMs が失われる場合でも、
              // 1プロセス内で5回連続失敗（バックオフで約15分以上）すれば止まる。
              const retryWindowExpired =
                !recurring
                && (failNowMs - firstFailedAtMs > SINGLE_REMINDER_MAX_RETRY_WINDOW_MS
                  || (Number.isFinite(fireAtMs)
                    && failNowMs - fireAtMs > SINGLE_REMINDER_MAX_AGE_AFTER_FIRE_AT_MS
                    && prevRetryState !== undefined
                    && prevRetryState.failures >= MAX_CONSECUTIVE_FAILURES - 1));
              // 繰り返しリマインダーは自動で cancelled にせず、恒久失敗または一時失敗の連続5回で当該回をスキップする。
              const shouldCancel = !recurring && (sendResult.permanent || retryWindowExpired);
              const shouldSkipRecurring = recurring && (sendResult.permanent || failures >= MAX_CONSECUTIVE_FAILURES);

              if (shouldCancel) {
                try {
                  const updated = await cancelUndeliverable(ctx, fresh);
                  clearReminderRetryState(fresh.id);
                  if (updated === 0) {
                    ctx.log.info(
                      {
                        reminderId: fresh.id,
                        channelId: fresh.channel_id,
                        recurring,
                        failures,
                        permanent: sendResult.permanent,
                        retryWindowExpired,
                      },
                      "reminder cancel did not update DB because row changed during dispatch",
                    );
                  } else {
                    ctx.log.warn(
                      {
                        reminderId: fresh.id,
                        channelId: fresh.channel_id,
                        recurring,
                        failures,
                        permanent: sendResult.permanent,
                        retryWindowExpired,
                        channelError: sendResult.channelError,
                        dmError: sendResult.dmError,
                      },
                      "reminder cancelled after delivery failure",
                    );
                  }
                } catch (cancelErr) {
                  recordPendingDispatchUpdate(fresh, false, "cancel");
                  ctx.log.error(
                    { err: cancelErr, reminderId: fresh.id, channelId: fresh.channel_id, failures },
                    "reminder cancel DB update failed; queued for retry",
                  );
                }
                return;
              }

              if (shouldSkipRecurring) {
                const nextFireAt = computeNextFireAtForRow(fresh, false, failNowMs);
                try {
                  const skipped = await applyResult(ctx, fresh, false, undefined, nextFireAt);
                  clearReminderRetryState(fresh.id);
                  if (skipped.updated === 0) {
                    ctx.log.info(
                      {
                        reminderId: fresh.id,
                        channelId: fresh.channel_id,
                        failures,
                        permanent: sendResult.permanent,
                      },
                      "recurring reminder skip did not update DB because row changed during dispatch",
                    );
                  } else {
                    const skipLogPayload = {
                      reminderId: fresh.id,
                      channelId: fresh.channel_id,
                      failures,
                      permanent: sendResult.permanent,
                      nextFireAt: skipped.nextFireAt,
                      channelError: sendResult.channelError,
                      dmError: sendResult.dmError,
                    };
                    if (sendResult.permanent) {
                      if (hasRecurringPermanentSkipWarned(fresh.id)) {
                        ctx.log.debug(skipLogPayload, "recurring reminder skipped after delivery failure");
                      } else {
                        markRecurringPermanentSkipWarned(fresh.id);
                        ctx.log.warn(skipLogPayload, "recurring reminder skipped after delivery failure");
                      }
                    } else {
                      ctx.log.warn(skipLogPayload, "recurring reminder skipped after delivery failure");
                    }
                  }
                } catch (applyErr) {
                  recordPendingDispatchUpdate(fresh, false, "skip", nextFireAt, sendResult.permanent);
                  ctx.log.error(
                    { err: applyErr, reminderId: fresh.id, channelId: fresh.channel_id, failures },
                    "recurring reminder skip DB update failed; queued for retry",
                  );
                }
                return;
              }

              const backoffMs = Math.min(INITIAL_BACKOFF_MS * 2 ** Math.min(failures - 1, 10), MAX_BACKOFF_MS);
              setReminderRetryState(fresh.id, {
                failures,
                firstFailedAtMs,
                nextRetryAtMs: failNowMs + backoffMs,
              });
              ctx.log.error(
                {
                  channelError: sendResult.channelError,
                  dmError: sendResult.dmError,
                  permanent: sendResult.permanent,
                  recurring,
                  failures,
                  retryAfterMs: backoffMs,
                  reminderId: fresh.id,
                  channelId: fresh.channel_id,
                },
                "reminder delivery failed",
              );
            });
          } catch (err) {
            ctx.log.error({ err, reminderId: r.id, channelId: r.channel_id }, "reminder delivery failed");
          }
        }
        if (deliveredCount > 0) {
          ctx.log.info({ count: deliveredCount }, "reminders delivered");
        }
      } finally {
        running = false;
      }
    })()
      .catch((e) => ctx.log.error({ err: e }, "reminder tick failed"))
      .finally(() => {
        if (activeTickPromise === tickPromise) {
          activeTickPromise = null;
        }
      });
    activeTickPromise = tickPromise;
  }, intervalMs);

  return {
    async stop(timeoutMs = DEFAULT_STOP_TIMEOUT_MS, log: Pick<BotContext["log"], "warn"> = ctx.log): Promise<void> {
      stopping = true;
      clearInterval(timer);
      const inFlight = activeTickPromise;
      let timedOut = false;
      if (inFlight) {
        let timeoutId: NodeJS.Timeout | undefined;
        const timeoutPromise = new Promise<void>((resolve) => {
          timeoutId = setTimeout(() => {
            timedOut = true;
            resolve();
          }, timeoutMs);
          // unref しない。停止処理はこの待機を await しており、ほかに動いているものがないと
          // イベントループが先に空になって待機自体が打ち切られるため
        });
        try {
          await Promise.race([inFlight, timeoutPromise]);
        } finally {
          if (timeoutId !== undefined) clearTimeout(timeoutId);
        }
        if (timedOut) {
          log.warn(
            { timeoutMs },
            "reminder scheduler stop timed out while waiting for active tick; if an in-flight send completes after DB closes, duplicate delivery may occur after restart",
          );
        }
      }
      const pendingIds = getPendingDispatchUpdateIds();
      if (pendingIds.length > 0) {
        if (timedOut) {
          log.warn(
            { count: pendingIds.length, reminderIds: pendingIds, provisional: true },
            "reminder scheduler stopped with pending DB updates (provisional count; active tick still running)",
          );
        } else {
          log.warn(
            { count: pendingIds.length, reminderIds: pendingIds },
            "reminder scheduler stopped with pending DB updates",
          );
        }
      }
    },
  };
}
