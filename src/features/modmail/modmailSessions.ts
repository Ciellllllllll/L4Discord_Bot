// メモリ上のワンショット／排他（DiscordBOTv2 ModmailCog の Map/Set 相当）


const CLEAN_MS = 60 * 1000;
const PENDING_MODMAIL_TICKET_MS = 30 * 60 * 1000;

export type PendingModmailTicketCtx = {
  createdAt: number;
  guildId: string;
  userId: string;
  buttonFired: boolean;
};

// Ticket.js `pendingModmailContexts` 相当（DM「チケットを作成」→モーダル）

export const pendingModmailTicketContexts = new Map<string, PendingModmailTicketCtx>();

export const replyAttachmentFired = new Set<string>();
export const userReplyFired = new Set<string>();
export const replyLocks = new Set<string>();

type PendingUserReplyRef = {
  channel_id: string;
  message_id: string;
  custom_id: string;
};
export const pendingUserReplyButtons = new Map<string, PendingUserReplyRef>();

const closeButtonFired = new Set<string>();

function cleanupPendingModmailTicketContexts(): void {
  const cutoff = Date.now() - PENDING_MODMAIL_TICKET_MS;
  for (const [key, value] of pendingModmailTicketContexts.entries()) {
    if (value.createdAt < cutoff) pendingModmailTicketContexts.delete(key);
  }
}

setInterval(() => {
  cleanupPendingModmailTicketContexts();
}, CLEAN_MS).unref?.();

export function markCloseButtonFired(key: string): boolean {
  if (closeButtonFired.has(key)) return false;
  closeButtonFired.add(key);
  return true;
}

export function unmarkCloseButtonFired(key: string): void {
  closeButtonFired.delete(key);
}
