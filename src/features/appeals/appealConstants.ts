import type { AppConfig } from "../../core/config.js";

export const APPEAL_START_PREFIX = "appeal_start:";
export const APPEAL_SUBMIT_PREFIX = "appeal_submit:";
export const APPEAL_REASON_FIELD = "appeal_reason";

/** appeal_rcv|{appealId}|{action} — UUID にコロンが含まれるため区切りは | */
export const APPEAL_REVIEW_PREFIX = "appeal_rcv|";
export const APPEAL_REVIEW_THREAD_PREFIX = "appeal_rcvt|";

export function resolveAppealReviewChannelId(config: AppConfig): string | undefined {
  const a = config.APPEAL_REVIEW_CHANNEL_ID?.trim();
  if (a) return a;
  const b = config.LOG_CHANNEL_ID?.trim();
  if (b) return b;
  const c = config.LOGGER_CHANNEL_ID?.trim();
  if (c) return c;
  const d = config.MODMAIL_LOG_CHANNEL_ID?.trim();
  return d || undefined;
}
