import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { applyProfileOverrides, assertValidIanaTimeZone, findPackageJsonDir } from "./configEnv.js";
import { aiEnvShape } from "./configSchemaAi.js";
import { baseEnvShape } from "./configSchemaBase.js";
import { moderationEnvShape } from "./configSchemaModeration.js";
import { utilitiesEnvShape } from "./configSchemaUtilities.js";
import { youtubeEnvShape } from "./configSchemaYoutube.js";

// 環境変数の合成と AppConfig の組み立て。

const envSchema = z.object({
  ...baseEnvShape,
  ...aiEnvShape,
  ...moderationEnvShape,
  ...youtubeEnvShape,
  ...utilitiesEnvShape,
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
    MESSAGE_ATTACHMENT_FILES_DIR: R(data.MESSAGE_ATTACHMENT_FILES_DIR),
    PROMPT_FILE_PATH: R(data.PROMPT_FILE_PATH),
    USER_PROMPT_DIR: R(data.USER_PROMPT_DIR),
    COLD_LAUGH_STORE_PATH: R(data.COLD_LAUGH_STORE_PATH),
    ADHD_VIDEO_FILES_DIR: R(data.ADHD_VIDEO_FILES_DIR),
    SENRYU_KUROMOJI_DICT_PATH: data.SENRYU_KUROMOJI_DICT_PATH ? R(data.SENRYU_KUROMOJI_DICT_PATH) : undefined,
  };
}
