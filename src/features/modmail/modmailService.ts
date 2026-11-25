import { ComponentCardBuilder, componentCardsPayload, type ComponentCardsPayload } from "../../core/componentCard.js";
import {
  ChannelType,
  type Guild,
  type Message,
  type NewsChannel,
  type TextChannel,
  type ThreadChannel,
  type User,
} from "discord.js";
import type { BotContext } from "../../bot/context.js";
import {
  attachmentMetaToJson,
  buildForwardDmFiles,
  type AttachmentMeta,
  serializeAttachmentsFromMessage,
} from "./modmailAttachmentUtils.js";
import { resolveModmailParentChannelId } from "./modmailConstants.js";
import { logModmailEvent } from "./modmailEventsLog.js";
import { MODMAIL_USER_SEND_COMMAND } from "./modmailIds.js";
import { buildModmailCloseRow, buildModmailIntakeCancelRow, buildModmailThreadLinkRow } from "./modmailUi.js";
import {
  MM_CLOSED,
  cancelModmailIntakeRow,
  closeModmailTicketRow,
  consumeModmailIntakeRow,
  deleteModmailRowById,
  findActiveIntakeByUser,
  findAnyOpenModmailByUser,
  findModmailTicketRowById,
  findOpenModmailByGuildUser,
  findOpenModmailByThreadId,
  hasActiveIntakeByGuildUser,
  insertModmailSkeleton,
  parseModmailRowData,
  ticketDisplayCode,
  updateModmailThreadMetaRow,
  upsertModmailIntakeRow,
  type ModmailThreadRow,
} from "./modmailRepository.js";
import {
  buildModmailStartDmPayload,
  buildModmailThreadSummaryEmbed,
  buildParentTicketCard,
  formatDiscordTime,
  splitDiscordText,
  trimMax,
} from "./modmailCards.js";

export type { ModmailThreadRow };
export {
  MM_CLOSED,
  buildModmailStartDmPayload,
  buildModmailThreadSummaryEmbed,
  parseModmailRowData,
  ticketDisplayCode,
};

type RelayChannel = TextChannel | NewsChannel | ThreadChannel;
type StaffThreadResult = { threadId: string; summaryMessageId: string; thread: ThreadChannel };
export type CreateTicketFromIntakeFormResult = { ok: boolean; message: string };

async function sendLong(channel: RelayChannel, text: string): Promise<void> {
  for (const chunk of splitDiscordText(text)) {
    await channel.send({ content: chunk || " ", allowedMentions: { parse: [] } });
  }
}

async function forceAddRoleMembersToThread(guild: Guild, threadId: string, roleId: string): Promise<void> {
  const role = guild.roles.cache.get(roleId) ?? (await guild.roles.fetch(roleId).catch(() => null));
  if (!role) return;
  if (role.members.size === 0) await guild.members.fetch().catch(() => undefined);
  const ch = await guild.channels.fetch(threadId).catch(() => null);
  if (!ch?.isThread()) return;
  for (const memberId of role.members.keys()) {
    await ch.members.add(String(memberId)).catch(() => undefined);
  }
}

export async function upsertModmailIntake(ctx: BotContext, guildId: string, userId: string): Promise<void> {
  await upsertModmailIntakeRow(ctx.ticketDb, guildId, userId);
}

export async function consumeModmailIntake(ctx: BotContext, guildId: string, userId: string): Promise<void> {
  await consumeModmailIntakeRow(ctx.ticketDb, guildId, userId);
}

export async function cancelModmailIntake(ctx: BotContext, guildId: string, userId: string): Promise<boolean> {
  return cancelModmailIntakeRow(ctx.ticketDb, guildId, userId);
}

export async function activeIntakeByGuildUser(ctx: BotContext, guildId: string, userId: string): Promise<boolean> {
  return hasActiveIntakeByGuildUser(ctx.ticketDb, guildId, userId);
}

export async function activeIntakeByUser(ctx: BotContext, userId: string): Promise<{ guild_id: string } | null> {
  return findActiveIntakeByUser(ctx.ticketDb, userId);
}

export async function getOpenModmailByThreadId(ctx: BotContext, threadId: string): Promise<ModmailThreadRow | undefined> {
  return findOpenModmailByThreadId(ctx.ticketDb, threadId);
}

export async function openModmailByGuildUser(
  ctx: BotContext,
  guildId: string,
  userId: string,
): Promise<ModmailThreadRow | undefined> {
  return findOpenModmailByGuildUser(ctx.ticketDb, guildId, userId);
}

export async function anyOpenModmailByUser(ctx: BotContext, userId: string): Promise<ModmailThreadRow | undefined> {
  return findAnyOpenModmailByUser(ctx.ticketDb, userId);
}

export async function getModmailTicketRow(ctx: BotContext, id: string): Promise<ModmailThreadRow | undefined> {
  return findModmailTicketRowById(ctx.ticketDb, id);
}

export async function closeModmailTicketInDb(
  ctx: BotContext,
  ticketId: string,
  closerId: string,
  reason: string,
): Promise<{ ok: boolean; closedAt?: string }> {
  return closeModmailTicketRow(ctx.ticketDb, ticketId, closerId, reason);
}

async function compensateStaffThread(
  ctx: BotContext,
  thread: { id: string; delete(reason?: string): Promise<unknown> },
): Promise<void> {
  await thread.delete("modmail ticket creation failed; compensation cleanup").catch((err) => {
    ctx.log.warn({ err, threadId: thread.id }, "modmail staff thread compensation delete failed");
  });
}

export async function deleteModmailSkeletonBestEffort(
  ctx: BotContext,
  modmailId: string,
  threadId?: string,
): Promise<void> {
  await deleteModmailRowById(ctx.ticketDb, modmailId).catch((err) => {
    ctx.log.warn({ err, modmailId, threadId }, "modmail DB skeleton compensation delete failed");
  });
}

export async function createStaffThread(
  ctx: BotContext,
  guild: Guild,
  row: ModmailThreadRow,
): Promise<StaffThreadResult | null> {
  const parentId = resolveModmailParentChannelId(ctx.config);
  if (!parentId) return null;

  const parent = guild.channels.cache.get(parentId) ?? (await guild.channels.fetch(parentId).catch(() => null));
  if (!parent) return null;

  const data = parseModmailRowData(row.data);
  const code = ticketDisplayCode(row.id);
  const tname = `Modmail-${code}_対応中`.slice(0, 100);
  const summaryEmbed = buildModmailThreadSummaryEmbed(row, data);
  const summaryPayload = {
    ...componentCardsPayload([summaryEmbed], [buildModmailCloseRow(row.id)]),
    allowedMentions: { parse: [] } as const,
  };
  const adminRoleId = ctx.config.ADMIN_ROLE_ID?.trim();

  if (parent.type === ChannelType.GuildText || parent.type === ChannelType.GuildAnnouncement) {
    if (!parent.isTextBased()) return null;
    const seed = await parent.send({ content: `Modmail Ticket #${code}`, allowedMentions: { parse: [] } }).catch(() => null);
    if (!seed) return null;

    const thread = await seed.startThread({ name: tname, autoArchiveDuration: 1440, reason: "modmail ticket" }).catch(() => null);
    await seed.delete().catch(() => undefined);
    if (!thread?.isTextBased()) {
      if (thread) await compensateStaffThread(ctx, thread);
      return null;
    }
    const summaryMessage = await (thread as RelayChannel).send(summaryPayload).catch(() => null);
    if (!summaryMessage) {
      await compensateStaffThread(ctx, thread);
      return null;
    }

    const noticePayload: ComponentCardsPayload & { allowedMentions: { parse: [] } } = {
      ...componentCardsPayload([buildParentTicketCard(row, data)], [buildModmailThreadLinkRow(guild.id, thread.id)]),
      allowedMentions: { parse: [] as [] },
    };
    if (adminRoleId) {
      await parent.send({ content: `<@&${adminRoleId}>`, allowedMentions: { roles: [adminRoleId], parse: [] } }).catch(() => undefined);
    }
    await parent.send(noticePayload).catch(() => undefined);
    if (adminRoleId) await forceAddRoleMembersToThread(guild, thread.id, adminRoleId);
    return { threadId: thread.id, summaryMessageId: summaryMessage.id, thread };
  }

  if (parent.type === ChannelType.GuildForum) {
    const thread = await parent.threads
      .create({ name: tname, autoArchiveDuration: 1440, reason: "modmail ticket", message: summaryPayload })
      .catch(() => null);
    if (!thread?.isTextBased()) {
      if (thread) await compensateStaffThread(ctx, thread);
      return null;
    }
    const starter = await thread.fetchStarterMessage().catch(() => null);
    if (!starter) {
      await compensateStaffThread(ctx, thread);
      return null;
    }
    if (adminRoleId) {
      await thread.send({ content: `<@&${adminRoleId}>`, allowedMentions: { roles: [adminRoleId], parse: [] } }).catch(() => undefined);
      await forceAddRoleMembersToThread(guild, thread.id, adminRoleId);
    }
    return { threadId: thread.id, summaryMessageId: starter.id, thread };
  }

  return null;
}

export async function relayUserPayloadToThread(
  ctx: BotContext,
  row: ModmailThreadRow,
  kind: "User Reply" | "User Reply Attachment" | "User DM 受信",
  body: string,
  attach: AttachmentMeta[],
  opts?: { isFirstTicketMessage?: boolean },
): Promise<void> {
  if (!row.thread_id) return;
  const guild = await ctx.client.guilds.fetch(row.guild_id).catch(() => null);
  if (!guild) return;
  const thread = await guild.channels.fetch(row.thread_id).catch(() => null);
  if (!thread || !thread.isTextBased()) return;
  const relayCh = thread as RelayChannel;
  const prefix = opts?.isFirstTicketMessage ? "このメッセージでチケットが作成されました。\n\n" : "";
  const cleaned = trimMax(prefix + (body.trim() || "(本文なし)"), 4000);
  const card = new ComponentCardBuilder().setTitle(kind).setDescription(cleaned).setTimestamp(new Date());
  try {
    await relayCh.send({ ...componentCardsPayload([card]), allowedMentions: { parse: [] } });
  } catch (e) {
    ctx.log.warn({ err: e, modmailId: row.id }, "relayUserPayloadToThread failed");
    return;
  }
  if (attach.length > 0) {
    const fwd = await buildForwardDmFiles(attachmentMetaToJson(attach));
    if (fwd.files.length > 0) {
      await relayCh.send({ files: fwd.files, allowedMentions: { parse: [] } }).catch(() => undefined);
    }
    if (fwd.failed.length > 0) {
      const lines = ["添付の一部転送に失敗しました。", ...fwd.failed.slice(0, 8).map((u) => `- ${u}`)];
      await sendLong(relayCh, lines.join("\n")).catch(() => undefined);
    }
  }
  if (kind === "User DM 受信") {
    void logModmailEvent(ctx, "USER_DM_RECEIVED", {
      ticket_id: row.id,
      guild_id: row.guild_id,
      user_id: row.user_id,
      thread_id: row.thread_id,
      source: "user_send_command",
    });
  } else {
    void logModmailEvent(ctx, "USER_REPLY_RELAY", { ticket_id: row.id, guild_id: row.guild_id, kind });
  }
}

async function relayModalIntakeToThread(
  ctx: BotContext,
  row: ModmailThreadRow,
  title: string,
  body: string,
  attach: AttachmentMeta[],
): Promise<void> {
  if (!row.thread_id) return;
  const guild = await ctx.client.guilds.fetch(row.guild_id).catch(() => null);
  if (!guild) return;
  const thread = await guild.channels.fetch(row.thread_id).catch(() => null);
  if (!thread || !thread.isTextBased()) return;
  const relayCh = thread as RelayChannel;

  const card = new ComponentCardBuilder()
    .setTitle("フォーム受付")
    .setDescription("この送信でチケットが作成されました。")
    .addFields(
      { name: "送信日時", value: formatDiscordTime(new Date()), inline: true },
      { name: "タイトル", value: trimMax(title || "(未設定)", 1024), inline: false },
      { name: "相談内容", value: trimMax(body.trim() || "(本文なし)", 1024), inline: false },
    )
    .setTimestamp(new Date());

  await relayCh.send({ ...componentCardsPayload([card]), allowedMentions: { parse: [] } }).catch((e) => {
    ctx.log.warn({ err: e, modmailId: row.id }, "relayModalIntakeToThread embed failed");
  });

  if (attach.length > 0) {
    const lines = ["添付ファイル:", ...attach.map((a) => `- ${a.name ?? "?"} | ${a.size ?? 0} bytes | ${a.url ?? "-"}`)];
    await sendLong(relayCh, lines.join("\n")).catch(() => undefined);
    const fwd = await buildForwardDmFiles(attachmentMetaToJson(attach));
    if (fwd.files.length > 0) {
      await relayCh.send({ files: fwd.files, allowedMentions: { parse: [] } }).catch(() => undefined);
    }
    if (fwd.failed.length > 0) {
      const failLines = ["添付の一部転送に失敗しました。", ...fwd.failed.slice(0, 8).map((u) => `- ${u}`)];
      await sendLong(relayCh, failLines.join("\n")).catch(() => undefined);
    }
  }
}

export async function createTicketFromIntakeForm(
  ctx: BotContext,
  params: { guildId: string; userId: string; title: string; body: string; attachments: AttachmentMeta[] },
): Promise<CreateTicketFromIntakeFormResult> {
  const gid = params.guildId.trim();
  const uid = params.userId.trim();
  const normalizedTitle = trimMax(params.title.trim(), 120);
  const normalizedBody = trimMax(params.body.trim(), 1000);
  const normalizedAttachments = params.attachments.slice(0, 8);

  if (!gid || !uid || !normalizedTitle || !normalizedBody) {
    return { ok: false, message: "タイトルと相談内容を入力してください。" };
  }
  if (await openModmailByGuildUser(ctx, gid, uid)) {
    return { ok: false, message: "現在対応中のチケットがあります。新規作成はできません。" };
  }
  if (!(await activeIntakeByGuildUser(ctx, gid, uid))) {
    return { ok: false, message: "サーバー内の「Modmailを始める」から相談を開始してください。" };
  }

  const guild = await ctx.client.guilds.fetch(gid).catch(() => null);
  if (!guild) {
    void logModmailEvent(ctx, "ERROR", { guild_id: gid, user_id: uid, content: normalizedBody, failure_reason: "guild_not_found_for_modal_intake" });
    return { ok: false, message: "サーバー情報の取得に失敗しました。時間をおいて再度お試しください。" };
  }

  let mmId: string;
  try {
    mmId = await insertModmailSkeleton(ctx.ticketDb, {
      guildId: gid,
      userId: uid,
      body: normalizedBody,
      subject: normalizedTitle,
      firstDmMessageId: null,
      source: "modal_intake",
    });
  } catch {
    return { ok: false, message: "チケット作成に失敗しました。時間をおいて再度お試しください。" };
  }

  const row = await getModmailTicketRow(ctx, mmId);
  if (!row) {
    await deleteModmailSkeletonBestEffort(ctx, mmId);
    return { ok: false, message: "チケット作成に失敗しました。時間をおいて再度お試しください。" };
  }

  const created = await createStaffThread(ctx, guild, row).catch(() => null);
  if (!created) {
    await deleteModmailSkeletonBestEffort(ctx, mmId);
    void logModmailEvent(ctx, "ERROR", { ticket_id: mmId, guild_id: gid, user_id: uid, content: normalizedBody, failure_reason: "create_staff_thread_failed" });
    return { ok: false, message: "チケット作成に失敗しました。時間をおいて再度お試しください。" };
  }

  let full: ModmailThreadRow | null = null;
  try {
    const parentId = resolveModmailParentChannelId(ctx.config);
    if (!parentId) throw new Error("modmail parent channel is not configured");
    await updateModmailThreadMetaRow(ctx.ticketDb, mmId, parentId, created.threadId, {
      panel_message_id: created.summaryMessageId,
      info_message_id: created.summaryMessageId,
      body: normalizedBody,
      subject: normalizedTitle,
    });
    full = (await getModmailTicketRow(ctx, mmId)) ?? null;
    if (!full) throw new Error("modmail row missing after staff thread metadata update");
  } catch (err) {
    await compensateStaffThread(ctx, created.thread);
    await deleteModmailSkeletonBestEffort(ctx, mmId, created.threadId);
    ctx.log.warn({ err, modmailId: mmId, threadId: created.threadId }, "modmail ticket persistence failed after staff thread creation");
    return { ok: false, message: "チケット作成に失敗しました。時間をおいて再度お試しください。" };
  }

  await consumeModmailIntake(ctx, gid, uid);
  await relayModalIntakeToThread(ctx, full, normalizedTitle, normalizedBody, normalizedAttachments).catch(() => undefined);

  void logModmailEvent(ctx, "TICKET_CREATED", {
    ticket_id: full.id,
    guild_id: full.guild_id,
    user_id: full.user_id,
    thread_id: full.thread_id,
    status: full.status,
    content: normalizedBody,
    extra_json: { source: "modal", title: normalizedTitle, attachment_count: normalizedAttachments.length },
  });

  return { ok: true, message: `チケットを作成しました。受付番号: ${ticketDisplayCode(full.id)}` };
}

function parseUserSendCommand(content: string): string | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith(MODMAIL_USER_SEND_COMMAND)) return null;
  const rest = trimmed.slice(MODMAIL_USER_SEND_COMMAND.length);
  if (rest && !/^\s/.test(rest)) return null;
  return rest.trim();
}

export async function handleModmailDmMessage(ctx: BotContext, message: Message): Promise<boolean> {
  if (message.author.bot) return false;
  const hasBody = Boolean(message.content?.trim());
  const hasAttach = message.attachments.size > 0;
  if (!hasBody && !hasAttach) return false;

  const open = await anyOpenModmailByUser(ctx, message.author.id);
  if (open) {
    const body = parseUserSendCommand(message.content ?? "");
    if (body === null) {
      await message.author
        .send({
          ...componentCardsPayload([
            new ComponentCardBuilder()
              .setTitle("お問い合わせ返信方法")
              .setDescription(
                "管理者側へ送信するには、管理者から届いた返信メッセージの「返信する」ボタンを押すか、`!send 本文` を送信してください。添付を送る場合も `!send` と一緒に送信してください。",
              )
              .setTimestamp(new Date()),
          ]),
        })
        .catch(() => undefined);
      return true;
    }

    const attach = serializeAttachmentsFromMessage(message);
    if (!body && attach.length === 0) {
      await message.author
        .send({
          ...componentCardsPayload([
            new ComponentCardBuilder()
              .setTitle("お問い合わせ返信方法")
              .setDescription("`!send 本文` の形式で送信してください。添付だけ送る場合は、添付と一緒に `!send` と入力してください。")
              .setTimestamp(new Date()),
          ]),
        })
        .catch(() => undefined);
      return true;
    }

    await relayUserPayloadToThread(ctx, open, "User DM 受信", hasAttach ? body || "(添付)" : body, hasAttach ? attach : []);
    return true;
  }

  const intake = await activeIntakeByUser(ctx, message.author.id);
  if (!intake) {
    await message.author
      .send({
        ...componentCardsPayload([
          new ComponentCardBuilder()
            .setTitle("お問い合わせのご案内")
            .setDescription(
              "サーバー内の「お問い合わせを始める」から DM 案内を受け取り、「チケットを作成」ボタンから相談を開始してください。",
            )
            .setTimestamp(new Date()),
        ]),
      })
      .catch(() => undefined);
    return true;
  }

  await message.author
    .send({
      ...componentCardsPayload(
        [
          new ComponentCardBuilder()
            .setTitle("お問い合わせ受付待機中")
            .setDescription(
              "まだチケットは作成されていません。先ほど送信した受付メッセージの「チケットを作成」ボタンから内容を入力してください。",
            )
            .setTimestamp(new Date()),
        ],
        [buildModmailIntakeCancelRow(intake.guild_id, message.author.id)],
      ),
    })
    .catch(() => undefined);
  return true;
}

export async function sendModmailStartDm(user: User, rows: unknown[]): Promise<void> {
  await user.send(buildModmailStartDmPayload(rows));
}
