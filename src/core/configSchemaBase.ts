import { z } from "zod";
import { BOT_SEMVER } from "./releaseVersions.js";
import { botProfiles, envFlagTrueByDefault, envOptionalLogDebug } from "./configEnv.js";

// 設定スキーマ: プロファイル・DB・Discord・処刑フロー。

export const baseEnvShape = {
  BOT_PROFILE: z.enum(botProfiles),
  DATABASE_URL: z.string().url(),
  POSTGRES_MAIN_SCHEMA: z.string().min(1).default("main"),
  POSTGRES_TICKET_SCHEMA: z.string().min(1).default("ticket"),
  POSTGRES_MESSAGE_LOG_SCHEMA: z.string().min(1).default("message_log"),
  POSTGRES_MESSAGE_ATTACHMENT_SCHEMA: z.string().min(1).default("message_attachment"),
  POSTGRES_VC_TIME_SCHEMA: z.string().min(1).default("vc_time"),
  POSTGRES_AI_HISTORY_SCHEMA: z.string().min(1).default("ai_history"),
  POSTGRES_AUTOMOD_SCHEMA: z.string().min(1).default("automod"),
  POSTGRES_REMINDER_SCHEMA: z.string().min(1).default("reminder"),
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_CLIENT_ID: z.string().min(1),
  GUILD_ID: z.string().min(1),
  OWNER_ID: z.string().min(1),
  // ターミナルに pino の DEBUG を出すか。
  // 未設定時は NODE_ENV に従い、production 以外は debug、production は info。
  LOG_DEBUG: z.preprocess(envOptionalLogDebug, z.boolean().optional()),
  // 添付ファイルの実体保存先（相対はリポジトリルート基準）。既定: data/message_log_attachments
  MESSAGE_ATTACHMENT_FILES_DIR: z.string().min(1).default("data/message_log_attachments"),
  // メッセージログ取り込み時に Discord CDN から添付をダウンロードして保存する（既定: オン）
  MESSAGE_ATTACHMENT_ARCHIVE_ENABLED: z.preprocess(envFlagTrueByDefault, z.boolean()),
  ADMIN_ROLE_ID: z.string().min(1),
  /** 処刑フロー: 各投票の秒数（DiscordBOTv2 の EXEC_VOTE_SECONDS 相当、既定 20） */
  EXEC_VOTE_SECONDS: z.coerce.number().int().min(5).max(86_400).default(20),
  /** 処刑フロー: 管理者承認の待ち秒数（既定 600） */
  EXEC_ADMIN_WAIT_SECONDS: z.coerce.number().int().min(30).max(86_400).default(600),
  /** 未設定・空ならどのチャンネルでも可。設定時はそのテキストチャンネルのみ /処刑・/タイムアウト延長 の起動可 */
  EXEC_CHANNEL_ID: z.preprocess((v) => (v === "" || v === undefined ? undefined : v), z.string().optional()),
  /** タイムアウト延長フロー: 投票・承認メッセージの投稿先（未設定時はコマンド実行チャンネル） */
  TIMEOUT_EXTEND_VOTE_CHANNEL_ID: z.preprocess((v) => (v === "" || v === undefined ? undefined : v), z.string().optional()),
  /** タイムアウト延長フロー: 管理者承認の待ち秒数（DiscordBOTv2 の ADMIN_WAIT_SECONDS 相当、既定 120） */
  TIMEOUT_EXTEND_ADMIN_WAIT_SECONDS: z.coerce.number().int().min(30).max(86_400).default(120),
  /** 未設定・空なら事前チェックなし。設定時、対象がこのロールを持たないと管理者事前承認が必要（DiscordBOTv2 互換） */
  EXECUTOR_ROLE_ID: z.preprocess((v) => (v === "" || v === undefined ? undefined : v), z.string().optional()),
  // 未設定時は releaseVersions の BOT_SEMVER（.env は任意上書き）
  BOT_VERSION: z.preprocess(
    (v) => (v === "" || v === undefined ? BOT_SEMVER : v),
    z.string().min(1),
  ),
};
