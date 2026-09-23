import type { Kysely } from "kysely";
import type { Database } from "../../core/db/types.js";
import { nowIso } from "../../core/db/nowIso.js";

export type OpenPollFlow<T> = {
  id: string;
  guildId: string;
  status: string;
  messageId: string | null;
  state: T;
  /** CAS の比較対象。polls の state 更新成功時に必ず1増える。 */
  stateRevision: number;
  rawState: unknown;
  updatedAt: Date;
};

export type PollStateCas<T> = {
  id: string;
  expectedPhase: string;
  expectedRevision: number;
  /** findOpen が返した値をそのまま渡す。revision と併せて古い状態の巻戻しを防ぐ。 */
  expectedRawState?: unknown;
  nextState: T;
  messageId?: string | null;
  status?: string;
};

export type VoteMergeInput<T extends { phase: string }> = {
  id: string;
  kind: string;
  expectedPhase: string;
  parse: (value: unknown) => T | null;
  canMerge?: (state: T) => boolean;
  merge: (state: T) => T;
  messageId?: (state: T) => string | null;
};

export type CancelPollFlowInput<T extends { phase: string }> = {
  id: string;
  kind: string;
  expectedPhase: string;
  parse: (value: unknown) => T | null;
  /** タイマーが既に読んだ状態を渡す。再読込みでclaim済み状態を終端化しない。 */
  expected?: Pick<OpenPollFlow<T>, "state" | "stateRevision" | "rawState">;
  /** 管理者処理をclaim済みのフローをtimeout/cancel対象から除外する。 */
  canCancel?: (state: T) => boolean;
};

/**
 * node-postgres は bigint を文字列で返す。CAS のrevisionは安全な整数でなければ
 * 数値演算・比較に使わず、そのフローを更新対象から外す。
 */
export function normalizePollStateRevision(value: unknown): number | null {
  if (typeof value === "bigint") {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return Number(value);
  }
  if (typeof value === "string") {
    if (!/^\d+$/.test(value)) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * polls.state の唯一の更新境界。
 *
 * revision、open status、読取り時のstateを同時に比較することで、投票、期限タイマー、
 * 管理者承認のどれが先に確定しても、遅れて到着した処理が状態を巻き戻さない。
 */
export class PollFlowStateStore {
  constructor(private readonly db: Kysely<Database>) {}

  async findOpen<T>(id: string, kind: string, parse: (value: unknown) => T | null): Promise<OpenPollFlow<T> | null> {
    const row = await this.db
      .selectFrom("polls")
      .select(["id", "guild_id", "status", "message_id", "state", "state_revision", "updated_at"])
      .where("id", "=", id)
      .where("kind", "=", kind)
      .where("status", "=", "open")
      .executeTakeFirst();
    if (!row) return null;
    const stateRevision = normalizePollStateRevision(row.state_revision);
    if (stateRevision === null) return null;
    const rawState = row.state as unknown;
    let parsed: unknown = rawState;
    if (typeof rawState === "string") {
      try { parsed = JSON.parse(rawState); } catch { return null; }
    }
    const state = parse(parsed);
    if (!state) return null;
    return {
      id: row.id,
      guildId: row.guild_id,
      status: row.status,
      messageId: row.message_id,
      state,
      stateRevision,
      rawState,
      updatedAt: row.updated_at,
    };
  }

  async compareAndSwap<T extends { phase: string }>(input: PollStateCas<T>): Promise<boolean> {
    if (normalizePollStateRevision(input.expectedRevision) === null || input.expectedRevision >= Number.MAX_SAFE_INTEGER) return false;
    if (input.expectedRawState !== undefined && phaseOfPollState(input.expectedRawState) !== input.expectedPhase) return false;
    const nextRevision = input.expectedRevision + 1;
    let update = this.db
      .updateTable("polls")
      .set({
        state: JSON.stringify(input.nextState) as unknown as Record<string, unknown>,
        state_revision: nextRevision,
        updated_at: nowIso() as unknown as Date,
        ...(input.messageId === undefined ? {} : { message_id: input.messageId }),
        ...(input.status === undefined ? {} : { status: input.status }),
      })
      .where("id", "=", input.id)
      .where("status", "=", "open")
      .where("state_revision", "=", input.expectedRevision);

    // expectedRawState がある場合は、revision が旧スキーマから手動変更されてもphaseを含む
    // 読取り時状態以外を更新できない。JSONB列の値を読取り時状態と一致させる。
    if (input.expectedRawState !== undefined) {
      update = update.where("state", "=", input.expectedRawState as never);
    }
    const result = await update.executeTakeFirst();
    return result.numUpdatedRows === 1n;
  }

  /**
   * 投票だけは、他ユーザーの票と同時に到着しても最新stateへ一度再マージする。
   * 2回目も競合した場合は呼出元にfalseを返し、UI/外部副作用を行わせない。
   */
  async mergeVoteWithRetry<T extends { phase: string }>(input: VoteMergeInput<T>): Promise<T | null> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const current = await this.findOpen(input.id, input.kind, input.parse);
      if (!current || current.state.phase !== input.expectedPhase) return null;
      if (input.canMerge && !input.canMerge(current.state)) return null;
      const next = input.merge(current.state);
      const updated = await this.compareAndSwap({
        id: input.id,
        expectedPhase: input.expectedPhase,
        expectedRevision: current.stateRevision,
        expectedRawState: current.rawState,
        nextState: next,
        messageId: input.messageId?.(next),
      });
      if (updated) return next;
    }
    return null;
  }

  /** 終端化は現行phaseを読取り、CASに勝った呼出だけが後続のUI/Discord副作用を行う。 */
  async cancelOpenFlow<T extends { phase: string }>(input: CancelPollFlowInput<T>): Promise<T | null> {
    const current = input.expected ?? await this.findOpen(input.id, input.kind, input.parse);
    if (!current || current.state.phase !== input.expectedPhase || (input.canCancel && !input.canCancel(current.state))) return null;
    const next = { ...current.state, phase: "cancelled" } as T;
    const updated = await this.compareAndSwap({
      id: input.id,
      expectedPhase: input.expectedPhase,
      expectedRevision: current.stateRevision,
      expectedRawState: current.rawState,
      nextState: next,
      status: "cancelled",
    });
    return updated ? current.state : null;
  }
}

/** 各フローの state 保存を一つの CAS 境界に通す。 */
export async function saveOpenPollState<T extends { phase: string }>(input: {
  store: PollFlowStateStore;
  id: string;
  kind: string;
  parse: (value: unknown) => T | null;
  nextState: T;
  messageId?: string | null;
  expected?: { state: T; state_revision: number; rawState?: unknown };
}): Promise<boolean> {
  if (input.expected) {
    return input.store.compareAndSwap({
      id: input.id,
      expectedPhase: input.expected.state.phase,
      expectedRevision: input.expected.state_revision,
      expectedRawState: input.expected.rawState ?? input.expected.state,
      nextState: input.nextState,
      messageId: input.messageId,
    });
  }
  const current = await input.store.findOpen(input.id, input.kind, input.parse);
  if (!current) return false;
  return input.store.compareAndSwap({
    id: input.id,
    expectedPhase: current.state.phase,
    expectedRevision: current.stateRevision,
    expectedRawState: current.rawState,
    nextState: input.nextState,
    messageId: input.messageId,
  });
}

/** 管理者操作のclaimをCASで確定する。claim成功者だけが最終Discord操作へ進める。 */
export async function claimPollAdminApproval<T extends { phase: string; admin_button_fired: boolean }>(input: {
  store: PollFlowStateStore;
  id: string;
  state: T;
  stateRevision: number;
  rawState: unknown;
}): Promise<boolean> {
  return input.store.compareAndSwap({
    id: input.id,
    expectedPhase: input.state.phase,
    expectedRevision: input.stateRevision,
    expectedRawState: input.rawState,
    nextState: { ...input.state, admin_button_fired: true },
  });
}

/** claim済み管理者操作の終端化。claim直後のrevision/state以外は終端化しない。 */
export async function commitClaimedPollTerminal<T extends { phase: string; admin_button_fired: boolean }>(input: {
  store: PollFlowStateStore;
  id: string;
  state: T;
  stateRevision: number;
  terminalPhase: "completed" | "cancelled";
}): Promise<boolean> {
  const claimed = { ...input.state, admin_button_fired: true };
  return input.store.compareAndSwap({
    id: input.id,
    expectedPhase: input.state.phase,
    expectedRevision: input.stateRevision + 1,
    expectedRawState: JSON.stringify(claimed),
    nextState: { ...claimed, phase: input.terminalPhase },
    status: input.terminalPhase,
  });
}

function phaseOfPollState(value: unknown): string | null {
  let parsed = value;
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed); } catch { return null; }
  }
  if (!parsed || typeof parsed !== "object") return null;
  const phase = (parsed as { phase?: unknown }).phase;
  return typeof phase === "string" ? phase : null;
}

export type FlowTimerDriver<Handle> = {
  setTimeout(callback: () => void, delayMs: number): Handle;
  clearTimeout(handle: Handle): void;
};

/** フロー種別ごとに対象者の同時実行を防ぐ、プロセス内ロック。 */
export class FlowTargetLocks {
  private readonly keys = new Set<string>();

  acquire(namespace: string, guildId: string, targetId: string): boolean {
    const key = this.key(namespace, guildId, targetId);
    if (this.keys.has(key)) return false;
    this.keys.add(key);
    return true;
  }

  release(namespace: string, guildId: string, targetId: string): void {
    this.keys.delete(this.key(namespace, guildId, targetId));
  }

  has(namespace: string, guildId: string, targetId: string): boolean {
    return this.keys.has(this.key(namespace, guildId, targetId));
  }

  clear(): void {
    this.keys.clear();
  }

  private key(namespace: string, guildId: string, targetId: string): string {
    return JSON.stringify([namespace, guildId, targetId]);
  }
}

/** 全モデレーションフローで共有する対象ロック。namespace でフロー種別を分離する。 */
export const flowTargetLocks = new FlowTargetLocks();

/** flow IDごとに登録できる期限タイマー。再登録時は先行タイマーを必ず解除する。 */
export class FlowDeadlineTimers<Handle> {
  private readonly handles = new Map<string, Handle>();

  constructor(private readonly driver: FlowTimerDriver<Handle>) {}

  schedule(flowId: string, delayMs: number, callback: () => void): void {
    this.clear(flowId);

    const handle: Handle = this.driver.setTimeout(() => {
      if (this.handles.get(flowId) !== handle) return;
      this.handles.delete(flowId);
      callback();
    }, normalizeDelayMs(delayMs));
    this.handles.set(flowId, handle);
  }

  clear(flowId: string): void {
    const handle = this.handles.get(flowId);
    if (handle !== undefined) this.driver.clearTimeout(handle);
    this.handles.delete(flowId);
  }

  has(flowId: string): boolean {
    return this.handles.has(flowId);
  }

  clearAll(): void {
    for (const flowId of this.handles.keys()) this.clear(flowId);
  }
}

/** 再起動復元時の期限までの残り時間。既に期限切れ・不正な値は直ちに実行する。 */
export function remainingDeadlineDelayMs(deadlineMs: number, nowMs = Date.now()): number {
  if (!Number.isFinite(deadlineMs) || !Number.isFinite(nowMs)) return 0;
  return Math.max(0, deadlineMs - nowMs);
}

function normalizeDelayMs(delayMs: number): number {
  return Number.isFinite(delayMs) ? Math.max(0, delayMs) : 0;
}

/** DBの終端状態が確定したときだけ、対応するプロセス内資源を解放する。 */
export type TerminalPersistResult = { ok: true } | { ok: false; error: unknown };

export async function persistTerminalState(
  persist: () => Promise<unknown>,
  cleanup: () => void,
): Promise<TerminalPersistResult> {
  try {
    await persist();
  } catch (error) {
    return { ok: false, error };
  }
  cleanup();
  return { ok: true };
}
