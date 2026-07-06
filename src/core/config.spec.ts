import assert from "node:assert/strict";
import { loadConfig } from "./config.js";

function baseEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    DISCORD_TOKEN: "token",
    DISCORD_CLIENT_ID: "client",
    GUILD_ID: "guild",
    OWNER_ID: "owner",
    ADMIN_ROLE_ID: "admin",
    ...extra,
  };
}

const productionConfig = loadConfig(
  baseEnv({
    PROFILE: "production",
    GAME_DEAL_CHANNEL_ID: "common-game-deal-channel",
    GAME_DEAL_NOTIFY_ROLE_ID: "common-game-deal-role",
    STEAM_WEB_API_KEY: "common-steam-key",
    GAME_DEAL_STEAM_APP_LIST_INTERVAL_MS: "300000",
    GAME_DEAL_STEAM_VERIFY_INTERVAL_MS: "60000",
    GAME_DEAL_STEAM_NOW_INTERVAL_MS: "1800000",
    GAME_DEAL_STEAM_VERIFY_BATCH_SIZE: "20",
    GAME_DEAL_EPIC_INTERVAL_MS: "3600000",
    GAME_DEAL_SUBSCRIPTION_INTERVAL_MS: "3600000",
    PRODUCTION_GAME_DEAL_CHANNEL_ID: "production-game-deal-channel",
    PRODUCTION_GAME_DEAL_NOTIFY_ROLE_ID: "production-game-deal-role",
    PRODUCTION_STEAM_WEB_API_KEY: "production-steam-key",
    PRODUCTION_GAME_DEAL_STEAM_APP_LIST_INTERVAL_MS: "600000",
    PRODUCTION_GAME_DEAL_STEAM_VERIFY_INTERVAL_MS: "120000",
    PRODUCTION_GAME_DEAL_STEAM_NOW_INTERVAL_MS: "2400000",
    PRODUCTION_GAME_DEAL_STEAM_VERIFY_BATCH_SIZE: "40",
    PRODUCTION_GAME_DEAL_EPIC_INTERVAL_MS: "7200000",
    PRODUCTION_GAME_DEAL_SUBSCRIPTION_INTERVAL_MS: "5400000",
    DEBUG_GAME_DEAL_CHANNEL_ID: "debug-game-deal-channel",
    DEBUG_GAME_DEAL_NOTIFY_ROLE_ID: "debug-game-deal-role",
    DEBUG_STEAM_WEB_API_KEY: "debug-steam-key",
    DEBUG_GAME_DEAL_STEAM_APP_LIST_INTERVAL_MS: "180000",
    DEBUG_GAME_DEAL_STEAM_VERIFY_INTERVAL_MS: "30000",
    DEBUG_GAME_DEAL_STEAM_NOW_INTERVAL_MS: "600000",
    DEBUG_GAME_DEAL_STEAM_VERIFY_BATCH_SIZE: "5",
    DEBUG_GAME_DEAL_EPIC_INTERVAL_MS: "120000",
    DEBUG_GAME_DEAL_SUBSCRIPTION_INTERVAL_MS: "180000",
  }),
);

assert.equal(productionConfig.BOT_PROFILE, "production");
assert.equal(productionConfig.GAME_DEAL_CHANNEL_ID, "production-game-deal-channel");
assert.equal(productionConfig.GAME_DEAL_NOTIFY_ROLE_ID, "production-game-deal-role");
assert.equal(productionConfig.STEAM_WEB_API_KEY, "production-steam-key");
assert.equal(productionConfig.GAME_DEAL_STEAM_APP_LIST_INTERVAL_MS, 600000);
assert.equal(productionConfig.GAME_DEAL_STEAM_VERIFY_INTERVAL_MS, 120000);
assert.equal(productionConfig.GAME_DEAL_STEAM_NOW_INTERVAL_MS, 2400000);
assert.equal(productionConfig.GAME_DEAL_STEAM_VERIFY_BATCH_SIZE, 40);
assert.equal(productionConfig.GAME_DEAL_EPIC_INTERVAL_MS, 7200000);
assert.equal(productionConfig.GAME_DEAL_SUBSCRIPTION_INTERVAL_MS, 5400000);

const debugConfig = loadConfig(
  baseEnv({
    PROFILE: "debug",
    GAME_DEAL_CHANNEL_ID: "common-game-deal-channel",
    GAME_DEAL_NOTIFY_ROLE_ID: "common-game-deal-role",
    STEAM_WEB_API_KEY: "common-steam-key",
    GAME_DEAL_STEAM_APP_LIST_INTERVAL_MS: "300000",
    GAME_DEAL_STEAM_VERIFY_INTERVAL_MS: "60000",
    GAME_DEAL_STEAM_NOW_INTERVAL_MS: "1800000",
    GAME_DEAL_STEAM_VERIFY_BATCH_SIZE: "20",
    GAME_DEAL_EPIC_INTERVAL_MS: "3600000",
    GAME_DEAL_SUBSCRIPTION_INTERVAL_MS: "3600000",
    PRODUCTION_GAME_DEAL_CHANNEL_ID: "production-game-deal-channel",
    PRODUCTION_GAME_DEAL_NOTIFY_ROLE_ID: "production-game-deal-role",
    PRODUCTION_STEAM_WEB_API_KEY: "production-steam-key",
    PRODUCTION_GAME_DEAL_STEAM_APP_LIST_INTERVAL_MS: "600000",
    PRODUCTION_GAME_DEAL_STEAM_VERIFY_INTERVAL_MS: "120000",
    PRODUCTION_GAME_DEAL_STEAM_NOW_INTERVAL_MS: "2400000",
    PRODUCTION_GAME_DEAL_STEAM_VERIFY_BATCH_SIZE: "40",
    PRODUCTION_GAME_DEAL_EPIC_INTERVAL_MS: "7200000",
    PRODUCTION_GAME_DEAL_SUBSCRIPTION_INTERVAL_MS: "5400000",
    DEBUG_GAME_DEAL_CHANNEL_ID: "debug-game-deal-channel",
    DEBUG_GAME_DEAL_NOTIFY_ROLE_ID: "debug-game-deal-role",
    DEBUG_STEAM_WEB_API_KEY: "debug-steam-key",
    DEBUG_GAME_DEAL_STEAM_APP_LIST_INTERVAL_MS: "180000",
    DEBUG_GAME_DEAL_STEAM_VERIFY_INTERVAL_MS: "30000",
    DEBUG_GAME_DEAL_STEAM_NOW_INTERVAL_MS: "600000",
    DEBUG_GAME_DEAL_STEAM_VERIFY_BATCH_SIZE: "5",
    DEBUG_GAME_DEAL_EPIC_INTERVAL_MS: "120000",
    DEBUG_GAME_DEAL_SUBSCRIPTION_INTERVAL_MS: "180000",
  }),
);

assert.equal(debugConfig.BOT_PROFILE, "debug");
assert.equal(debugConfig.GAME_DEAL_CHANNEL_ID, "debug-game-deal-channel");
assert.equal(debugConfig.GAME_DEAL_NOTIFY_ROLE_ID, "debug-game-deal-role");
assert.equal(debugConfig.STEAM_WEB_API_KEY, "debug-steam-key");
assert.equal(debugConfig.GAME_DEAL_STEAM_APP_LIST_INTERVAL_MS, 180000);
assert.equal(debugConfig.GAME_DEAL_STEAM_VERIFY_INTERVAL_MS, 30000);
assert.equal(debugConfig.GAME_DEAL_STEAM_NOW_INTERVAL_MS, 600000);
assert.equal(debugConfig.GAME_DEAL_STEAM_VERIFY_BATCH_SIZE, 5);
assert.equal(debugConfig.GAME_DEAL_EPIC_INTERVAL_MS, 120000);
assert.equal(debugConfig.GAME_DEAL_SUBSCRIPTION_INTERVAL_MS, 180000);

const fallbackConfig = loadConfig(
  baseEnv({
    PROFILE: "debug",
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

const localLlmConfig = loadConfig(
  baseEnv({
    PROFILE: "debug",
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
    PROFILE: "debug",
    AI_TEMPERATURE: "0.33",
    LOCAL_LLM_TEMPERATURE: "",
  }),
);

assert.equal(localLlmTemperatureFallbackConfig.LOCAL_LLM_TEMPERATURE, 0.33);

const suffixedProductionConfig = loadConfig(
  baseEnv({
    PROFILE: "production",
    GAME_DEAL_CHANNEL_ID: "common-game-deal-channel",
    GAME_DEAL_CHANNEL_ID_PRODUCTION: "suffixed-production-game-deal-channel",
    GAME_DEAL_CHANNEL_ID_DEBUG: "suffixed-debug-game-deal-channel",
  }),
);

assert.equal(suffixedProductionConfig.GAME_DEAL_CHANNEL_ID, "suffixed-production-game-deal-channel");

const suffixedDebugConfig = loadConfig(
  baseEnv({
    PROFILE: "debug",
    GAME_DEAL_CHANNEL_ID: "common-game-deal-channel",
    GAME_DEAL_CHANNEL_ID_PRODUCTION: "suffixed-production-game-deal-channel",
    GAME_DEAL_CHANNEL_ID_DEBUG: "suffixed-debug-game-deal-channel",
  }),
);

assert.equal(suffixedDebugConfig.GAME_DEAL_CHANNEL_ID, "suffixed-debug-game-deal-channel");

console.log("config.spec.ts: all assertions passed");
