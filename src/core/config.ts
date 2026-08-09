import { existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
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

function envOptionalStringWithoutAssignment(key: string): (v: unknown) => string | undefined {
  return (v: unknown) => {
    if (v === "" || v === undefined || v === null) return undefined;
    const trimmed = String(v).trim();
    const prefix = `${key}=`;
    const value = trimmed.toUpperCase().startsWith(prefix) ? trimmed.slice(prefix.length).trim() : trimmed;
    return value || undefined;
  };
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

const botProfiles = ["production", "debug"] as const;
type BotProfile = (typeof botProfiles)[number];

const profileOverridableKeys = [
  "DISCORD_TOKEN",
  "DISCORD_CLIENT_ID",
  "GUILD_ID",
  "OWNER_ID",
  "ADMIN_ROLE_ID",
  "EXEC_CHANNEL_ID",
  "TIMEOUT_EXTEND_VOTE_CHANNEL_ID",
  "EXECUTOR_ROLE_ID",
  "MOD_LOG_CHANNEL_ID",
  "LOGGER_CHANNEL_ID",
  "LOG_CHANNEL_ID",
  "MODMAIL_LOG_CHANNEL_ID",
  "APPEAL_REVIEW_CHANNEL_ID",
  "DETECTER_FALLBACK_CHANNEL_ID",
  "VC_CREATE_CATEGORY_ID",
  "REACTION_ROLE_UI_CHANNEL_ID",
  "REACTION_ROLE_OUTPUT_CHANNEL_ID",
  "GAME_DEAL_CHANNEL_ID",
  "GAME_DEAL_NOTIFY_ROLE_ID",
  "R18_CHANNEL_ID",
  "LOCAL_LLM_API_BASE",
  "LOCAL_LLM_API_KEY",
  "LOCAL_LLM_MODEL",
  "LOCAL_LLM_TIMEOUT_MS",
  "LOCAL_LLM_MAX_CONCURRENT",
  "LOCAL_LLM_MAX_QUEUE",
  "LOCAL_LLM_TEMPERATURE",
  "YOUTUBE_PREVIEW_ENABLED",
  "YOUTUBE_DATA_API_KEY",
  "YOUTUBE_REQUEST_TIMEOUT_MS",
  "ADHD_WATCHER_ENABLED",
  "ADHD_POLL_INTERVAL_MS",
  "ADHD_RSS_REQUEST_TIMEOUT_MS",
  "GAME_DEAL_STEAM_NOW_INTERVAL_MS",
  "GAME_DEAL_EPIC_INTERVAL_MS",
  "GAME_DEAL_SUBSCRIPTION_INTERVAL_MS",
  "WEREWOLF_CHANNEL_ID",
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_API_BASE",
  "DEEPSEEK_MODEL",
  "DEEPSEEK_THINKING_ENABLED",
  "DEEPSEEK_THINKING_EFFORT",
  "OPENAI_API_KEY",
  "OPENAI_ADMIN_KEY",
  "OPENAI_PROJECT_ID",
  "OPENAI_API_BASE",
  "OPENAI_MODEL",
  "OPENAI_MODEL_GPT56",
  "OPENAI_MODEL_GPT54_MINI",
  "OPENAI_REASONING_EFFORT",
  "OPENAI_FALLBACK_THRESHOLD",
  "OPENAI_USAGE_CACHE_MS",
  "OPENAI_MAX_COMPLETION_TOKENS",
  "DATABASE_PATH",
  "MESSAGE_LOG_DB_PATH",
  "LOG_DB_PATH",
  "MESSAGE_ATTACHMENT_STORE_DB_PATH",
  "MESSAGE_ATTACHMENT_FILES_DIR",
  "TICKET_DATABASE_PATH",
  "VC_TIME_DATABASE_PATH",
  "AI_HISTORY_DATABASE_PATH",
  "AUTOMODERATION_DATABASE_PATH",
  "REMINDER_DATABASE_PATH",
  "REMINDER_DB_PATH",
  "PROMPT_FILE_PATH",
  "USER_PROMPT_DIR",
  "COLD_LAUGH_STORE_PATH",
  "THECATAPI_ENABLED",
  "THECATAPI_API_KEY",
  "THECATAPI_API_BASE_URL",
  "THECATAPI_REQUEST_TIMEOUT_MS",
  "DOGCEO_ENABLED",
  "DOGCEO_IMAGE_RANDOM_URL",
  "DOGCEO_REQUEST_TIMEOUT_MS",
  "BOKETE_API_BASE_URL",
  "BOKETE_REQUEST_TIMEOUT_MS",
  "SENRYU_KUROMOJI_DICT_PATH",
  "JAPANESE_WORKER_ENABLED",
  "JAPANESE_WORKER_URL",
  "JAPANESE_WORKER_TIMEOUT_MS",
  "SENRYU_DETECTOR_MODE",
  "SENRYU_WORKER_FALLBACK_ENABLED",
  "SENRYU_WORKER_FALLBACK_ON_NO_MATCH",
  "PACCHI_LEARNING_ANALYZER",
  "PACCHI_PATTERN_LEARNING_ENABLED",
  "PACCHI_GENERATION_MODE",
  "PACCHI_AI_FINAL_CHECK_ENABLED",
  "PACCHI_WIKIPEDIA_API_BASE_URL",
  "DEEPLOL_WATCHER_ENABLED",
  "RIOT_API_KEY",
  "RIOT_PLATFORM_ID",
  "RIOT_REGIONAL_ROUTING",
  "RIOT_REQUEST_TIMEOUT_MS",
  "DEEPLOL_MATCH_URL_TEMPLATE",
  "DEEPLOL_POLL_INTERVAL_MS",
  "DEEPLOL_ACTIVE_STALE_MS",
  "DATABASE_URL",
  "POSTGRES_MAIN_SCHEMA",
  "POSTGRES_TICKET_SCHEMA",
  "POSTGRES_MESSAGE_LOG_SCHEMA",
  "POSTGRES_MESSAGE_ATTACHMENT_SCHEMA",
  "POSTGRES_VC_TIME_SCHEMA",
  "POSTGRES_AI_HISTORY_SCHEMA",
  "POSTGRES_AUTOMOD_SCHEMA",
  "POSTGRES_REMINDER_SCHEMA",
] as const;

function resolveBotProfile(env: NodeJS.ProcessEnv): BotProfile {
  if (botProfiles.includes(env.BOT_PROFILE as BotProfile)) return env.BOT_PROFILE as BotProfile;
  throw new Error(`Invalid BOT_PROFILE: ${String(env.BOT_PROFILE)}. Use "production" or "debug".`);
}

function profilePrefix(profile: BotProfile): "PRODUCTION" | "DEBUG" {
  return profile === "production" ? "PRODUCTION" : "DEBUG";
}

function profileDataDefaults(profile: BotProfile): Record<string, string> {
  const base = `data/${profile}`;
  return {
    DATABASE_PATH: `${base}/l4discord.sqlite`,
    MESSAGE_LOG_DB_PATH: `${base}/message.db`,
    MESSAGE_ATTACHMENT_STORE_DB_PATH: `${base}/message_attachment_store.db`,
    MESSAGE_ATTACHMENT_FILES_DIR: `${base}/message_log_attachments`,
    TICKET_DATABASE_PATH: `${base}/ticket.db`,
    VC_TIME_DATABASE_PATH: `${base}/vc_time.db`,
    AI_HISTORY_DATABASE_PATH: `${base}/AI_History.db`,
    AUTOMODERATION_DATABASE_PATH: `${base}/Automoderation.db`,
    REMINDER_DATABASE_PATH: `${base}/reminder.db`,
    USER_PROMPT_DIR: `${base}/AI/prompt/user`,
    COLD_LAUGH_STORE_PATH: `${base}/server/json/cold_laugh_counts.json`,
  };
}

function applyProfileOverrides(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const profile = resolveBotProfile(env);
  const prefix = profilePrefix(profile);
  const next: NodeJS.ProcessEnv = {
    ...profileDataDefaults(profile),
    ...env,
    BOT_PROFILE: profile,
  };

  for (const key of profileOverridableKeys) {
    const prefixedKey = `${prefix}_${key}`;
    const value = env[prefixedKey];
    if (value !== undefined) {
      next[key] = value;
    }
  }

  return next;
}

const envSchema = z.object({
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
  DEEPSEEK_API_KEY: z.preprocess((v) => (v === undefined || v === null ? "" : v), z.string().default("")),
  DEEPSEEK_API_BASE: z.preprocess(
    (v) => (v === "" || v === undefined ? undefined : v),
    z.string().url().optional(),
  ),
    // OpenAI 互換 chat completions の model 名

  DEEPSEEK_MODEL: z.preprocess(
    (v) => (v === "" || v === undefined ? undefined : v),
    z.string().min(1).default("deepseek-v4-flash"),
  ),
  DEEPSEEK_THINKING_ENABLED: z.preprocess(envFlagTrueByDefault, z.boolean()),
  DEEPSEEK_THINKING_EFFORT: z.preprocess(
    (v) => (v === "" || v === undefined ? "high" : v),
    z.enum(["high", "max"]).default("high"),
  ),
  OPENAI_API_KEY: z.preprocess((v) => (v === undefined || v === null ? "" : v), z.string().default("")),
  OPENAI_ADMIN_KEY: z.preprocess((v) => (v === undefined || v === null ? "" : v), z.string().default("")),
  OPENAI_PROJECT_ID: z.preprocess((v) => (v === undefined || v === null ? "" : v), z.string().default("")),
  OPENAI_API_BASE: z.preprocess(
    (v) => (v === "" || v === undefined || v === null ? undefined : v),
    z.string().url().default("https://api.openai.com/v1"),
  ),
  OPENAI_MODEL_GPT56: z.preprocess(
    (v) => (v === "" || v === undefined || v === null ? undefined : v),
    z.string().min(1).default("gpt-5.6-terra"),
  ),
  OPENAI_MODEL_GPT54_MINI: z.preprocess(
    (v) => (v === "" || v === undefined || v === null ? undefined : v),
    z.string().min(1).default("gpt-5.4-mini-2026-03-17"),
  ),
  OPENAI_REASONING_EFFORT: z.preprocess(
    (v) => (v === "" || v === undefined || v === null ? undefined : v),
    z.enum(["none", "low", "medium", "high", "xhigh"]).default("high"),
  ),
  OPENAI_FALLBACK_THRESHOLD: z.coerce.number().int().positive().default(2_400_000),
  OPENAI_USAGE_CACHE_MS: z.coerce.number().int().min(0).default(30_000),
  OPENAI_MAX_COMPLETION_TOKENS: z.coerce.number().int().positive().default(8_192),
  AI_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(5_000).default(45_000),
    // DeepSeek 応答 body の最大バイト（fetchWithLimits）

  AI_MAX_RESPONSE_BYTES: z.coerce.number().int().min(64_000).default(2_000_000),
  AI_MAX_RETRIES: z.coerce.number().int().min(0).default(2),
  AI_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.7),
  R18_CHANNEL_ID: z.preprocess((v) => (v === "" || v === undefined ? undefined : v), z.string().optional()),
  LOCAL_LLM_API_BASE: z.preprocess(
    (v) => (v === "" || v === undefined ? undefined : v),
    z.string().url().optional(),
  ),
  LOCAL_LLM_API_KEY: z.preprocess((v) => (v === undefined || v === null ? "" : v), z.string().default("")),
  LOCAL_LLM_MODEL: z.preprocess(
    (v) => (v === "" || v === undefined ? undefined : v),
    z.string().min(1).default("Qwen3.6-35B-A3B-Uncensored-HauhauCS-Aggressive-IQ4_XS.gguf"),
  ),
  LOCAL_LLM_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(180_000),
  LOCAL_LLM_MAX_CONCURRENT: z.coerce.number().int().min(1).default(1),
  LOCAL_LLM_MAX_QUEUE: z.coerce.number().int().min(0).default(3),
  LOCAL_LLM_TEMPERATURE: z.preprocess(
    (v) => (v === "" || v === undefined ? undefined : v),
    z.coerce.number().min(0).max(2).optional(),
  ),
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
  GAME_DEAL_CHANNEL_ID: z.preprocess((v) => (v === "" || v === undefined ? undefined : v), z.string().optional()),
  GAME_DEAL_NOTIFY_ROLE_ID: z.preprocess((v) => (v === "" || v === undefined ? undefined : v), z.string().optional()),
  YOUTUBE_PREVIEW_ENABLED: z.preprocess(envFlagTrueByDefault, z.boolean()),
  YOUTUBE_DATA_API_KEY: z.preprocess((v) => (v === undefined || v === null ? "" : v), z.string().default("")),
  YOUTUBE_REQUEST_TIMEOUT_MS: z.preprocess(
    (v) => (v === "" || v === undefined || v === null ? undefined : v),
    z.coerce.number().int().min(1_000).max(30_000).default(10_000),
  ),
  ADHD_WATCHER_ENABLED: z.preprocess(envFlagTrueByDefault, z.boolean()),
  ADHD_POLL_INTERVAL_MS: z.coerce.number().int().min(60_000).default(60_000),
  ADHD_RSS_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(30_000).default(10_000),
  GAME_DEAL_STEAM_NOW_INTERVAL_MS: z.coerce.number().int().min(60_000).default(1_800_000),
  GAME_DEAL_EPIC_INTERVAL_MS: z.coerce.number().int().min(60_000).default(3_600_000),
  GAME_DEAL_SUBSCRIPTION_INTERVAL_MS: z.coerce.number().int().min(60_000).default(3_600_000),
  WEREWOLF_CHANNEL_ID: z.preprocess((v) => (v === "" || v === undefined ? undefined : v), z.string().optional()),
    // DiscordBOTv2 Utilities: 冷笑カウント JSON（既定: data/server/json/cold_laugh_counts.json）

  COLD_LAUGH_STORE_PATH: z.string().min(1).default("data/server/json/cold_laugh_counts.json"),
  THECATAPI_ENABLED: z.preprocess(envFlagTrueByDefault, z.boolean()),
  THECATAPI_API_KEY: z.preprocess((v) => (v === undefined || v === null ? "" : v), z.string().default("")),
  THECATAPI_API_BASE_URL: z.preprocess(
    (v) => (v === "" || v === undefined ? undefined : v),
    z.string().url().default("https://api.thecatapi.com"),
  ),
  THECATAPI_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(30_000).default(10_000),
  DOGCEO_ENABLED: z.preprocess(envFlagTrueByDefault, z.boolean()),
  DOGCEO_IMAGE_RANDOM_URL: z.preprocess(
    (v) => (v === "" || v === undefined ? undefined : v),
    z.string().url().default("https://dog.ceo/api/breeds/image/random"),
  ),
  DOGCEO_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(30_000).default(10_000),
  BOKETE_API_BASE_URL: z.preprocess(
    (v) => (v === "" || v === undefined ? undefined : v),
    z.string().url().default("https://bokete-api-worker.cielgameee.workers.dev"),
  ),
  BOKETE_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(30_000).default(10_000),
    // 川柳（5-7-5）検出（kuromoji）。未設定・空は false

  SENRYU_ENABLED: z.preprocess(envFlagFalseByDefault, z.boolean()),
  SENRYU_REPLY_ENABLED: z.preprocess(envFlagFalseByDefault, z.boolean()),
  SENRYU_SAVE_ENABLED: z.preprocess(envFlagFalseByDefault, z.boolean()),
    // 未設定・空は true

  SENRYU_AUTO_MUTE_ON_PERMISSION_ERROR: z.preprocess(envFlagTrueByDefault, z.boolean()),
  SENRYU_MAX_CONTENT_LENGTH: z.coerce.number().int().min(1).max(4000).default(2000),
    // 各句のモーラ数を ±1 まで許容（0=厳密 5/7/5、1=雑談向けに取りこぼし減）

  SENRYU_MORA_TOLERANCE: z.coerce.number().int().min(0).max(1).default(0),
    // 複数候補があるときスコア最小の1件を選ぶ（先頭候補より全体の 5/7/5 近さを優先）

  SENRYU_BEST_CANDIDATE: z.preprocess(envFlagFalseByDefault, z.boolean()),
    // go-haiku 相当（js-haiku）の find(5-7-5) と候補が一致する場合のみ採用（未設定・空は false）

  SENRYU_JS_HAIKU_VERIFY_ENABLED: z.preprocess(envFlagFalseByDefault, z.boolean()),
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
  JAPANESE_WORKER_ENABLED: z.preprocess(envFlagFalseByDefault, z.boolean()),
  JAPANESE_WORKER_URL: z.preprocess(
    (v) => (v === "" || v === undefined ? undefined : v),
    z.string().url().default("http://127.0.0.1:8787"),
  ),
  JAPANESE_WORKER_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(1_500),
  SENRYU_DETECTOR_MODE: z.preprocess(
    (v) => (v === "" || v === undefined ? undefined : v),
    z.enum(["kuromoji", "go-worker"]).default("kuromoji"),
  ),
  SENRYU_WORKER_FALLBACK_ENABLED: z.preprocess(envFlagTrueByDefault, z.boolean()),
  SENRYU_WORKER_FALLBACK_ON_NO_MATCH: z.preprocess(envFlagFalseByDefault, z.boolean()),
  PACCHI_LEARNING_ANALYZER: z.preprocess(
    (v) => (v === "" || v === undefined ? undefined : v),
    z.enum(["kuromoji", "go-worker"]).default("kuromoji"),
  ),
  PACCHI_PATTERN_LEARNING_ENABLED: z.preprocess(envFlagFalseByDefault, z.boolean()),
  PACCHI_GENERATION_MODE: z.preprocess(
    (v) => (v === "" || v === undefined ? undefined : v),
    z.enum(["template", "slot-template", "learned-pattern", "mixed"]).default("template"),
  ),
  PACCHI_AI_FINAL_CHECK_ENABLED: z.preprocess(envFlagFalseByDefault, z.boolean()),
  PACCHI_WIKIPEDIA_API_BASE_URL: z.preprocess(
    (v) => (v === "" || v === undefined ? undefined : v),
    z.string().url().default("https://ja.wikipedia.org/api/rest_v1/page/summary"),
  ),
  DEEPLOL_WATCHER_ENABLED: z.preprocess(envFlagFalseByDefault, z.boolean()),
  RIOT_API_KEY: z.preprocess((v) => (v === undefined || v === null ? "" : v), z.string().default("")),
  RIOT_PLATFORM_ID: z.preprocess(
    (v) => (v === "" || v === undefined ? undefined : v),
    z.string().min(1).default("jp1"),
  ),
  RIOT_REGIONAL_ROUTING: z.preprocess(
    (v) => (v === "" || v === undefined ? undefined : v),
    z.string().min(1).default("asia"),
  ),
  RIOT_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(12_000),
  DEEPLOL_MATCH_URL_TEMPLATE: z.preprocess(
    envOptionalStringWithoutAssignment("DEEPLOL_MATCH_URL_TEMPLATE"),
    z.string().min(1).optional(),
  ),
  DEEPLOL_POLL_INTERVAL_MS: z.coerce.number().int().min(10_000).default(120_000),
  DEEPLOL_ACTIVE_STALE_MS: z.coerce.number().int().min(60_000).default(3_600_000),
});

type ParsedEnvConfig = z.infer<typeof envSchema>;
export type AppConfig = Omit<ParsedEnvConfig, "LOCAL_LLM_TEMPERATURE"> & {
  LOCAL_LLM_TEMPERATURE: number;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const profiledEnv = applyProfileOverrides(env);
  const japaneseWorkerEnabled =
    profiledEnv.JAPANESE_WORKER_ENABLED === undefined || profiledEnv.JAPANESE_WORKER_ENABLED === ""
      ? profiledEnv.WORKER_ENABLED
      : profiledEnv.JAPANESE_WORKER_ENABLED;
  const envWithLogDefaults = {
    ...profiledEnv,
    OPENAI_MODEL_GPT56: profiledEnv.OPENAI_MODEL_GPT56 || profiledEnv.OPENAI_MODEL,
    JAPANESE_WORKER_ENABLED: japaneseWorkerEnabled,
    MESSAGE_LOG_DB_PATH:
      profiledEnv.MESSAGE_LOG_DB_PATH ||
      profiledEnv.LOG_DB_PATH ||
      profileDataDefaults(resolveBotProfile(profiledEnv)).MESSAGE_LOG_DB_PATH,
    REMINDER_DATABASE_PATH:
      profiledEnv.REMINDER_DATABASE_PATH ||
      profiledEnv.REMINDER_DB_PATH ||
      profileDataDefaults(resolveBotProfile(profiledEnv)).REMINDER_DATABASE_PATH,
  };
  const parsed = envSchema.safeParse(envWithLogDefaults);
  if (!parsed.success) {
    const msg = parsed.error.flatten().fieldErrors;
    throw new Error(`Invalid environment: ${JSON.stringify(msg)}`);
  }
  const data = parsed.data;
  const discordToken = data.DISCORD_TOKEN.trim();
  const guildId = data.GUILD_ID.trim();
  const ownerId = data.OWNER_ID.trim();
  if (!discordToken) {
    throw new Error("DISCORD_TOKEN is empty. Set the bot token from Discord Developer Portal > Bot > Token.");
  }
  if (/^(Bot|Bearer)\s+/i.test(discordToken)) {
    throw new Error("DISCORD_TOKEN must be the raw bot token only. Remove the 'Bot ' or 'Bearer ' prefix.");
  }
  if (!guildId) {
    throw new Error("GUILD_ID を設定してください");
  }
  if (!ownerId) {
    throw new Error("OWNER_ID を設定してください");
  }
  assertValidIanaTimeZone(data.VC_TIME_RANKING_TIMEZONE);
  const localLlmTemperature = data.LOCAL_LLM_TEMPERATURE ?? data.AI_TEMPERATURE;
  const repoRoot = findPackageJsonDir(fileURLToPath(import.meta.url));
  const R = (p: string) => (isAbsolute(p) ? p : join(repoRoot, p));
  return {
    ...data,
    LOCAL_LLM_TEMPERATURE: localLlmTemperature,
    DISCORD_TOKEN: discordToken,
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
