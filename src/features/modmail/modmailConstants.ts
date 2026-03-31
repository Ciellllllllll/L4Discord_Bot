import type { AppConfig } from "../../core/config.js";

export const MODMAIL_TICKET_START_PREFIX = "modmail_ticket_start:";
export const MODMAIL_TICKET_SUBMIT_PREFIX = "modmail_ticket_submit:";
export const MODMAIL_TITLE_FIELD = "modmail_title";
export const MODMAIL_BODY_FIELD = "modmail_body";

/** DiscordBOTv2: MODMAIL_LOG_CHANNEL_ID → LOG_CHANNEL_ID → LOGGER_CHANNEL_ID */
export function resolveModmailParentChannelId(config: AppConfig): string | undefined {
  const a = config.MODMAIL_LOG_CHANNEL_ID?.trim();
  if (a) return a;
  const b = config.LOG_CHANNEL_ID?.trim();
  if (b) return b;
  const c = config.LOGGER_CHANNEL_ID?.trim();
  return c || undefined;
}

export type PendingModmailCtx = {
  createdAt: number;
  guildId: string;
  userId: string;
  buttonFired: boolean;
};

const pendingModmailContexts = new Map<string, PendingModmailCtx>();
const PENDING_TTL_MS = 30 * 60 * 1000;
const CLEANUP_MS = 30 * 1000;

function cleanupPendingModmailContexts(): void {
  const cutoff = Date.now() - PENDING_TTL_MS;
  for (const [key, value] of pendingModmailContexts.entries()) {
    if (value.createdAt < cutoff) pendingModmailContexts.delete(key);
  }
}

setInterval(cleanupPendingModmailContexts, CLEANUP_MS).unref?.();

export function createPendingModmailContext(guildId: string, userId: string): string {
  cleanupPendingModmailContexts();
  const ctxId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  pendingModmailContexts.set(ctxId, {
    createdAt: Date.now(),
    guildId,
    userId,
    buttonFired: false,
  });
  return ctxId;
}

export function getPendingModmailContext(ctxId: string): PendingModmailCtx | undefined {
  return pendingModmailContexts.get(ctxId);
}

export function deletePendingModmailContext(ctxId: string): void {
  pendingModmailContexts.delete(ctxId);
}
