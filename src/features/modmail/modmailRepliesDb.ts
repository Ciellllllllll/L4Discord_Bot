import type { CoreDeps } from "../../core/deps.js";
import { nowIso } from "../../core/db/nowIso.js";
import {
  attachmentMetaToJson,
  mergeAttachmentLists,
  parseAttachmentMetadata,
  type AttachmentMeta,
} from "../../core/discordAttachments.js";

export const REPLY_STATUS = {
  PENDING: "Pending",
  APPROVED_SENT: "ApprovedSent",
  REJECTED: "Rejected",
  FAILED: "Failed",
  CANCELLED_SOURCE_DELETE: "CancelledBySourceDelete",
  CANCELLED_TICKET_CLOSE: "CancelledByTicketClose",
} as const;

export type ModmailReplyRow = {
  id: string;
  ticket_id: string;
  appeal_id: string | null;
  guild_id: string;
  user_id: string;
  thread_id: string;
  status: string;
  source_message_id: string;
  confirm_message_id: string | null;
  author_staff_id: string;
  approver_staff_id: string | null;
  content: string | null;
  fixed_reply_body: string;
  attachment_metadata: string;
  created_at: Date;
  updated_at: Date;
  approved_at: Date | null;
  rejected_at: Date | null;
  sent_at: Date | null;
  failed_at: Date | null;
  cancelled_at: Date | null;
  cancel_reason: string | null;
  failure_reason: string | null;
  close_reason: string | null;
};

function asReplyRow(r: Record<string, unknown>): ModmailReplyRow {
  return r as unknown as ModmailReplyRow;
}

export async function replyById(ctx: Pick<CoreDeps, "ticketDb">, id: string): Promise<ModmailReplyRow | undefined> {
  const row = await ctx.ticketDb.selectFrom("modmail_replies").selectAll().where("id", "=", id).executeTakeFirst();
  return row ? asReplyRow(row as Record<string, unknown>) : undefined;
}

export async function pendingReplyByTicket(ctx: Pick<CoreDeps, "ticketDb">, ticketId: string): Promise<ModmailReplyRow | undefined> {
  const row = await ctx.ticketDb
    .selectFrom("modmail_replies")
    .selectAll()
    .where("ticket_id", "=", ticketId)
    .where("status", "=", REPLY_STATUS.PENDING)
    .orderBy("created_at", "desc")
    .executeTakeFirst();
  return row ? asReplyRow(row as Record<string, unknown>) : undefined;
}

export async function allPendingReplies(ctx: Pick<CoreDeps, "ticketDb">): Promise<ModmailReplyRow[]> {
  const rows = await ctx.ticketDb
    .selectFrom("modmail_replies")
    .selectAll()
    .where("status", "=", REPLY_STATUS.PENDING)
    .orderBy("created_at", "asc")
    .execute();
  return rows.map((r) => asReplyRow(r as Record<string, unknown>));
}

export async function pendingRepliesBySource(ctx: Pick<CoreDeps, "ticketDb">, sourceMessageId: string): Promise<ModmailReplyRow[]> {
  const rows = await ctx.ticketDb
    .selectFrom("modmail_replies")
    .selectAll()
    .where("source_message_id", "=", sourceMessageId)
    .where("status", "=", REPLY_STATUS.PENDING)
    .execute();
  return rows.map((r) => asReplyRow(r as Record<string, unknown>));
}

export async function pendingRepliesByTicket(ctx: Pick<CoreDeps, "ticketDb">, ticketId: string): Promise<ModmailReplyRow[]> {
  const rows = await ctx.ticketDb
    .selectFrom("modmail_replies")
    .selectAll()
    .where("ticket_id", "=", ticketId)
    .where("status", "=", REPLY_STATUS.PENDING)
    .execute();
  return rows.map((r) => asReplyRow(r as Record<string, unknown>));
}

export async function pendingRepliesByAppealId(ctx: Pick<CoreDeps, "ticketDb">, appealId: string): Promise<ModmailReplyRow[]> {
  const rows = await ctx.ticketDb
    .selectFrom("modmail_replies")
    .selectAll()
    .where("appeal_id", "=", appealId)
    .where("status", "=", REPLY_STATUS.PENDING)
    .execute();
  return rows.map((r) => asReplyRow(r as Record<string, unknown>));
}

export async function createReplyRow(ctx: Pick<CoreDeps, "ticketDb">, input: {
  id: string;
  ticket_id: string;
  appeal_id?: string | null;
  guild_id: string;
  user_id: string;
  thread_id: string;
  source_message_id: string;
  author_staff_id: string;
  content: string | null;
  fixed_reply_body: string;
  attachment_metadata: string;
}): Promise<void> {
  const ts = nowIso();
  await ctx.ticketDb
    .insertInto("modmail_replies")
    .values({
      id: input.id,
      ticket_id: input.ticket_id,
      appeal_id: input.appeal_id ?? null,
      guild_id: input.guild_id,
      user_id: input.user_id,
      thread_id: input.thread_id,
      status: REPLY_STATUS.PENDING,
      source_message_id: input.source_message_id,
      confirm_message_id: null,
      author_staff_id: input.author_staff_id,
      approver_staff_id: null,
      content: input.content,
      fixed_reply_body: input.fixed_reply_body,
      attachment_metadata: input.attachment_metadata,
      created_at: ts as unknown as Date,
      updated_at: ts as unknown as Date,
      approved_at: null,
      rejected_at: null,
      sent_at: null,
      failed_at: null,
      cancelled_at: null,
      cancel_reason: null,
      failure_reason: null,
      close_reason: null,
    })
    .execute();
}

export async function setReplyConfirmMessageId(ctx: Pick<CoreDeps, "ticketDb">, replyId: string, confirmId: string): Promise<void> {
  const ts = nowIso();
  await ctx.ticketDb
    .updateTable("modmail_replies")
    .set({
      confirm_message_id: confirmId,
      updated_at: ts as unknown as Date,
    })
    .where("id", "=", replyId)
    .execute();
}

export async function updateReplyStatus(
  ctx: Pick<CoreDeps, "ticketDb">,
  replyId: string,
  fromStatus: string,
  toStatus: string,
  patch: Partial<{
    approver_staff_id: string | null;
    approved_at: string | null;
    rejected_at: string | null;
    sent_at: string | null;
    failed_at: string | null;
    cancelled_at: string | null;
    cancel_reason: string | null;
    failure_reason: string | null;
    close_reason: string | null;
  }>,
): Promise<number> {
  const ts = nowIso();
  const result = await ctx.ticketDb
    .updateTable("modmail_replies")
    .set({
      status: toStatus,
      updated_at: ts as unknown as Date,
      ...(patch as Record<string, unknown>),
    } as never)
    .where("id", "=", replyId)
    .where("status", "=", fromStatus)
    .executeTakeFirst();
  return Number(result.numUpdatedRows ?? 0);
}

export async function appendReplyAttachmentsMeta(
  ctx: Pick<CoreDeps, "ticketDb">,
  replyId: string,
  extra: AttachmentMeta[],
): Promise<boolean> {
  const row = await replyById(ctx, replyId);
  if (!row) return false;
  const base = parseAttachmentMetadata(row.attachment_metadata);
  const merged = mergeAttachmentLists(base, extra);
  const ts = nowIso();
  await ctx.ticketDb
    .updateTable("modmail_replies")
    .set({
      attachment_metadata: attachmentMetaToJson(merged),
      updated_at: ts as unknown as Date,
    })
    .where("id", "=", replyId)
    .execute();
  return true;
}
