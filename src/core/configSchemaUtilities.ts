import { z } from "zod";
import { envFlagFalseByDefault, envFlagTrueByDefault, envOptionalStringWithoutAssignment } from "./configEnv.js";

// 設定スキーマ: ユーティリティ (猫・犬・ボケて)・川柳・ぱっち・LoL 監視。

export const utilitiesEnvShape = {
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
    z.enum(["template", "slot-template", "learned-pattern", "mixed", "tiny-ai"]).default("template"),
  ),
  PACCHI_TINY_AI_URL: z.preprocess(
    (v) => (v === "" || v === undefined ? undefined : v),
    z.string().url().default("http://tiny-ai:8790"),
  ),
  PACCHI_TINY_AI_TIMEOUT_MS: z.preprocess(
    (v) => (v === "" || v === undefined ? undefined : v),
    z.coerce.number().int().min(100).max(30_000).default(5_000),
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
};
