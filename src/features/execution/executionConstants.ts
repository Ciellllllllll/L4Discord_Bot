/** DB `polls.kind` に保存する識別子 */
export const EXECUTION_FLOW_KIND = "execution_flow";

/** DiscordBOTv2 PublicExecution.js の exec_vote: と同型 */
export const EXEC_VOTE_PREFIX = "exec_vote:";

/** DiscordBOTv2 の exec_approval: と同型（approve / deny） */
export const EXEC_APPROVAL_PREFIX = "exec_approval:";

export const EXECUTION_REASON_BASE = "/処刑による処罰";

/**
 * 監査ログ・Detecter のユーザー向け「理由」に載る文言（BOT が自動生成）。
 * `approved_by=` は Detecter の実行者解決用（変更しないこと）。
 */
export function buildExecutionAuditReason(approverUserId: string, detailJa: string): string {
  const text = `${EXECUTION_REASON_BASE}（${detailJa}）。公開処刑フローに基づき管理者が承認。`;
  const suffix = ` approved_by=${approverUserId}`;
  const full = `${text}${suffix}`;
  const max = 512;
  if (full.length <= max) return full;
  const keep = max - suffix.length;
  return `${text.slice(0, Math.max(0, keep))}${suffix}`;
}

/** 第1投票: ボタン表示は 1,2,3（PublicExecution の Action Vote と同じ構造） */
export const POLL1_KEYS = ["1", "2", "3"] as const;
export const POLL1_LABEL: Record<(typeof POLL1_KEYS)[number], string> = {
  "1": "タイムアウト",
  "2": "キック",
  "3": "BAN",
};

/** 第2投票: v2 と同様 60s / 1h / 1d / 1w（4択・ボタンは 1〜4） */
export const POLL2_KEYS = ["1", "2", "3", "4"] as const;
export const POLL2_LABEL: Record<(typeof POLL2_KEYS)[number], string> = {
  "1": "60秒",
  "2": "1時間",
  "3": "1日",
  "4": "1週間",
};

/** v2 mapping と同じ秒数 */
export const POLL2_CHOICE_TO_SECONDS: Record<(typeof POLL2_KEYS)[number], number> = {
  "1": 60,
  "2": 3600,
  "3": 86400,
  "4": 604800,
};

/** Discord GuildMember.timeout 上限（28 日） */
export const DISCORD_TIMEOUT_MAX_MS = 28 * 24 * 60 * 60 * 1000;

export function clampTimeoutMs(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return 60_000;
  return Math.min(ms, DISCORD_TIMEOUT_MAX_MS);
}
