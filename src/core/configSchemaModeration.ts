import { z } from "zod";
import { envFlagFalseByDefault } from "./configEnv.js";

// 設定スキーマ: モデレーション・ログチャンネル・VC・リアクションロール・ゲームセールの通知先。

export const moderationEnvShape = {
  // モデレ用ログの中心チャンネル: Detecter「理由入力」、Modmail スタッフスレッドの親、退出通知（leaveNotifier）。
  // Detecter で未設定時のフォールバックは LOGGER_CHANNEL_ID → LOG_CHANNEL_ID → DETECTER_FALLBACK_CHANNEL_ID。
  MOD_LOG_CHANNEL_ID: z.preprocess((v) => (v === "" || v === undefined ? undefined : v), z.string().optional()),
  // Detecter 理由プロンプト投稿先（DiscordBOTv2 の LOGGER_CHANNEL_ID / LOG_CHANNEL_ID 互換）
  LOGGER_CHANNEL_ID: z.preprocess((v) => (v === "" || v === undefined ? undefined : v), z.string().optional()),
  LOG_CHANNEL_ID: z.preprocess((v) => (v === "" || v === undefined ? undefined : v), z.string().optional()),
  // Modmail 専用の親チャンネル上書き（MOD_LOG_CHANNEL_ID 未設定時のみ有効）。
  // 未設定時は LOG_CHANNEL_ID → LOGGER_CHANNEL_ID の順でフォールバック（DiscordBOTv2 互換）。
  MODMAIL_LOG_CHANNEL_ID: z.preprocess((v) => (v === "" || v === undefined ? undefined : v), z.string().optional()),
  // 異議申し立て（Detecter → Ticket）の審査用チャンネル。
  // 未設定時は LOG_CHANNEL_ID → LOGGER_CHANNEL_ID → MODMAIL_LOG_CHANNEL_ID の順。
  APPEAL_REVIEW_CHANNEL_ID: z.preprocess((v) => (v === "" || v === undefined ? undefined : v), z.string().optional()),
  DETECTER_FALLBACK_CHANNEL_ID: z.string().optional(),
  DETECTER_PROMPT_TIMEOUT_SEC: z.coerce.number().int().min(60).default(60 * 30),
  DETECTER_AUDIT_WINDOW_SEC: z.coerce.number().int().min(5).default(45),
  DETECTER_DEFAULT_APPEAL_WINDOW_SEC: z.coerce.number().int().min(60).default(60 * 60 * 24 * 30),
  DETECTER_DEFAULT_REASON_TEXT: z.string().min(1).default("モデレーターによる理由は未入力です。"),
  SKIP_COMMAND_SYNC: z.preprocess(envFlagFalseByDefault, z.boolean()),
  COMMAND_SYNC_DEBOUNCE_MS: z.coerce.number().int().min(0).default(0),
  GUILD_MISMATCH_POLICY: z.enum(["warn"]).optional(),
  // VC ランキングの「今日／週／月」の境界に使う IANA タイムゾーン（既定: Asia/Tokyo）
  VC_TIME_RANKING_TIMEZONE: z.string().min(1).default("Asia/Tokyo"),
  // 一時VCを作成するカテゴリID（未設定時は既存VCから自動推定）
  VC_CREATE_CATEGORY_ID: z.preprocess((v) => (v === "" || v === undefined ? undefined : v), z.string().optional()),
  // リアクションロール管理パネル（作成/編集/削除）を置くテキストチャンネル ID。
  // REACTION_ROLE_OUTPUT_CHANNEL_ID（DiscordBOTv2 互換）でも指定可。
  REACTION_ROLE_UI_CHANNEL_ID: z.preprocess((v) => (v === "" || v === undefined ? undefined : v), z.string().optional()),
  REACTION_ROLE_OUTPUT_CHANNEL_ID: z.preprocess((v) => (v === "" || v === undefined ? undefined : v), z.string().optional()),
  GAME_DEAL_CHANNEL_ID: z.preprocess((v) => (v === "" || v === undefined ? undefined : v), z.string().optional()),
  GAME_DEAL_NOTIFY_ROLE_ID: z.preprocess((v) => (v === "" || v === undefined ? undefined : v), z.string().optional()),
};
