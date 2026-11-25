export const DISCORD_API_UNKNOWN_CHANNEL = 10_003;
export const DISCORD_API_UNKNOWN_MESSAGE = 10_008;

export function getDiscordErrorCode(error: unknown): number | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  const code = Number((error as { code: unknown }).code);
  return Number.isFinite(code) ? code : null;
}

export function isDiscordUnknownChannel(error: unknown): boolean {
  return getDiscordErrorCode(error) === DISCORD_API_UNKNOWN_CHANNEL;
}

export function isDiscordMissingResourceError(error: unknown): boolean {
  const code = getDiscordErrorCode(error);
  return code === DISCORD_API_UNKNOWN_CHANNEL || code === DISCORD_API_UNKNOWN_MESSAGE;
}
