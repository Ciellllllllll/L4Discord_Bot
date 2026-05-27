import type { BotContext } from "../../bot/context.js";
import { getGuildSettingsData, upsertGuildSettingsData } from "../../core/guildSettings.js";

export async function getAiThinkingEnabled(
  ctx: BotContext,
  guildId: string,
  userId: string,
): Promise<boolean> {
  const settings = await getGuildSettingsData(ctx.db, guildId);
  const userValue = settings.ai_thinking_enabled_by_user?.[userId];
  if (typeof userValue === "boolean") {
    return userValue;
  }
  return typeof settings.ai_thinking_enabled === "boolean"
    ? settings.ai_thinking_enabled
    : ctx.config.DEEPSEEK_THINKING_ENABLED;
}

export async function setAiThinkingEnabled(
  ctx: BotContext,
  guildId: string,
  userId: string,
  enabled: boolean,
): Promise<void> {
  const settings = await getGuildSettingsData(ctx.db, guildId);
  await upsertGuildSettingsData(ctx.db, guildId, {
    ai_thinking_enabled_by_user: {
      ...(settings.ai_thinking_enabled_by_user ?? {}),
      [userId]: enabled,
    },
  });
}
