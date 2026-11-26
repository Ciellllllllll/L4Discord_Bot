import { z } from "zod";
import { envFlagTrueByDefault } from "./configEnv.js";

// 設定スキーマ: YouTube・GitHub・ADHD 監視・ゲームセール間隔・人狼。

export const youtubeEnvShape = {
  YOUTUBE_PREVIEW_ENABLED: z.preprocess(envFlagTrueByDefault, z.boolean()),
  YOUTUBE_DATA_API_KEY: z.preprocess((v) => (v === undefined || v === null ? "" : v), z.string().default("")),
  YOUTUBE_REQUEST_TIMEOUT_MS: z.preprocess(
    (v) => (v === "" || v === undefined || v === null ? undefined : v),
    z.coerce.number().int().min(1_000).max(30_000).default(10_000),
  ),
  GITHUB_API_TOKEN: z.preprocess(
    (v) => (v === "" || v === undefined || v === null ? undefined : v),
    z.string().optional(),
  ),
  ADHD_WATCHER_ENABLED: z.preprocess(envFlagTrueByDefault, z.boolean()),
  ADHD_POLL_INTERVAL_MS: z.coerce.number().int().min(60_000).default(60_000),
  ADHD_RSS_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(30_000).default(10_000),
  ADHD_VIDEO_FILES_DIR: z.string().min(1).default("data/production/adhd-videos"),
  ADHD_VIDEO_PUBLIC_BASE_URL: z.preprocess(
    (v) => (v === "" || v === undefined || v === null ? undefined : v),
    z.string().url().startsWith("https://").optional(),
  ),
  ADHD_VIDEO_MIN_FREE_BYTES: z.coerce.number().int().nonnegative().default(1024 * 1024 * 1024),
  ADHD_VIDEO_CACHE_MAX_BYTES: z.coerce.number().int().positive().default(20 * 1024 * 1024 * 1024),
  ADHD_VIDEO_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  GAME_DEAL_STEAM_NOW_INTERVAL_MS: z.coerce.number().int().min(60_000).default(1_800_000),
  GAME_DEAL_EPIC_INTERVAL_MS: z.coerce.number().int().min(60_000).default(3_600_000),
  GAME_DEAL_SUBSCRIPTION_INTERVAL_MS: z.coerce.number().int().min(60_000).default(3_600_000),
  WEREWOLF_CHANNEL_ID: z.preprocess((v) => (v === "" || v === undefined ? undefined : v), z.string().optional()),
};
