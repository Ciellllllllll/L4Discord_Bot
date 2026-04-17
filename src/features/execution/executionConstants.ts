/** DB `polls.kind` に保存する識別子 */
export const EXECUTION_FLOW_KIND = "execution_flow";

/** Discord Poll の duration（時間）。API 上限に合わせて 1〜168 程度で運用 */
export const EXECUTION_POLL_DURATION_HOURS = 24;

export const EXECUTION_REASON_BASE = "/処刑による処罰";

export function buildExecutionAuditReason(approverUserId: string): string {
  const suffix = ` approved_by=${approverUserId}`;
  const full = `${EXECUTION_REASON_BASE}${suffix}`;
  const max = 512;
  if (full.length <= max) return full;
  return full.slice(0, max);
}

/** Poll 第1段: 表示ラベル（voteCount 照合・同票ブレーク用） */
export const POLL1_LABELS = ["タイムアウト", "キック", "BAN"] as const;
/** 同票時: 先に列挙された候補を優先 */
export const POLL1_TIE_PRIORITY: readonly string[] = [...POLL1_LABELS];

/** Poll 第2段 */
export const POLL2_LABELS = ["60秒", "5分", "1時間", "1日", "1週間"] as const;
/** 同票時: 短い duration を優先（配列先頭ほど短い） */
export const POLL2_TIE_PRIORITY: readonly string[] = [...POLL2_LABELS];

/** ラベル → ミリ秒（Discord タイムアウト上限 28 日で clamp 前） */
export const POLL2_DURATION_MS: Record<string, number> = {
  "60秒": 60_000,
  "5分": 5 * 60_000,
  "1時間": 60 * 60_000,
  "1日": 24 * 60 * 60_000,
  "1週間": 7 * 24 * 60 * 60_000,
};

/** Discord GuildMember.timeout 上限（28 日） */
export const DISCORD_TIMEOUT_MAX_MS = 28 * 24 * 60 * 60 * 1000;

export function clampTimeoutMs(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return 60_000;
  return Math.min(ms, DISCORD_TIMEOUT_MAX_MS);
}

export const EXEC_APPROVE_PREFIX = "exec:approve:";
export const EXEC_REJECT_PREFIX = "exec:reject:";
