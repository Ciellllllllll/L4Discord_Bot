import { z } from "zod";
import { envFlagFalseByDefault, envFlagTrueByDefault } from "./configEnv.js";

// 設定スキーマ: AI プロバイダ・プロンプト・履歴。

export const aiEnvShape = {
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
  OPENROUTER_API_KEY: z.preprocess((v) => (v === undefined || v === null ? "" : v), z.string().default("")),
  OPENROUTER_API_BASE: z.preprocess(
    (v) => (v === "" || v === undefined || v === null ? undefined : v),
    z.string().url().default("https://openrouter.ai/api/v1"),
  ),
  OPENROUTER_MODEL: z.preprocess(
    (v) => (v === "" || v === undefined || v === null ? undefined : v),
    z.string().min(1).default("openrouter/auto"),
  ),
  // OpenRouter 経由の1日あたりのトークン上限（UTC基準）。この上限に達すると DeepSeek へ退避します。
  OPENROUTER_DAILY_TOKEN_LIMIT: z.coerce.number().int().positive().default(1_000_000),
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
};
