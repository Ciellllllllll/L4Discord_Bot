import type { AppConfig } from "../../core/config.js";

// Modmail スタッフ用スレッドの親チャンネル。
// MOD_LOG_CHANNEL_ID（Detecter 理由入力・退出通知と同じ）を最優先し、
// 未設定時は DiscordBOTv2 互換で MODMAIL_LOG_CHANNEL_ID → LOG_CHANNEL_ID → LOGGER_CHANNEL_ID。

export function resolveModmailParentChannelId(config: AppConfig): string | undefined {
  const modLog = config.MOD_LOG_CHANNEL_ID?.trim();
  if (modLog) return modLog;
  const a = config.MODMAIL_LOG_CHANNEL_ID?.trim();
  if (a) return a;
  const b = config.LOG_CHANNEL_ID?.trim();
  if (b) return b;
  const c = config.LOGGER_CHANNEL_ID?.trim();
  return c || undefined;
}
