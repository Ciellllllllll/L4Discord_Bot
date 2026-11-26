export const DISCORD_API_UNKNOWN_CHANNEL = 10_003;
export const DISCORD_API_UNKNOWN_GUILD = 10_004;
export const DISCORD_API_UNKNOWN_MESSAGE = 10_008;
export const DISCORD_API_UNKNOWN_USER = 10_013;
export const DISCORD_API_MISSING_ACCESS = 50_001;
export const DISCORD_API_CANNOT_SEND_TO_USER = 50_007;
export const DISCORD_API_MISSING_PERMISSIONS = 50_013;

export function getDiscordErrorCode(error: unknown): number | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  const code = Number((error as { code: unknown }).code);
  return Number.isFinite(code) ? code : null;
}

export function getHttpStatus(error: unknown): number | null {
  if (!error || typeof error !== "object" || !("status" in error)) return null;
  const status = Number((error as { status: unknown }).status);
  return Number.isFinite(status) ? status : null;
}

export function isDiscordUnknownChannel(error: unknown): boolean {
  return getDiscordErrorCode(error) === DISCORD_API_UNKNOWN_CHANNEL;
}

export function isDiscordMissingResourceError(error: unknown): boolean {
  const code = getDiscordErrorCode(error);
  return code === DISCORD_API_UNKNOWN_CHANNEL || code === DISCORD_API_UNKNOWN_MESSAGE;
}

export function isDiscordUnknownChannelOrNotFound(error: unknown): boolean {
  return isDiscordUnknownChannel(error) || getHttpStatus(error) === 404;
}

export function isStructuralReminderDeliveryError(error: unknown): boolean {
  return (
    typeof error === "object"
    && error !== null
    && "kind" in error
    && (error as { kind: unknown }).kind === "structural"
  );
}

export function isPermanentReminderDeliveryError(error: unknown): boolean {
  if (isStructuralReminderDeliveryError(error)) {
    return true;
  }
  const code = getDiscordErrorCode(error);
  return (
    code === DISCORD_API_UNKNOWN_CHANNEL
    || code === DISCORD_API_UNKNOWN_GUILD
    || code === DISCORD_API_UNKNOWN_USER
    || code === DISCORD_API_CANNOT_SEND_TO_USER
  );
}

/**
 * チャンネル送信と DM フォールバックの双方が恒久的に回復不能な失敗かどうかを判定する。
 *
 * 50001 (Missing Access) / 50013 (Missing Permissions) は権限設定の修正で回復しうるため
 * 意図的に恒久扱いとしない（単発リマインダーは最大24時間再試行し、繰り返しリマインダーは
 * 5回連続失敗で当該回をスキップして次回へ進める）。
 * なお、繰り返しリマインダーは 50007 (Cannot send messages to this user) 等もユーザー側の
 * 設定変更で回復しうるため、スケジューラ側で自動キャンセルせず当該回をスキップする。
 */
export function isPermanentReminderDeliveryPair(channelError: unknown, dmError: unknown): boolean {
  return isPermanentReminderDeliveryError(channelError) && isPermanentReminderDeliveryError(dmError);
}
