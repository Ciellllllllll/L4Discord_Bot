export const GIF_AUTO_REPLY_URL_MAX_LENGTH = 900;

export type GifAutoReplySetting = {
  trigger_url: string;
  response_url: string;
};

export function parseGifAutoReplyUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (/[\u0000-\u001f\u007f]/.test(value)) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > GIF_AUTO_REPLY_URL_MAX_LENGTH) return null;
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.href.length <= GIF_AUTO_REPLY_URL_MAX_LENGTH ? url.href : null;
  } catch {
    return null;
  }
}

export function parseGifAutoReplySetting(value: unknown): GifAutoReplySetting | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const setting = value as Record<string, unknown>;
  const triggerUrl = parseGifAutoReplyUrl(setting.trigger_url);
  const responseUrl = parseGifAutoReplyUrl(setting.response_url);
  return triggerUrl && responseUrl ? { trigger_url: triggerUrl, response_url: responseUrl } : null;
}
