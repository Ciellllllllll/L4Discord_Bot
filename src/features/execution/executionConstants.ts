import { buildApprovedAuditReason } from "./pollFlowHelpers.js";

export const EXECUTION_FLOW_KIND = "execution_flow";
export const EXEC_VOTE_PREFIX = "exec_vote:";
export const EXEC_APPROVAL_PREFIX = "exec_approval:";
export const EXECUTION_REASON_BASE = "/処刑による処罰";

// `approved_by=` は Detecter の実行者解決用（変更しないこと）。
export function buildExecutionAuditReason(approverUserId: string, detailJa: string): string {
  return buildApprovedAuditReason(EXECUTION_REASON_BASE, detailJa, approverUserId, "公開処刑フローに基づき管理者が承認。");
}

export const POLL1_KEYS = ["1", "2", "3"] as const;
export const POLL1_LABEL: Record<(typeof POLL1_KEYS)[number], string> = {
  "1": "タイムアウト",
  "2": "キック",
  "3": "BAN",
};

export const POLL2_KEYS = ["1", "2", "3", "4"] as const;
export const POLL2_LABEL: Record<(typeof POLL2_KEYS)[number], string> = {
  "1": "60秒",
  "2": "1時間",
  "3": "1日",
  "4": "1週間",
};

export const POLL2_CHOICE_TO_SECONDS: Record<(typeof POLL2_KEYS)[number], number> = {
  "1": 60,
  "2": 3600,
  "3": 86400,
  "4": 604800,
};

// Discord GuildMember.timeout 上限（28 日）
export const DISCORD_TIMEOUT_MAX_MS = 28 * 24 * 60 * 60 * 1000;

export function clampTimeoutMs(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return 60_000;
  return Math.min(ms, DISCORD_TIMEOUT_MAX_MS);
}

/**
 * 投票締切の1行（Embed 説明文用）。
 * - 投票中: `<t:unix:R>` で残り時間風表示（Discord クライアントが更新）。
 * - 締切後: `:R` は「1秒前」「2秒前」と増えるため、`pollEnded` 時は `<t:unix:T>` の静止時刻＋「終了」表記に切り替える。
 */
export function discordVoteDeadlineEmbedLine(deadlineMs: number, pollEnded: boolean): string {
  const sec = Math.floor(deadlineMs / 1000);
  if (pollEnded) {
    return `**投票締切**: 終了（<t:${sec}:T>）`;
  }
  return `**投票締切**: <t:${sec}:R>`;
}
