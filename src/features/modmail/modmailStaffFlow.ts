import { ComponentCardBuilder, componentCardsPayload } from "../panels/componentCard.js";
import {
  type APIInteractionGuildMember,
  type Guild,
  type GuildMember,
  type Message,
  PermissionFlagsBits,
  PermissionsBitField,
} from "discord.js";
import type { BotContext } from "../../bot/context.js";
import { sqliteTimestamp } from "../../core/db/sqliteTimestamp.js";
import { getAppealById, getAppealHoldByThreadId } from "../appeals/appealService.js";
import {
  attachmentMetaToJson,
  buildForwardDmFiles,
  parseAttachmentMetadata,
  serializeAttachmentsFromMessage,
} from "./modmailAttachmentUtils.js";
import { logModmailEvent } from "./modmailEventsLog.js";
import { MODMAIL_REPLY_COMMAND } from "./modmailIds.js";
import {
  createReplyRow,
  pendingReplyByTicket,
  pendingRepliesByAppealId,
  pendingRepliesBySource,
  pendingRepliesByTicket,
  type ModmailReplyRow,
  REPLY_STATUS,
  replyById,
  setReplyConfirmMessageId,
  updateReplyStatus,
} from "./modmailRepliesDb.js";
import { replyLocks } from "./modmailSessions.js";
import {
  closeModmailTicketInDb,
  getModmailTicketRow,
  getOpenModmailByThreadId,
  ticketDisplayCode,
} from "./modmailService.js";
import { buildModmailConfirmRow, buildModmailUserReplyRow } from "./modmailUi.js";
import { randomUUID } from "node:crypto";

function trimMax(text: string, n: number): string {
  const s = text.trim();
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}

export function extractModmailReplyBody(content: string): string | null {
  if (!content.startsWith(MODMAIL_REPLY_COMMAND)) return null;
  return content.slice(MODMAIL_REPLY_COMMAND.length).replace(/^\s+/, "");
}

export async function isModmailStaff(
  guild: Guild,
  userId: string,
  member: GuildMember | APIInteractionGuildMember | null,
  ctx: BotContext,
): Promise<boolean> {
  const roleId = ctx.config.ADMIN_ROLE_ID?.trim();
  if (member && !("guild" in member)) {
    const api = member as APIInteractionGuildMember;
    if (roleId && api.roles.includes(roleId)) return true;
    const perms = new PermissionsBitField(BigInt(api.permissions ?? "0"));
    return (
      perms.has(PermissionFlagsBits.ManageMessages) ||
      perms.has(PermissionFlagsBits.ManageGuild)
    );
  }
  let m = member as GuildMember | null;
  if (!m) m = await guild.members.fetch(userId).catch(() => null);
  if (!m) return false;
  if (roleId && m.roles.cache.has(roleId)) return true;
  return (
    m.permissions.has(PermissionFlagsBits.ManageMessages) ||
    m.permissions.has(PermissionFlagsBits.ManageGuild)
  );
}

export function confirmReplyText(reply: {
  fixed_reply_body: string;
  attachment_metadata: string;
  ticket_id: string;
  author_staff_id: string;
  created_at: Date;
  appeal_code?: string | null;
}): string {
  const preview = trimMax(reply.fixed_reply_body || "", 1200) || "(本文なし)";
  const n = parseAttachmentMetadata(reply.attachment_metadata).length;
  const destLabel = reply.appeal_code
    ? `異議申し立て ${reply.appeal_code}`
    : `チケット ${ticketDisplayCode(reply.ticket_id)}`;
  return [
    "このメッセージをユーザーへ送信しますか？",
    `送信先: ${destLabel}`,
    `送信本文: ${preview}`,
    `添付ファイル: ${n} 件`,
    `!reply 実行スタッフID: ${reply.author_staff_id}`,
    `作成日時: <t:${Math.floor(new Date(reply.created_at).getTime() / 1000)}:F>`,
  ].join("\n");
}

export async function confirmReplyTextResolved(ctx: BotContext, reply: ModmailReplyRow): Promise<string> {
  let appealCode: string | undefined;
  if (reply.appeal_id) {
    const a = await getAppealById(ctx, reply.appeal_id);
    appealCode = a?.code;
  }
  return confirmReplyText({ ...reply, appeal_code: appealCode });
}

export async function editModmailConfirmMessage(
  ctx: BotContext,
  reply: {
    guild_id: string;
    thread_id: string;
    confirm_message_id: string | null;
    id: string;
    author_staff_id: string;
    fixed_reply_body: string;
    attachment_metadata: string;
    ticket_id: string;
    created_at: Date;
  },
  text: string,
  fallbackMessage?: Message | null,
): Promise<void> {
  if (fallbackMessage && reply.confirm_message_id && fallbackMessage.id === reply.confirm_message_id) {
    await fallbackMessage.edit({ content: text, components: [] }).catch(() => undefined);
    return;
  }
  const guild = await ctx.client.guilds.fetch(reply.guild_id).catch(() => null);
  if (!guild) return;
  const ch = await guild.channels.fetch(reply.thread_id).catch(() => null);
  if (!ch?.isTextBased()) return;
  const msg = await ch.messages.fetch(String(reply.confirm_message_id ?? "")).catch(() => null);
  if (!msg) return;
  await msg.edit({ content: text, components: [] }).catch(() => undefined);
}

export async function cancelPendingRepliesBySource(ctx: BotContext, sourceMessageId: string): Promise<void> {
  const rows = await pendingRepliesBySource(ctx, sourceMessageId);
  const at = sqliteTimestamp();
  for (const row of rows) {
    const ok = await updateReplyStatus(ctx, row.id, REPLY_STATUS.PENDING, REPLY_STATUS.CANCELLED_SOURCE_DELETE, {
      cancelled_at: at,
      cancel_reason: "source_message_deleted",
    });
    if (ok === 0) continue;
    await editModmailConfirmMessage(ctx, row, "非承認のため送信しませんでした（元メッセージ削除）。");
    void logModmailEvent(ctx, "REPLY_CANCELLED_SOURCE_DELETE", { reply_id: row.id, ticket_id: row.ticket_id });
  }
}

export async function cancelPendingRepliesByTicket(
  ctx: BotContext,
  ticketId: string,
  reason: string,
  closerId: string,
): Promise<void> {
  const rows = await pendingRepliesByTicket(ctx, ticketId);
  const at = sqliteTimestamp();
  for (const row of rows) {
    const ok = await updateReplyStatus(ctx, row.id, REPLY_STATUS.PENDING, REPLY_STATUS.CANCELLED_TICKET_CLOSE, {
      cancelled_at: at,
      cancel_reason: "ticket_closed",
      close_reason: reason,
    });
    if (ok === 0) continue;
    await editModmailConfirmMessage(ctx, row, "チケットクローズのためキャンセルされました。");
    void logModmailEvent(ctx, "REPLY_CANCELLED_TICKET_CLOSE", {
      reply_id: row.id,
      ticket_id: ticketId,
      closer_staff_id: closerId,
    });
  }
}

export async function cancelPendingRepliesByAppeal(ctx: BotContext, appealId: string): Promise<void> {
  const rows = await pendingRepliesByAppealId(ctx, appealId);
  const at = sqliteTimestamp();
  for (const row of rows) {
    const ok = await updateReplyStatus(ctx, row.id, REPLY_STATUS.PENDING, REPLY_STATUS.CANCELLED_TICKET_CLOSE, {
      cancelled_at: at,
      cancel_reason: "appeal_resolved",
    });
    if (ok === 0) continue;
    await editModmailConfirmMessage(ctx, row, "異議申し立てが終了したためキャンセルされました。");
    void logModmailEvent(ctx, "REPLY_CANCELLED_APPEAL_RESOLVED", { reply_id: row.id, appeal_id: appealId });
  }
}

export async function approveModmailReply(
  ctx: BotContext,
  replyId: string,
  staffId: string,
  confirmInteractionMessage: Message | null,
): Promise<{ ok: boolean; message: string }> {
  const reply = await replyById(ctx, replyId);
  if (!reply) return { ok: false, message: "返信予約が見つかりません。" };
  if (reply.status !== REPLY_STATUS.PENDING) return { ok: false, message: "この返信予約は既に処理済みです。" };

  if (reply.appeal_id) {
    const appeal = await getAppealById(ctx, reply.appeal_id);
    if (!appeal || appeal.status !== "hold") {
      const at = sqliteTimestamp();
      await updateReplyStatus(ctx, reply.id, REPLY_STATUS.PENDING, REPLY_STATUS.CANCELLED_TICKET_CLOSE, {
        cancelled_at: at,
        cancel_reason: "appeal_not_hold",
      });
      await editModmailConfirmMessage(ctx, reply, "保留審査が終了しているため承認できません。", confirmInteractionMessage);
      return { ok: false, message: "この異議申し立ては保留中ではありません。" };
    }

    const at = sqliteTimestamp();
    const ok = await updateReplyStatus(ctx, reply.id, REPLY_STATUS.PENDING, REPLY_STATUS.APPROVED_SENT, {
      approver_staff_id: staffId,
      approved_at: at,
      sent_at: at,
    });
    if (ok === 0) return { ok: false, message: "この返信予約は既に処理済みです。" };

    void logModmailEvent(ctx, "REPLY_APPROVED", { reply_id: reply.id, appeal_id: appeal.id });

    let dmErr: unknown = null;
    try {
      const user = await ctx.client.users.fetch(appeal.user_id);
      const forwarded = await buildForwardDmFiles(reply.attachment_metadata);
      const failedNote =
        forwarded.failed.length > 0
          ? `\n\n一部の添付は直接転送できなかったためリンクを共有します:\n${forwarded.failed.slice(0, 5).join("\n")}`
          : "";
      await user.send({
        ...componentCardsPayload(
          [
            new ComponentCardBuilder()
            .setTitle("お問い合わせ返信")
            .setDescription(`${reply.fixed_reply_body || "(本文なし)"}${failedNote}`)
            .setFooter({ text: "返信するボタン、または !send 本文 で返信できます。" })
            .setTimestamp(new Date()),
          ],
          [buildModmailUserReplyRow(appeal.id, appeal.user_id)],
        ),
        files: forwarded.files,
      });
    } catch (e) {
      dmErr = e;
    }

    if (dmErr) {
      const ft = sqliteTimestamp();
      await updateReplyStatus(ctx, reply.id, REPLY_STATUS.APPROVED_SENT, REPLY_STATUS.FAILED, {
        failed_at: ft,
        failure_reason: String(dmErr),
      });
      await editModmailConfirmMessage(ctx, reply, "送信失敗", confirmInteractionMessage);
      void logModmailEvent(ctx, "REPLY_SEND_FAILED", { reply_id: reply.id, err: String(dmErr) });
      return { ok: false, message: "ユーザーへの DM 送信に失敗しました。" };
    }

    await editModmailConfirmMessage(ctx, reply, "送信済み", confirmInteractionMessage);
    void logModmailEvent(ctx, "REPLY_SENT", { reply_id: reply.id, appeal_id: appeal.id });
    return { ok: true, message: "送信しました。" };
  }

  const ticket = await getModmailTicketRow(ctx, reply.ticket_id);
  if (!ticket || ticket.status !== "open") {
    const at = sqliteTimestamp();
    await updateReplyStatus(ctx, reply.id, REPLY_STATUS.PENDING, REPLY_STATUS.CANCELLED_TICKET_CLOSE, {
      cancelled_at: at,
      cancel_reason: "ticket_closed",
    });
    await editModmailConfirmMessage(ctx, reply, "チケットがクローズされているため承認できません。", confirmInteractionMessage);
    return { ok: false, message: "チケットがクローズされています。" };
  }

  const at = sqliteTimestamp();
  const ok = await updateReplyStatus(ctx, reply.id, REPLY_STATUS.PENDING, REPLY_STATUS.APPROVED_SENT, {
    approver_staff_id: staffId,
    approved_at: at,
    sent_at: at,
  });
  if (ok === 0) return { ok: false, message: "この返信予約は既に処理済みです。" };

  void logModmailEvent(ctx, "REPLY_APPROVED", { reply_id: reply.id, ticket_id: ticket.id });

  let dmErr: unknown = null;
  try {
    const user = await ctx.client.users.fetch(ticket.user_id);
    const forwarded = await buildForwardDmFiles(reply.attachment_metadata);
    const failedNote =
      forwarded.failed.length > 0
        ? `\n\n一部の添付は直接転送できなかったためリンクを共有します:\n${forwarded.failed.slice(0, 5).join("\n")}`
        : "";
    await user.send({
      ...componentCardsPayload(
        [
          new ComponentCardBuilder()
          .setTitle("お問い合わせ返信")
          .setDescription(`${reply.fixed_reply_body || "(本文なし)"}${failedNote}`)
          .setFooter({ text: "返信するボタン、または !send 本文 で返信できます。" })
          .setTimestamp(new Date()),
        ],
        [buildModmailUserReplyRow(ticket.id, ticket.user_id)],
      ),
      files: forwarded.files,
    });
  } catch (e) {
    dmErr = e;
  }

  if (dmErr) {
    const ft = sqliteTimestamp();
    await updateReplyStatus(ctx, reply.id, REPLY_STATUS.APPROVED_SENT, REPLY_STATUS.FAILED, {
      failed_at: ft,
      failure_reason: String(dmErr),
    });
    await editModmailConfirmMessage(ctx, reply, "送信失敗", confirmInteractionMessage);
    void logModmailEvent(ctx, "REPLY_SEND_FAILED", { reply_id: reply.id, err: String(dmErr) });
    return { ok: false, message: "ユーザーへの DM 送信に失敗しました。" };
  }

  await editModmailConfirmMessage(ctx, reply, "送信済み", confirmInteractionMessage);
  void logModmailEvent(ctx, "REPLY_SENT", { reply_id: reply.id, ticket_id: ticket.id });
  return { ok: true, message: "送信しました。" };
}

export async function rejectModmailReply(
  ctx: BotContext,
  replyId: string,
  staffId: string,
  confirmInteractionMessage: Message | null,
): Promise<{ ok: boolean; message: string }> {
  const reply = await replyById(ctx, replyId);
  if (!reply) return { ok: false, message: "返信予約が見つかりません。" };
  if (reply.status !== REPLY_STATUS.PENDING) return { ok: false, message: "この返信予約は既に処理済みです。" };
  const at = sqliteTimestamp();
  const ok = await updateReplyStatus(ctx, replyId, REPLY_STATUS.PENDING, REPLY_STATUS.REJECTED, {
    approver_staff_id: staffId,
    rejected_at: at,
  });
  if (ok === 0) return { ok: false, message: "この返信予約は既に処理済みです。" };
  await editModmailConfirmMessage(ctx, reply, "非承認のため送信しませんでした", confirmInteractionMessage);
  void logModmailEvent(ctx, "REPLY_REJECTED", { reply_id: replyId });
  return { ok: true, message: "却下しました。" };
}

export async function closeModmailTicketFull(
  ctx: BotContext,
  input: { ticketId: string; guildId: string; threadId: string; closerId: string; reason: string },
): Promise<{ ok: boolean; message: string }> {
  const res = await closeModmailTicketInDb(ctx, input.ticketId, input.closerId, input.reason);
  if (!res.ok) return { ok: false, message: "このチケットは既にクローズ済みか、無効です。" };

  await cancelPendingRepliesByTicket(ctx, input.ticketId, input.reason, input.closerId);

  const guild = await ctx.client.guilds.fetch(input.guildId).catch(() => null);
  const thread = guild ? await guild.channels.fetch(input.threadId).catch(() => null) : null;
  if (thread?.isThread()) {
    const code = ticketDisplayCode(input.ticketId);
    await thread.setName(`Modmail-${code}_対応完了`).catch(() => undefined);
    await thread.setLocked(true).catch(() => undefined);
    await thread.setArchived(true).catch(() => undefined);
  }

  void logModmailEvent(ctx, "TICKET_CLOSED", {
    ticket_id: input.ticketId,
    closer_staff_id: input.closerId,
    reason: input.reason,
  });

  try {
    const ticket = await getModmailTicketRow(ctx, input.ticketId);
    if (ticket) {
      const user = await ctx.client.users.fetch(ticket.user_id);
      await user
        .send({
          ...componentCardsPayload([
            new ComponentCardBuilder()
              .setTitle("お問い合わせ")
              .setDescription(
                ["相談が終了しました。", "必要であれば再度サーバー内の「お問い合わせを始める」から新規相談できます。"].join(
                  "\n",
                ),
              )
              .setTimestamp(new Date()),
          ]),
        })
        .catch(() => undefined);
    }
  } catch {}

  return { ok: true, message: `チケット ${ticketDisplayCode(input.ticketId)} をクローズしました。` };
}

export async function handleModmailStaffReplyCommand(message: Message, ctx: BotContext): Promise<boolean> {
  if (!message.guild || !message.channel?.isThread()) return false;
  if (!message.content.trim().startsWith(MODMAIL_REPLY_COMMAND)) return false;

  const ticket = await getOpenModmailByThreadId(ctx, message.channel.id);
  const appealHold = ticket ? undefined : await getAppealHoldByThreadId(ctx, message.channel.id);
  if (!ticket && !appealHold) {
    return false;
  }

  const staff = await isModmailStaff(message.guild, message.author.id, message.member, ctx);
  if (!staff) {
    await message.reply({ content: "スタッフ権限がありません。" }).catch(() => undefined);
    return true;
  }

  const body = extractModmailReplyBody(message.content);
  if (!body?.trim()) {
    await message.reply({ content: "無効な !reply です。本文が空です。" }).catch(() => undefined);
    return true;
  }

  const pending = ticket
    ? await pendingReplyByTicket(ctx, ticket.id)
    : await pendingReplyByTicket(ctx, appealHold!.id);
  if (pending) {
    await message.reply({ content: "このスレッドには承認待ちの返信予約があります。" }).catch(() => undefined);
    return true;
  }

  const attach = serializeAttachmentsFromMessage(message);
  const replyId = randomUUID();
  const ts = sqliteTimestamp();
  await createReplyRow(ctx, {
    id: replyId,
    ticket_id: ticket ? ticket.id : appealHold!.id,
    appeal_id: appealHold ? appealHold.id : null,
    guild_id: ticket ? ticket.guild_id : appealHold!.guild_id,
    user_id: ticket ? ticket.user_id : appealHold!.user_id,
    thread_id: message.channel.id,
    source_message_id: message.id,
    author_staff_id: message.author.id,
    content: message.content,
    fixed_reply_body: body.trim(),
    attachment_metadata: attachmentMetaToJson(attach),
  });

  const reply = await replyById(ctx, replyId);
  if (!reply) {
    await message.reply({ content: "返信予約の作成に失敗しました。" }).catch(() => undefined);
    return true;
  }

  try {
    const confirmBody = await confirmReplyTextResolved(ctx, reply);
    const confirm = await message.channel.send({
      content: confirmBody,
      components: [buildModmailConfirmRow(reply.id, message.author.id)],
      allowedMentions: { parse: [] },
    });
    await setReplyConfirmMessageId(ctx, reply.id, confirm.id);
    void logModmailEvent(ctx, "REPLY_CREATED", {
      reply_id: reply.id,
      ticket_id: reply.ticket_id,
      appeal_id: reply.appeal_id ?? undefined,
    });
  } catch (e) {
    ctx.log.warn({ err: e }, "modmail confirm message failed");
    await updateReplyStatus(ctx, reply.id, REPLY_STATUS.PENDING, REPLY_STATUS.FAILED, {
      failed_at: ts,
      failure_reason: String(e),
    });
    await message.reply({ content: "返信予約の確認メッセージ作成に失敗しました。" }).catch(() => undefined);
  }
  return true;
}

export async function routeModmailGuildThreadMessage(message: Message, ctx: BotContext): Promise<boolean> {
  if (!message.guild || message.author.bot) return false;
  if (message.content.trim().startsWith(MODMAIL_REPLY_COMMAND)) {
    if (!message.channel?.isThread()) return false;
    return handleModmailStaffReplyCommand(message, ctx);
  }
  if (!message.channel?.isThread()) return false;
  const ticket = await getOpenModmailByThreadId(ctx, message.channel.id);
  const appealHold = ticket ? undefined : await getAppealHoldByThreadId(ctx, message.channel.id);
  if (!ticket && !appealHold) return false;
  const staff = await isModmailStaff(message.guild, message.author.id, message.member, ctx);
  if (!staff) return false;
  void logModmailEvent(ctx, "STAFF_NORMAL_MESSAGE", {
    ticket_id: ticket?.id,
    appeal_id: appealHold?.id,
    author_staff_id: message.author.id,
    content: message.content?.slice(0, 500),
  });
  return true;
}

export { replyLocks, REPLY_STATUS, replyById };
