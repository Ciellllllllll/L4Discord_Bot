import type { AppConfig } from "../../core/config.js";

/** .env のキー名（ドキュメント・参照用） */
export const MOD_LOG_CHANNEL_ENV_KEY = "MOD_LOG_CHANNEL_ID" as const;

function normalizeSnowflake(value: unknown): string {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) return "";
  return text;
}

/**
 * Detecter がモデレーターへ「理由入力」ボタン付きメッセージを送るチャンネル（新規メッセージ＝ログ末尾に相当）。
 * MOD_LOG_CHANNEL_ID が最優先（Modmail 親・leaveNotifier と揃える）。未設定時は LOGGER → LOG → DETECTER_FALLBACK。
 */
export function resolveModLogChannelId(config: AppConfig): string {
  return (
    normalizeSnowflake(config.MOD_LOG_CHANNEL_ID) ||
    normalizeSnowflake(config.LOGGER_CHANNEL_ID) ||
    normalizeSnowflake(config.LOG_CHANNEL_ID) ||
    normalizeSnowflake(config.DETECTER_FALLBACK_CHANNEL_ID) ||
    ""
  );
}
