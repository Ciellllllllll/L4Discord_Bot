/** DB `polls.kind` */
export const TIMEOUT_EXTEND_FLOW_KIND = "timeout_extend_flow";

/** 投票ボタン customId 接頭辞（処刑の exec_vote: と衝突させない） */
export const TE_VOTE_PREFIX = "te_vote:";

/** 管理者承認（処刑の exec_approval: と衝突させない） */
export const TE_APPROVAL_PREFIX = "te_approval:";

/** 第1投票: 延長 / 解除（DiscordBOTv2 TimeoutExtendVote と同様） */
export const TE_POLL1_KEYS = ["extend", "release"] as const;
export const TE_POLL1_LABEL: Record<(typeof TE_POLL1_KEYS)[number], string> = {
  extend: "延長",
  release: "解除",
};

/** 第2投票: 延長秒数（1時間 / 1日 / 1週間） */
export const TE_POLL2_KEYS = ["s3600", "s86400", "s604800"] as const;
export const TE_POLL2_LABEL: Record<(typeof TE_POLL2_KEYS)[number], string> = {
  s3600: "1時間",
  s86400: "1日",
  s604800: "1週間",
};

export const TE_POLL2_SECONDS: Record<(typeof TE_POLL2_KEYS)[number], number> = {
  s3600: 3600,
  s86400: 86400,
  s604800: 604800,
};
