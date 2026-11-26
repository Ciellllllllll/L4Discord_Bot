import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

// 環境変数の解釈と BOT_PROFILE の上書き。

// 未設定・空は true（DiscordBOTv2 / AI_Query 互換）

export function envFlagTrueByDefault(v: unknown): boolean {
  if (v === undefined || v === null || v === "") return true;
  return !["0", "false", "off", "no"].includes(String(v).toLowerCase());
}

// 未設定・空は false

export function envFlagFalseByDefault(v: unknown): boolean {
  if (v === undefined || v === null || v === "") return false;
  return ["1", "true", "on", "yes"].includes(String(v).toLowerCase());
}

// 空は「既定に任せる」。1/true/on/yes で ON、0/false/off/no で OFF

export function envOptionalLogDebug(v: unknown): boolean | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const s = String(v).toLowerCase();
  if (["0", "false", "off", "no"].includes(s)) return false;
  if (["1", "true", "on", "yes"].includes(s)) return true;
  return undefined;
}

export function envOptionalStringWithoutAssignment(key: string): (v: unknown) => string | undefined {
  return (v: unknown) => {
    if (v === "" || v === undefined || v === null) return undefined;
    const trimmed = String(v).trim();
    const prefix = `${key}=`;
    const value = trimmed.toUpperCase().startsWith(prefix) ? trimmed.slice(prefix.length).trim() : trimmed;
    return value || undefined;
  };
}

// 相対パスを package.json があるディレクトリ基準の絶対パスに解決する（cwd ずれ対策）

export function findPackageJsonDir(fromFile: string): string {
  let dir = dirname(fromFile);
  for (;;) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return dirname(fromFile);
    dir = parent;
  }
}

export function assertValidIanaTimeZone(tz: string): void {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz }).format();
  } catch {
    throw new Error(`Invalid VC_TIME_RANKING_TIMEZONE: ${tz}`);
  }
}

export const botProfiles = ["production", "debug"] as const;
export type BotProfile = (typeof botProfiles)[number];

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
  "GITHUB_API_TOKEN",
  "ADHD_WATCHER_ENABLED",
  "ADHD_POLL_INTERVAL_MS",
  "ADHD_RSS_REQUEST_TIMEOUT_MS",
  "ADHD_VIDEO_FILES_DIR",
  "ADHD_VIDEO_PUBLIC_BASE_URL",
  "ADHD_VIDEO_MIN_FREE_BYTES",
  "ADHD_VIDEO_CACHE_MAX_BYTES",
  "ADHD_VIDEO_RETENTION_DAYS",
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
  "OPENROUTER_API_KEY",
  "OPENROUTER_API_BASE",
  "OPENROUTER_MODEL",
  "OPENROUTER_DAILY_TOKEN_LIMIT",
  "MESSAGE_ATTACHMENT_FILES_DIR",
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
  "PACCHI_TINY_AI_URL",
  "PACCHI_TINY_AI_TIMEOUT_MS",
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
    MESSAGE_ATTACHMENT_FILES_DIR: `${base}/message_log_attachments`,
    USER_PROMPT_DIR: `${base}/AI/prompt/user`,
    COLD_LAUGH_STORE_PATH: `${base}/server/json/cold_laugh_counts.json`,
    ADHD_VIDEO_FILES_DIR: `${base}/adhd-videos`,
  };
}

export function applyProfileOverrides(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
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
