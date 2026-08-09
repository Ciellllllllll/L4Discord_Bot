import assert from "node:assert/strict";
import { loadConfig } from "./config.js";

function baseEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    DISCORD_TOKEN: "token",
    DISCORD_CLIENT_ID: "client",
    GUILD_ID: "guild",
    OWNER_ID: "owner",
    ADMIN_ROLE_ID: "admin",
    BOT_PROFILE: "production",
    DATABASE_URL: "postgres://user:pass@127.0.0.1:5432/l4discord_test",
    ...extra,
  };
}

const productionConfig = loadConfig(
  baseEnv({
    BOT_PROFILE: "production",
    GAME_DEAL_CHANNEL_ID: "common-game-deal-channel",
    GAME_DEAL_NOTIFY_ROLE_ID: "common-game-deal-role",
    GAME_DEAL_STEAM_NOW_INTERVAL_MS: "1800000",
    GAME_DEAL_EPIC_INTERVAL_MS: "3600000",
    GAME_DEAL_SUBSCRIPTION_INTERVAL_MS: "3600000",
    YOUTUBE_DATA_API_KEY: "common-youtube-key",
    PRODUCTION_GAME_DEAL_CHANNEL_ID: "production-game-deal-channel",
    PRODUCTION_GAME_DEAL_NOTIFY_ROLE_ID: "production-game-deal-role",
    PRODUCTION_GAME_DEAL_STEAM_NOW_INTERVAL_MS: "2400000",
    PRODUCTION_GAME_DEAL_EPIC_INTERVAL_MS: "7200000",
    PRODUCTION_GAME_DEAL_SUBSCRIPTION_INTERVAL_MS: "5400000",
    PRODUCTION_YOUTUBE_DATA_API_KEY: "production-youtube-key",
    DEBUG_GAME_DEAL_CHANNEL_ID: "debug-game-deal-channel",
    DEBUG_GAME_DEAL_NOTIFY_ROLE_ID: "debug-game-deal-role",
    DEBUG_GAME_DEAL_STEAM_NOW_INTERVAL_MS: "600000",
    DEBUG_GAME_DEAL_EPIC_INTERVAL_MS: "120000",
    DEBUG_GAME_DEAL_SUBSCRIPTION_INTERVAL_MS: "180000",
    DEBUG_YOUTUBE_DATA_API_KEY: "debug-youtube-key",
  }),
);

assert.equal(productionConfig.BOT_PROFILE, "production");
assert.equal(productionConfig.GAME_DEAL_CHANNEL_ID, "production-game-deal-channel");
assert.equal(productionConfig.GAME_DEAL_NOTIFY_ROLE_ID, "production-game-deal-role");
assert.equal(productionConfig.GAME_DEAL_STEAM_NOW_INTERVAL_MS, 2400000);
assert.equal(productionConfig.GAME_DEAL_EPIC_INTERVAL_MS, 7200000);
assert.equal(productionConfig.GAME_DEAL_SUBSCRIPTION_INTERVAL_MS, 5400000);
assert.equal(productionConfig.YOUTUBE_DATA_API_KEY, "production-youtube-key");

const debugConfig = loadConfig(
  baseEnv({
    BOT_PROFILE: "debug",
    GAME_DEAL_CHANNEL_ID: "common-game-deal-channel",
    GAME_DEAL_NOTIFY_ROLE_ID: "common-game-deal-role",
    GAME_DEAL_STEAM_NOW_INTERVAL_MS: "1800000",
    GAME_DEAL_EPIC_INTERVAL_MS: "3600000",
    GAME_DEAL_SUBSCRIPTION_INTERVAL_MS: "3600000",
    YOUTUBE_DATA_API_KEY: "common-youtube-key",
    PRODUCTION_GAME_DEAL_CHANNEL_ID: "production-game-deal-channel",
    PRODUCTION_GAME_DEAL_NOTIFY_ROLE_ID: "production-game-deal-role",
    PRODUCTION_GAME_DEAL_STEAM_NOW_INTERVAL_MS: "2400000",
    PRODUCTION_GAME_DEAL_EPIC_INTERVAL_MS: "7200000",
    PRODUCTION_GAME_DEAL_SUBSCRIPTION_INTERVAL_MS: "5400000",
    PRODUCTION_YOUTUBE_DATA_API_KEY: "production-youtube-key",
    DEBUG_GAME_DEAL_CHANNEL_ID: "debug-game-deal-channel",
    DEBUG_GAME_DEAL_NOTIFY_ROLE_ID: "debug-game-deal-role",
    DEBUG_GAME_DEAL_STEAM_NOW_INTERVAL_MS: "600000",
    DEBUG_GAME_DEAL_EPIC_INTERVAL_MS: "120000",
    DEBUG_GAME_DEAL_SUBSCRIPTION_INTERVAL_MS: "180000",
    DEBUG_YOUTUBE_DATA_API_KEY: "debug-youtube-key",
  }),
);

assert.equal(debugConfig.BOT_PROFILE, "debug");
assert.equal(debugConfig.GAME_DEAL_CHANNEL_ID, "debug-game-deal-channel");
assert.equal(debugConfig.GAME_DEAL_NOTIFY_ROLE_ID, "debug-game-deal-role");
assert.equal(debugConfig.GAME_DEAL_STEAM_NOW_INTERVAL_MS, 600000);
assert.equal(debugConfig.GAME_DEAL_EPIC_INTERVAL_MS, 120000);
assert.equal(debugConfig.GAME_DEAL_SUBSCRIPTION_INTERVAL_MS, 180000);
assert.equal(debugConfig.YOUTUBE_DATA_API_KEY, "debug-youtube-key");

const fallbackConfig = loadConfig(
  baseEnv({
    BOT_PROFILE: "debug",
    GAME_DEAL_CHANNEL_ID: "common-game-deal-channel",
    GAME_DEAL_NOTIFY_ROLE_ID: "common-game-deal-role",
  }),
);

assert.equal(fallbackConfig.GAME_DEAL_CHANNEL_ID, "common-game-deal-channel");
assert.equal(fallbackConfig.GAME_DEAL_NOTIFY_ROLE_ID, "common-game-deal-role");
assert.equal(fallbackConfig.R18_CHANNEL_ID, undefined);
assert.equal(fallbackConfig.LOCAL_LLM_API_BASE, undefined);
assert.equal(fallbackConfig.LOCAL_LLM_API_KEY, "");
assert.equal(fallbackConfig.LOCAL_LLM_MODEL, "Qwen3.6-35B-A3B-Uncensored-HauhauCS-Aggressive-IQ4_XS.gguf");
assert.equal(fallbackConfig.LOCAL_LLM_TIMEOUT_MS, 180000);
assert.equal(fallbackConfig.LOCAL_LLM_MAX_CONCURRENT, 1);
assert.equal(fallbackConfig.LOCAL_LLM_MAX_QUEUE, 3);
assert.equal(fallbackConfig.LOCAL_LLM_TEMPERATURE, fallbackConfig.AI_TEMPERATURE);
assert.equal(fallbackConfig.YOUTUBE_PREVIEW_ENABLED, true);
assert.equal(fallbackConfig.YOUTUBE_DATA_API_KEY, "");
assert.equal(fallbackConfig.YOUTUBE_REQUEST_TIMEOUT_MS, 10000);
assert.equal(fallbackConfig.BOKETE_API_BASE_URL, "https://bokete-api-worker.cielgameee.workers.dev");
assert.equal(fallbackConfig.BOKETE_REQUEST_TIMEOUT_MS, 10000);

const boketeProductionConfig = loadConfig(baseEnv({
  BOT_PROFILE: "production",
  BOKETE_API_BASE_URL: "https://common.bokete.example",
  BOKETE_REQUEST_TIMEOUT_MS: "5000",
  PRODUCTION_BOKETE_API_BASE_URL: "https://production.bokete.example",
  PRODUCTION_BOKETE_REQUEST_TIMEOUT_MS: "12000",
}));
assert.equal(boketeProductionConfig.BOKETE_API_BASE_URL, "https://production.bokete.example");
assert.equal(boketeProductionConfig.BOKETE_REQUEST_TIMEOUT_MS, 12000);
assert.throws(() => loadConfig(baseEnv({ BOKETE_API_BASE_URL: "not a url" })), /BOKETE_API_BASE_URL/);

for (const value of ["0", "false", "off", "no"]) {
  const youtubeDisabledConfig = loadConfig(
    baseEnv({
      BOT_PROFILE: "debug",
      YOUTUBE_PREVIEW_ENABLED: value,
    }),
  );
  assert.equal(youtubeDisabledConfig.YOUTUBE_PREVIEW_ENABLED, false);
}

const youtubeEmptyConfig = loadConfig(
  baseEnv({
    BOT_PROFILE: "debug",
    YOUTUBE_PREVIEW_ENABLED: "",
    YOUTUBE_REQUEST_TIMEOUT_MS: "",
  }),
);

assert.equal(youtubeEmptyConfig.YOUTUBE_PREVIEW_ENABLED, true);
assert.equal(youtubeEmptyConfig.YOUTUBE_REQUEST_TIMEOUT_MS, 10000);

const youtubeNullApiKeyConfig = loadConfig({
  ...baseEnv({ BOT_PROFILE: "debug" }),
  YOUTUBE_DATA_API_KEY: null,
} as unknown as NodeJS.ProcessEnv);

assert.equal(youtubeNullApiKeyConfig.YOUTUBE_DATA_API_KEY, "");

const youtubeTimeoutConfig = loadConfig(
  baseEnv({
    BOT_PROFILE: "debug",
    YOUTUBE_REQUEST_TIMEOUT_MS: "30000",
  }),
);

assert.equal(youtubeTimeoutConfig.YOUTUBE_REQUEST_TIMEOUT_MS, 30000);

assert.throws(
  () => loadConfig(baseEnv({ BOT_PROFILE: "debug", YOUTUBE_REQUEST_TIMEOUT_MS: "999" })),
  /YOUTUBE_REQUEST_TIMEOUT_MS/,
);
assert.throws(
  () => loadConfig(baseEnv({ BOT_PROFILE: "debug", YOUTUBE_REQUEST_TIMEOUT_MS: "30001" })),
  /YOUTUBE_REQUEST_TIMEOUT_MS/,
);

const localLlmConfig = loadConfig(
  baseEnv({
    BOT_PROFILE: "debug",
    AI_TEMPERATURE: "0.42",
    R18_CHANNEL_ID: "r18-channel",
    LOCAL_LLM_API_BASE: "http://127.0.0.1:8080/v1",
    LOCAL_LLM_API_KEY: "local-secret",
    LOCAL_LLM_MODEL: "custom-model.gguf",
    LOCAL_LLM_TIMEOUT_MS: "90000",
    LOCAL_LLM_MAX_CONCURRENT: "2",
    LOCAL_LLM_MAX_QUEUE: "5",
    LOCAL_LLM_TEMPERATURE: "1.1",
  }),
);

assert.equal(localLlmConfig.R18_CHANNEL_ID, "r18-channel");
assert.equal(localLlmConfig.LOCAL_LLM_API_BASE, "http://127.0.0.1:8080/v1");
assert.equal(localLlmConfig.LOCAL_LLM_API_KEY, "local-secret");
assert.equal(localLlmConfig.LOCAL_LLM_MODEL, "custom-model.gguf");
assert.equal(localLlmConfig.LOCAL_LLM_TIMEOUT_MS, 90000);
assert.equal(localLlmConfig.LOCAL_LLM_MAX_CONCURRENT, 2);
assert.equal(localLlmConfig.LOCAL_LLM_MAX_QUEUE, 5);
assert.equal(localLlmConfig.LOCAL_LLM_TEMPERATURE, 1.1);

const localLlmTemperatureFallbackConfig = loadConfig(
  baseEnv({
    BOT_PROFILE: "debug",
    AI_TEMPERATURE: "0.33",
    LOCAL_LLM_TEMPERATURE: "",
  }),
);

assert.equal(localLlmTemperatureFallbackConfig.LOCAL_LLM_TEMPERATURE, 0.33);

const suffixedProductionConfig = loadConfig(
  baseEnv({
    BOT_PROFILE: "production",
    GAME_DEAL_CHANNEL_ID: "common-game-deal-channel",
    GAME_DEAL_CHANNEL_ID_PRODUCTION: "suffixed-production-game-deal-channel",
    GAME_DEAL_CHANNEL_ID_DEBUG: "suffixed-debug-game-deal-channel",
  }),
);

assert.equal(suffixedProductionConfig.GAME_DEAL_CHANNEL_ID, "common-game-deal-channel");

const suffixedDebugConfig = loadConfig(
  baseEnv({
    BOT_PROFILE: "debug",
    GAME_DEAL_CHANNEL_ID: "common-game-deal-channel",
    GAME_DEAL_CHANNEL_ID_PRODUCTION: "suffixed-production-game-deal-channel",
    GAME_DEAL_CHANNEL_ID_DEBUG: "suffixed-debug-game-deal-channel",
  }),
);

assert.equal(suffixedDebugConfig.GAME_DEAL_CHANNEL_ID, "common-game-deal-channel");

assert.throws(
  () => loadConfig(baseEnv({ BOT_PROFILE: undefined, PROFILE: "debug" })),
  /BOT_PROFILE/,
);
assert.throws(
  () => loadConfig(baseEnv({ BOT_PROFILE: undefined, APP_ENV: "debug" })),
  /BOT_PROFILE/,
);
assert.throws(
  () => loadConfig(baseEnv({ BOT_PROFILE: "prod" })),
  /BOT_PROFILE/,
);

const openAiDefaultsConfig = loadConfig(baseEnv({ BOT_PROFILE: "production" }));

assert.equal(openAiDefaultsConfig.OPENAI_API_KEY, "");
assert.equal(openAiDefaultsConfig.OPENAI_ADMIN_KEY, "");
assert.equal(openAiDefaultsConfig.OPENAI_PROJECT_ID, "");
assert.equal(openAiDefaultsConfig.OPENAI_API_BASE, "https://api.openai.com/v1");
assert.equal(openAiDefaultsConfig.OPENAI_MODEL_GPT56, "gpt-5.6-terra");
assert.equal(openAiDefaultsConfig.OPENAI_MODEL_GPT54_MINI, "gpt-5.4-mini-2026-03-17");
assert.equal(openAiDefaultsConfig.OPENAI_REASONING_EFFORT, "high");
assert.equal(openAiDefaultsConfig.OPENAI_FALLBACK_THRESHOLD, 2_400_000);
assert.equal(openAiDefaultsConfig.OPENAI_USAGE_CACHE_MS, 30_000);
assert.equal(openAiDefaultsConfig.OPENAI_MAX_COMPLETION_TOKENS, 8_192);

const openAiNullKeysConfig = loadConfig({
  ...baseEnv({ BOT_PROFILE: "production" }),
  OPENAI_API_KEY: null,
  OPENAI_ADMIN_KEY: null,
  OPENAI_PROJECT_ID: null,
} as unknown as NodeJS.ProcessEnv);

assert.equal(openAiNullKeysConfig.OPENAI_API_KEY, "");
assert.equal(openAiNullKeysConfig.OPENAI_ADMIN_KEY, "");
assert.equal(openAiNullKeysConfig.OPENAI_PROJECT_ID, "");

const openAiProfileConfig = loadConfig(
  baseEnv({
    BOT_PROFILE: "debug",
    OPENAI_API_KEY: "common-api-key",
    OPENAI_ADMIN_KEY: "common-admin-key",
    OPENAI_PROJECT_ID: "common-project",
    OPENAI_API_BASE: "https://common.openai.example/v1",
    OPENAI_MODEL_GPT56: "common-gpt56-model",
    OPENAI_MODEL_GPT54_MINI: "common-gpt54-mini-model",
    OPENAI_REASONING_EFFORT: "low",
    OPENAI_FALLBACK_THRESHOLD: "900000",
    OPENAI_USAGE_CACHE_MS: "1000",
    OPENAI_MAX_COMPLETION_TOKENS: "1024",
    DEBUG_OPENAI_API_KEY: "debug-api-key",
    DEBUG_OPENAI_ADMIN_KEY: "debug-admin-key",
    DEBUG_OPENAI_PROJECT_ID: "debug-project",
    DEBUG_OPENAI_API_BASE: "https://debug.openai.example/v1",
    DEBUG_OPENAI_MODEL_GPT56: "debug-gpt56-model",
    DEBUG_OPENAI_MODEL_GPT54_MINI: "debug-gpt54-mini-model",
    DEBUG_OPENAI_REASONING_EFFORT: "xhigh",
    DEBUG_OPENAI_FALLBACK_THRESHOLD: "2900000",
    DEBUG_OPENAI_USAGE_CACHE_MS: "0",
    DEBUG_OPENAI_MAX_COMPLETION_TOKENS: "4096",
  }),
);

assert.equal(openAiProfileConfig.OPENAI_API_KEY, "debug-api-key");
assert.equal(openAiProfileConfig.OPENAI_ADMIN_KEY, "debug-admin-key");
assert.equal(openAiProfileConfig.OPENAI_PROJECT_ID, "debug-project");
assert.equal(openAiProfileConfig.OPENAI_API_BASE, "https://debug.openai.example/v1");
assert.equal(openAiProfileConfig.OPENAI_MODEL_GPT56, "debug-gpt56-model");
assert.equal(openAiProfileConfig.OPENAI_MODEL_GPT54_MINI, "debug-gpt54-mini-model");
assert.equal(openAiProfileConfig.OPENAI_REASONING_EFFORT, "xhigh");
assert.equal(openAiProfileConfig.OPENAI_FALLBACK_THRESHOLD, 2_900_000);
assert.equal(openAiProfileConfig.OPENAI_USAGE_CACHE_MS, 0);
assert.equal(openAiProfileConfig.OPENAI_MAX_COMPLETION_TOKENS, 4_096);

const openAiLegacyModelConfig = loadConfig(baseEnv({
  OPENAI_MODEL: "legacy-terra-model",
}));
assert.equal(openAiLegacyModelConfig.OPENAI_MODEL_GPT56, "legacy-terra-model");

const openAiNewModelPrecedenceConfig = loadConfig(baseEnv({
  OPENAI_MODEL: "legacy-terra-model",
  OPENAI_MODEL_GPT56: "new-terra-model",
}));
assert.equal(openAiNewModelPrecedenceConfig.OPENAI_MODEL_GPT56, "new-terra-model");

for (const [key, value] of [
  ["OPENAI_FALLBACK_THRESHOLD", "0"],
  ["OPENAI_MAX_COMPLETION_TOKENS", "0"],
] as const) {
  assert.throws(() => loadConfig(baseEnv({ [key]: value })), new RegExp(key));
}

assert.throws(() => loadConfig(baseEnv({ OPENAI_USAGE_CACHE_MS: "-1" })), /OPENAI_USAGE_CACHE_MS/);
assert.throws(() => loadConfig(baseEnv({ OPENAI_REASONING_EFFORT: "max" })), /OPENAI_REASONING_EFFORT/);

console.log("config.spec.ts: all assertions passed");
