/**
 * リマインダーの送信リトライ状態と「送信済み・DB 更新待ち」状態をインメモリで管理する。
 *
 * 配信保証方針（at-least-once）:
 * 「送信済み・DB 更新待ち」はメモリ上のみで保持し永続化しないため、
 * DB 更新完了前にプロセスが再起動すると状態が失われ、再起動後に最大1回の重複送信が発生しうる。
 * シャットダウン時は未反映の更新が残っていれば件数と ID を warn ログへ出力する。
 */
import type { RemindersRow } from "../../core/db/types.js";

export type ReminderRetryState = {
  failures: number;
  firstFailedAtMs: number;
  nextRetryAtMs: number;
};

export type PendingDispatchAction = "delivered" | "skip" | "cancel";

export type PendingDispatchUpdate = {
  row: RemindersRow;
  fireAt: string;
  forceNow: boolean;
  action: PendingDispatchAction;
  nextFireAt: string | null;
  permanent?: boolean;
};

const retryStateById = new Map<string, ReminderRetryState>();
const pendingDispatchUpdatesById = new Map<string, PendingDispatchUpdate>();
const recurringPermanentSkipWarnedIds = new Set<string>();

export function hasRecurringPermanentSkipWarned(id: string): boolean {
  return recurringPermanentSkipWarnedIds.has(id);
}

export function markRecurringPermanentSkipWarned(id: string): void {
  recurringPermanentSkipWarnedIds.add(id);
}

export function clearRecurringPermanentSkipWarned(id: string): void {
  recurringPermanentSkipWarnedIds.delete(id);
}

export function getReminderRetryState(id: string): ReminderRetryState | undefined {
  return retryStateById.get(id);
}

export function setReminderRetryState(id: string, state: ReminderRetryState): void {
  retryStateById.set(id, state);
}

export function clearReminderRetryState(id: string): void {
  retryStateById.delete(id);
}

export function pruneExpiredReminderRetryStates(nowMs: number, maxAgeAfterNextRetryMs: number): void {
  for (const [id, state] of retryStateById) {
    if (nowMs - state.nextRetryAtMs >= maxAgeAfterNextRetryMs) {
      retryStateById.delete(id);
    }
  }
}

export function getBackoffExcludedReminderIds(nowMs: number): string[] {
  const excluded: string[] = [];
  for (const [id, state] of retryStateById) {
    if (state.nextRetryAtMs > nowMs) {
      excluded.push(id);
    }
  }
  return excluded;
}

export function recordPendingDispatchUpdate(
  row: RemindersRow,
  forceNow: boolean,
  action: PendingDispatchAction = "delivered",
  nextFireAt: string | null = null,
  permanent = false,
): void {
  pendingDispatchUpdatesById.set(row.id, {
    row,
    fireAt: row.fire_at,
    forceNow,
    action,
    nextFireAt,
    permanent,
  });
}

export function getPendingDispatchUpdate(id: string): PendingDispatchUpdate | undefined {
  return pendingDispatchUpdatesById.get(id);
}

export function hasPendingDispatchUpdate(id: string, fireAt?: string): boolean {
  const entry = pendingDispatchUpdatesById.get(id);
  if (!entry) return false;
  if (fireAt !== undefined && entry.fireAt !== fireAt) return false;
  return true;
}

export function listPendingDispatchUpdates(): PendingDispatchUpdate[] {
  return [...pendingDispatchUpdatesById.values()];
}

export function getPendingDispatchUpdateIds(): string[] {
  return [...pendingDispatchUpdatesById.keys()];
}

export function clearPendingDispatchUpdate(id: string): void {
  pendingDispatchUpdatesById.delete(id);
}
