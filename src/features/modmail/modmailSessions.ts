/** メモリ上のワンショット／排他（DiscordBOTv2 ModmailCog の Map/Set 相当） */

const FILE_SESSION_MS = 10 * 60 * 1000;
const CLEAN_MS = 60 * 1000;
const PENDING_MODMAIL_TICKET_MS = 30 * 60 * 1000;

export type PendingModmailTicketCtx = {
  createdAt: number;
  guildId: string;
  userId: string;
  buttonFired: boolean;
};

/** Ticket.js `pendingModmailContexts` 相当（DM「チケットを作成」→モーダル） */
export const pendingModmailTicketContexts = new Map<string, PendingModmailTicketCtx>();

export const userAttachmentFired = new Set<string>();
export const replyAttachmentFired = new Set<string>();
export const userReplyFired = new Set<string>();
export const replyLocks = new Set<string>();
export const closeLocks = new Set<string>();

type PendingUserReplyRef = {
  channel_id: string;
  message_id: string;
  custom_id: string;
};
export const pendingUserReplyButtons = new Map<string, PendingUserReplyRef>();

type UserAttachSession = {
  mode: "start" | "user_ticket";
  guild_id?: string;
  ticket_id?: string;
  expires_at: number;
};
const pendingUserAttachmentRequests = new Map<string, UserAttachSession>();

type StaffAttachSession = {
  reply_id: string;
  expires_at: number;
};
const pendingStaffAttachmentRequests = new Map<string, StaffAttachSession>();

const closeButtonFired = new Set<string>();

function cleanupUserAttach(): void {
  const now = Date.now();
  for (const [k, v] of pendingUserAttachmentRequests.entries()) {
    if (v.expires_at < now) pendingUserAttachmentRequests.delete(k);
  }
}

function cleanupStaffAttach(): void {
  const now = Date.now();
  for (const [k, v] of pendingStaffAttachmentRequests.entries()) {
    if (v.expires_at < now) pendingStaffAttachmentRequests.delete(k);
  }
}

function cleanupPendingModmailTicketContexts(): void {
  const cutoff = Date.now() - PENDING_MODMAIL_TICKET_MS;
  for (const [key, value] of pendingModmailTicketContexts.entries()) {
    if (value.createdAt < cutoff) pendingModmailTicketContexts.delete(key);
  }
}

setInterval(() => {
  cleanupUserAttach();
  cleanupStaffAttach();
  cleanupPendingModmailTicketContexts();
}, CLEAN_MS).unref?.();

export function setUserAttachmentSession(userId: string, session: Omit<UserAttachSession, "expires_at">): void {
  pendingUserAttachmentRequests.set(userId, {
    ...session,
    expires_at: Date.now() + FILE_SESSION_MS,
  });
}

export function getUserAttachmentSession(userId: string): UserAttachSession | null {
  cleanupUserAttach();
  const s = pendingUserAttachmentRequests.get(userId);
  if (!s || s.expires_at < Date.now()) {
    pendingUserAttachmentRequests.delete(userId);
    return null;
  }
  return s;
}

export function consumeUserAttachmentSession(userId: string): void {
  pendingUserAttachmentRequests.delete(userId);
}

export function setStaffAttachmentSession(threadId: string, staffId: string, replyId: string): void {
  pendingStaffAttachmentRequests.set(`${threadId}:${staffId}`, {
    reply_id: replyId,
    expires_at: Date.now() + FILE_SESSION_MS,
  });
}

export function getStaffAttachmentSession(threadId: string, staffId: string): StaffAttachSession | null {
  cleanupStaffAttach();
  const s = pendingStaffAttachmentRequests.get(`${threadId}:${staffId}`);
  if (!s || s.expires_at < Date.now()) {
    pendingStaffAttachmentRequests.delete(`${threadId}:${staffId}`);
    return null;
  }
  return s;
}

export function consumeStaffAttachmentSession(threadId: string, staffId: string): void {
  pendingStaffAttachmentRequests.delete(`${threadId}:${staffId}`);
}

export function clearStaffAttachmentSessionsByReply(replyId: string): void {
  for (const [key, v] of pendingStaffAttachmentRequests.entries()) {
    if (v.reply_id === replyId) pendingStaffAttachmentRequests.delete(key);
  }
}

export function markCloseButtonFired(key: string): boolean {
  if (closeButtonFired.has(key)) return false;
  closeButtonFired.add(key);
  return true;
}

export function unmarkCloseButtonFired(key: string): void {
  closeButtonFired.delete(key);
}
