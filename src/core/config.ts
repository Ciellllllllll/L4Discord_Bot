import { z } from "zod";
import { BOT_SEMVER } from "./releaseVersions.js";

/** 未設定・空は true（DiscordBOTv2 / AI_Query 互換） */
function envFlagTrueByDefault(v: unknown): boolean {
  if (v === undefined || v === null || v === "") return true;
  return !["0", "false", "off", "no"].includes(String(v).toLowerCase());
}

/** 未設定・空は false */
function envFlagFalseByDefault(v: unknown): boolean {
  if (v === undefined || v === null || v === "") return false;
  return ["1", "true", "on", "yes"].includes(String(v).toLowerCase());
}

const envSchema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_CLIENT_ID: z.string().min(1),
  GUILD_ID: z.string().min(1),
  DATABASE_PATH: z.string().min(1),
  /** メッセージログ専用 DB（既定: data/message.db）。環境変数 LOG_DB_PATH でも上書き可（DiscordBOTv2 互換） */
  MESSAGE_LOG_DB_PATH: z.string().min(1).default("data/message.db"),
  /** Modmail / 異議申し立て / 汎用 tickets 専用 DB（既定: data/ticket.db） */
  TICKET_DATABASE_PATH: z.string().min(1).default("data/ticket.db"),
  OWNER_ID: z.string().min(1),
  ADMIN_ROLE_ID: z.string().min(1),
  /** 未設定時は releaseVersions の BOT_SEMVER（.env は任意上書き） */
  BOT_VERSION: z.preprocess(
    (v) => (v === "" || v === undefined ? BOT_SEMVER : v),
    z.string().min(1),
  ),
  DEEPSEEK_API_KEY: z.string().min(1),
  DEEPSEEK_API_BASE: z.preprocess(
    (v) => (v === "" || v === undefined ? undefined : v),
    z.string().url().optional(),
  ),
  /** OpenAI 互換 chat completions の model 名 */
  DEEPSEEK_MODEL: z.string().min(1).default("deepseek-chat"),
  AI_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(5_000).default(45_000),
  /** DeepSeek 応答 body の最大バイト（fetchWithLimits） */
  AI_MAX_RESPONSE_BYTES: z.coerce.number().int().min(64_000).default(2_000_000),
  AI_MAX_RETRIES: z.coerce.number().int().min(0).default(2),
  AI_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.7),
  PROMPT_OPTIMIZER_ENABLED: z.preprocess(envFlagTrueByDefault, z.boolean()),
  PROMPT_OPTIMIZER_MAX_HISTORY: z.coerce.number().int().min(2).default(24),
  PROMPT_OPTIMIZER_MIN_MESSAGES: z.coerce.number().int().min(2).default(6),
  PROMPT_OPTIMIZER_INTERVAL_MESSAGES: z.coerce.number().int().min(1).default(4),
  PROMPT_OPTIMIZER_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.2),
  /**
   * /q 履歴管理パネルを置くテキストチャンネル。未設定時は LOG_CHANNEL_ID → LOGGER_CHANNEL_ID → DETECTER_FALLBACK_CHANNEL_ID
   */
  AI_QUERY_HISTORY_UI_CHANNEL_ID: z.preprocess((v) => (v === "" || v === undefined ? undefined : v), z.string().optional()),
  AI_JUDGE_ENABLED: z.preprocess(envFlagTrueByDefault, z.boolean()),
  AI_JUDGE_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.15),
  AI_COMMAND_EXECUTION_ENABLED: z.preprocess(envFlagTrueByDefault, z.boolean()),
  AI_ACTION_RATE_LIMIT: z.coerce.number().int().min(1).default(5),
  AI_LOG_COMMANDS_TO_HISTORY: z.preprocess(envFlagFalseByDefault, z.boolean()),
  /** 会話コンテキストとして渡す最大メッセージ数（user/assistant いずれも1件でカウント） */
  AI_HISTORY_MAX_MESSAGES: z.coerce.number().int().min(2).default(24),
  /** ベース system プロンプト（相対パスは cwd 基準）。無ければコード既定 */
  PROMPT_FILE_PATH: z.string().min(1).default("prompt.txt"),
  /** ユーザー別プロンプト上書きファイル置き場 */
  USER_PROMPT_DIR: z.string().min(1).default("data/AI/prompt/user"),
  /**
   * メンションまたは Bot への返信で自然文を /q と同じルートに流す（既定オフ）
   */
  CHAT_MONITOR_ENABLED: z.preprocess(envFlagFalseByDefault, z.boolean()),
  /**
   * Detecter モデレーター向け「理由入力」プロンプトの投稿先（最優先）。
   * 未設定時は LOGGER_CHANNEL_ID → LOG_CHANNEL_ID → DETECTER_FALLBACK_CHANNEL_ID。
   */
  MOD_LOG_CHANNEL_ID: z.preprocess((v) => (v === "" || v === undefined ? undefined : v), z.string().optional()),
  /** Detecter 理由プロンプト投稿先（DiscordBOTv2 の LOGGER_CHANNEL_ID / LOG_CHANNEL_ID 互換） */
  LOGGER_CHANNEL_ID: z.preprocess((v) => (v === "" || v === undefined ? undefined : v), z.string().optional()),
  LOG_CHANNEL_ID: z.preprocess((v) => (v === "" || v === undefined ? undefined : v), z.string().optional()),
  /**
   * Modmail スタッフ用スレッドの親チャンネル（テキスト / お知らせ / フォーラム）。
   * 未設定時は LOG_CHANNEL_ID → LOGGER_CHANNEL_ID の順でフォールバック（DiscordBOTv2 互換）。
   */
  MODMAIL_LOG_CHANNEL_ID: z.preprocess((v) => (v === "" || v === undefined ? undefined : v), z.string().optional()),
  /**
   * 異議申し立て（Detecter → Ticket）の審査用チャンネル。
   * 未設定時は LOG_CHANNEL_ID → LOGGER_CHANNEL_ID → MODMAIL_LOG_CHANNEL_ID の順。
   */
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
  /** VC 滞在ログ専用 DB（既定: data/vc_time.db） */
  VC_TIME_DATABASE_PATH: z.string().min(1).default("data/vc_time.db"),
  /** 一時VC: ジャンル別カテゴリ（vc_panel_configs の name と併用可） */
  VC_CATEGORY_TALK: z.preprocess((v) => (v === "" || v === undefined ? undefined : v), z.string().optional()),
  VC_CATEGORY_GAME: z.preprocess((v) => (v === "" || v === undefined ? undefined : v), z.string().optional()),
  VC_CATEGORY_WORK: z.preprocess((v) => (v === "" || v === undefined ? undefined : v), z.string().optional()),
  /** 設定時、VC 作成パネルを恒久投稿・再接続するテキストチャンネル ID */
  VC_UI_CHANNEL_ID: z.preprocess((v) => (v === "" || v === undefined ? undefined : v), z.string().optional()),
  /**
   * リアクションロール管理パネル（作成/編集/削除）を置くテキストチャンネル ID。
   * REACTION_ROLE_OUTPUT_CHANNEL_ID（DiscordBOTv2 互換）でも指定可。
   */
  REACTION_ROLE_UI_CHANNEL_ID: z.preprocess((v) => (v === "" || v === undefined ? undefined : v), z.string().optional()),
  REACTION_ROLE_OUTPUT_CHANNEL_ID: z.preprocess((v) => (v === "" || v === undefined ? undefined : v), z.string().optional()),
});

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const envWithLogDefaults = {
    ...env,
    MESSAGE_LOG_DB_PATH:
      env.MESSAGE_LOG_DB_PATH ||
      env.LOG_DB_PATH ||
      "data/message.db",
  };
  const parsed = envSchema.safeParse(envWithLogDefaults);
  if (!parsed.success) {
    const msg = parsed.error.flatten().fieldErrors;
    throw new Error(`Invalid environment: ${JSON.stringify(msg)}`);
  }
  return parsed.data;
}
