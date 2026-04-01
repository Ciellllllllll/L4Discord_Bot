import type { AppConfig } from "../../core/config.js";

/** DiscordBOTv2: MODMAIL_LOG_CHANNEL_ID → LOG_CHANNEL_ID → LOGGER_CHANNEL_ID */
export function resolveModmailParentChannelId(config: AppConfig): string | undefined {
  const a = config.MODMAIL_LOG_CHANNEL_ID?.trim();
  if (a) return a;
  const b = config.LOG_CHANNEL_ID?.trim();
  if (b) return b;
  const c = config.LOGGER_CHANNEL_ID?.trim();
  return c || undefined;
}
