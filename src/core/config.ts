import { existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { DEPLOY_GUILD_ID, DEPLOY_OWNER_ID } from "./deployConstants.js";
import { BOT_SEMVER } from "./releaseVersions.js";

// 未設定・空は true（DiscordBOTv2 / AI_Query 互換）

function envFlagTrueByDefault(v: unknown): boolean {
  if (v === undefined || v === null || v === "") return true;
  return !["0", "false", "off", "no"].includes(String(v).toLowerCase());
}

// 未設定・空は false

function envFlagFalseByDefault(v: unknown): boolean {
  if (v === undefined || v === null || v === "") return false;
  return ["1", "true", "on", "yes"].includes(String(v).toLowerCase());
}

// 空は「既定に任せる」。1/true/on/yes で ON、0/false/off/no で OFF

function envOptionalLogDebug(v: unknown): boolean | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const s = String(v).toLowerCase();
  if (["0", "false", "off", "no"].includes(s)) return false;
  if (["1", "true", "on", "yes"].includes(s)) return true;
  return undefined;
}

// 相対パスを package.json があるディレクトリ基準の絶対パスに解決する（cwd ずれ対策）

function findPackageJsonDir(fromFile: string): string {
  let dir = dirname(fromFile);
  for (;;) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return dirname(fromFile);
    dir = parent;
  }
}

function assertValidIanaTimeZone(tz: string): void {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz }).format();
  } catch {
    throw new Error(`Invalid VC_TIME_RANKING_TIMEZONE: ${tz}`);
  }
}

const envSchema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_CLIENT_ID: z.string().min(1),
    // ターミナルに pino の DEBUG を出すか。
  // 未設定時は NODE_ENV に従い、production 以外は debug、production は info。

  LOG_DEBUG: z.preprocess(envOptionalLogDebug, z.boolean().optional()),
    // メイン SQLite。相対パスはリポジトリルート（package.json と同じ階層）基準

  DATABASE_PATH: z.string().min(1).default("data/l4discord.sqlite"),
    // メッセージログ専用 DB（既定: data/message.db）。環境変数 LOG_DB_PATH でも上書き可（DiscordBOTv2 互換）

  MESSAGE_LOG_DB_PATH: z.string().min(1).default("data/message.db"),
    // 添付ファイルのローカル複製メタ用 DB（message.db のスキーマは変更しない）。既定: data/message_attachment_store.db

  MESSAGE_ATTACHMENT_STORE_DB_PATH: z.string().min(1).default("data/message_attachment_store.db"),
    // 上記の実体ファイル保存先（相対はリポジトリルート基準）。既定: data/message_log_attachments

  MESSAGE_ATTACHMENT_FILES_DIR: z.string().min(1).default("data/message_log_attachments"),
    // メッセージログ取り込み時に Discord CDN から添付をダウンロードして保存する（既定: オン）

  MESSAGE_ATTACHMENT_ARCHIVE_ENABLED: z.preprocess(envFlagTrueByDefault, z.boolean()),
    // Modmail / 異議申し立て / 汎用 tickets 専用 DB（既定: data/ticket.db）

  TICKET_DATABASE_PATH: z.string().min(1).default("data/ticket.db"),
  ADMIN_ROLE_ID: z.string().min(1),
    // 未設定時は releaseVersions の BOT_SEMVER（.env は任意上書き）

  BOT_VERSION: z.preprocess(
    (v) => (v === "" || v === undefined ? BOT_SEMVER : v),
    z.string().min(1),
  ),
  DEEPSEEK_API_KEY: z.string().min(1),
  DEEPSEEK_API_BASE: z.preprocess(
    (v) => (v === "" || v === undefined ? undefined : v),
    z.string().url().optional(),
  ),
    // OpenAI 互換 chat completions の model 名

  DEEPSEEK_MODEL: z.string().min(1).default("deepseek-chat"),
  AI_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(5_000).default(45_000),
    // DeepSeek 応答 body の最大バイト（fetchWithLimits）

  AI_MAX_RESPONSE_BYTES: z.coerce.number().int().min(64_000).default(2_000_000),
  AI_MAX_RETRIES: z.coerce.number().int().min(0).default(2),
  AI_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.7),
  PROMPT_OPTIMIZER_ENABLED: z.preprocess(envFlagTrueByDefault, z.boolean()),
  PROMPT_OPTIMIZER_MAX_HISTORY: z.coerce.number().int().min(2).default(24),
  PROMPT_OPTIMIZER_MIN_MESSAGES: z.coerce.number().int().min(2).default(6),
  PROMPT_OPTIMIZER_INTERVAL_MESSAGES: z.coerce.number().int().min(1).default(4),
  PROMPT_OPTIMIZER_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.2),
  AI_JUDGE_ENABLED: z.preprocess(envFlagTrueByDefault, z.boolean()),
  AI_JUDGE_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.15),
  AI_COMMAND_EXECUTION_ENABLED: z.preprocess(envFlagTrueByDefault, z.boolean()),
  AI_ACTION_RATE_LIMIT: z.coerce.number().int().min(1).default(5),
  AI_LOG_COMMANDS_TO_HISTORY: z.preprocess(envFlagFalseByDefault, z.boolean()),
    // 会話コンテキストとして渡す最大メッセージ数（user/assistant いずれも1件でカウント）

  AI_HISTORY_MAX_MESSAGES: z.coerce.number().int().min(2).default(24),
    // ベース system プロンプト（相対はリポジトリルート基準）。無ければコード既定

  PROMPT_FILE_PATH: z.string().min(1).default("prompt.txt"),
    // ユーザー別プロンプト上書きファイル置き場（相対はリポジトリルート基準）

  USER_PROMPT_DIR: z.string().min(1).default("data/AI/prompt/user"),
    // メンションまたは Bot への返信で自然文を /q と同じルートに流す（既定オフ）

  CHAT_MONITOR_ENABLED: z.preprocess(envFlagFalseByDefault, z.boolean()),
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
  SKIP_COMMAND_SYNC: z.preprocess(
    (v) => v === "true" || v === "1",
    z.boolean().optional().default(false),
  ),
  COMMAND_SYNC_DEBOUNCE_MS: z.coerce.number().int().min(0).default(0),
  GUILD_MISMATCH_POLICY: z.enum(["warn"]).optional(),
    // VC 滞在ログ専用 DB（相対はリポジトリルート基準。既定: data/vc_time.db）

  VC_TIME_DATABASE_PATH: z.string().min(1).default("data/vc_time.db"),
    // VC ランキングの「今日／週／月」の境界に使う IANA タイムゾーン（既定: Asia/Tokyo）

  VC_TIME_RANKING_TIMEZONE: z.string().min(1).default("Asia/Tokyo"),
    // 一時VCを作成するカテゴリID（未設定時は既存VCから自動推定）

  VC_CREATE_CATEGORY_ID: z.preprocess((v) => (v === "" || v === undefined ? undefined : v), z.string().optional()),
    // /q 会話履歴専用 DB（既定: data/AI_History.db）

  AI_HISTORY_DATABASE_PATH: z.string().min(1).default("data/AI_History.db"),
    // 自動モデレーション設定専用 DB（既定: data/Automoderation.db）

  AUTOMODERATION_DATABASE_PATH: z.string().min(1).default("data/Automoderation.db"),
    // リマインダーハブ専用 DB（既定: data/reminder.db）。REMINDER_DB_PATH でも上書き可（DiscordBOTv2 互換）

  REMINDER_DATABASE_PATH: z.string().min(1).default("data/reminder.db"),
    // リアクションロール管理パネル（作成/編集/削除）を置くテキストチャンネル ID。
  // REACTION_ROLE_OUTPUT_CHANNEL_ID（DiscordBOTv2 互換）でも指定可。

  REACTION_ROLE_UI_CHANNEL_ID: z.preprocess((v) => (v === "" || v === undefined ? undefined : v), z.string().optional()),
  REACTION_ROLE_OUTPUT_CHANNEL_ID: z.preprocess((v) => (v === "" || v === undefined ? undefined : v), z.string().optional()),
    // DiscordBOTv2 Utilities: 冷笑カウント JSON（既定: data/server/json/cold_laugh_counts.json）

  COLD_LAUGH_STORE_PATH: z.string().min(1).default("data/server/json/cold_laugh_counts.json"),
    // 川柳（5-7-5）検出（kuromoji）。未設定・空は false

  SENRYU_ENABLED: z.preprocess(envFlagFalseByDefault, z.boolean()),
  SENRYU_REPLY_ENABLED: z.preprocess(envFlagFalseByDefault, z.boolean()),
  SENRYU_SAVE_ENABLED: z.preprocess(envFlagFalseByDefault, z.boolean()),
    // 未設定・空は true

  SENRYU_AUTO_MUTE_ON_PERMISSION_ERROR: z.preprocess(envFlagTrueByDefault, z.boolean()),
  SENRYU_MAX_CONTENT_LENGTH: z.coerce.number().int().min(1).max(4000).default(2000),
    // 川柳検出後に DeepSeek で候補を審査（未設定・空は false）

  SENRYU_AI_REVIEW_ENABLED: z.preprocess(envFlagFalseByDefault, z.boolean()),
  SENRYU_AI_REVIEW_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.15),
  SENRYU_AI_REVIEW_TIMEOUT_MS: z.coerce.number().int().min(3_000).default(20_000),
  SENRYU_AI_REVIEW_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(1),
    // 未設定時は DEEPSEEK_MODEL

  SENRYU_AI_REVIEW_MODEL: z.preprocess(
    (v) => (v === "" || v === undefined ? undefined : v),
    z.string().min(1).optional(),
  ),
    // kuromoji 辞書ディレクトリ（未設定はパッケージ既定）

  SENRYU_KUROMOJI_DICT_PATH: z.preprocess(
    (v) => (v === "" || v === undefined ? undefined : v),
    z.string().min(1).optional(),
  ),
});

type ParsedEnvConfig = z.infer<typeof envSchema>;
export type AppConfig = ParsedEnvConfig & { GUILD_ID: string; OWNER_ID: string };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const envWithLogDefaults = {
    ...env,
    MESSAGE_LOG_DB_PATH:
      env.MESSAGE_LOG_DB_PATH ||
      env.LOG_DB_PATH ||
      "data/message.db",
    REMINDER_DATABASE_PATH:
      env.REMINDER_DATABASE_PATH || env.REMINDER_DB_PATH || "data/reminder.db",
  };
  const parsed = envSchema.safeParse(envWithLogDefaults);
  if (!parsed.success) {
    const msg = parsed.error.flatten().fieldErrors;
    throw new Error(`Invalid environment: ${JSON.stringify(msg)}`);
  }
  const guildId = DEPLOY_GUILD_ID.trim();
  const ownerId = DEPLOY_OWNER_ID.trim();
  if (!guildId) {
    throw new Error("src/core/deployConstants.ts の DEPLOY_GUILD_ID を設定してください");
  }
  if (!ownerId) {
    throw new Error("src/core/deployConstants.ts の DEPLOY_OWNER_ID を設定してください");
  }
  const data = parsed.data;
  assertValidIanaTimeZone(data.VC_TIME_RANKING_TIMEZONE);
  const repoRoot = findPackageJsonDir(fileURLToPath(import.meta.url));
  const R = (p: string) => (isAbsolute(p) ? p : join(repoRoot, p));
  return {
    ...data,
    GUILD_ID: guildId,
    OWNER_ID: ownerId,
    DATABASE_PATH: R(data.DATABASE_PATH),
    MESSAGE_LOG_DB_PATH: R(data.MESSAGE_LOG_DB_PATH),
    MESSAGE_ATTACHMENT_STORE_DB_PATH: R(data.MESSAGE_ATTACHMENT_STORE_DB_PATH),
    MESSAGE_ATTACHMENT_FILES_DIR: R(data.MESSAGE_ATTACHMENT_FILES_DIR),
    TICKET_DATABASE_PATH: R(data.TICKET_DATABASE_PATH),
    VC_TIME_DATABASE_PATH: R(data.VC_TIME_DATABASE_PATH),
    AI_HISTORY_DATABASE_PATH: R(data.AI_HISTORY_DATABASE_PATH),
    AUTOMODERATION_DATABASE_PATH: R(data.AUTOMODERATION_DATABASE_PATH),
    REMINDER_DATABASE_PATH: R(data.REMINDER_DATABASE_PATH),
    PROMPT_FILE_PATH: R(data.PROMPT_FILE_PATH),
    USER_PROMPT_DIR: R(data.USER_PROMPT_DIR),
    COLD_LAUGH_STORE_PATH: R(data.COLD_LAUGH_STORE_PATH),
    SENRYU_KUROMOJI_DICT_PATH: data.SENRYU_KUROMOJI_DICT_PATH ? R(data.SENRYU_KUROMOJI_DICT_PATH) : undefined,
  };
}
