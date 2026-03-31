import {
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  type ButtonInteraction,
  type ModalSubmitInteraction,
} from "discord.js";
import type { BotContext } from "../../bot/context.js";
import { pseudoMessageFromUploads, serializeUploadedCollection } from "./modmailAttachmentUtils.js";
import { appendReplyAttachmentsMeta, REPLY_STATUS, replyById } from "./modmailRepliesDb.js";
import {
  MM_IDS,
  parseThreePartId,
  parseUuidTail,
} from "./modmailIds.js";
import {
  activeIntakeByGuildUser,
  anyOpenModmailByUser,
  createFromFirstDmWithAttachments,
  getModmailTicketRow,
  openModmailByGuildUser,
  relayUserPayloadToThread,
} from "./modmailService.js";
import {
  approveModmailReply,
  closeModmailTicketFull,
  isModmailStaff,
  rejectModmailReply,
  replyLocks,
} from "./modmailStaffFlow.js";
import {
  markCloseButtonFired,
  pendingUserReplyButtons,
  replyAttachmentFired,
  startAttachmentFired,
  unmarkCloseButtonFired,
  userAttachmentFired,
  userReplyFired,
} from "./modmailSessions.js";
import {
  buildModmailAttachmentUploadModal,
  buildModmailUserReplyModal,
} from "./modmailUi.js";

async function replyEphemeral(interaction: ButtonInteraction | ModalSubmitInteraction, text: string): Promise<void> {
  const flags = interaction.guildId ? MessageFlags.Ephemeral : undefined;
  try {
    if (interaction.deferred) await interaction.editReply({ content: text });
    else if (interaction.replied) await interaction.followUp({ content: text, ...(flags ? { flags } : {}) });
    else await interaction.reply({ content: text, ...(flags ? { flags } : {}) });
  } catch {
    /* ignore */
  }
}

export async function routeModmailStaffAndUserInteractions(
  interaction: ButtonInteraction | ModalSubmitInteraction,
  ctx: BotContext,
): Promise<boolean> {
  const id = interaction.customId;

  if (interaction.isButton() && id.startsWith(MM_IDS.CLOSE_PREFIX)) {
    return handleCloseButton(interaction, ctx);
  }
  if (interaction.isModalSubmit() && id.startsWith(MM_IDS.CLOSE_MODAL_PREFIX)) {
    return handleCloseModal(interaction, ctx);
  }
  if (interaction.isButton() && id.startsWith(MM_IDS.APPROVE_PREFIX)) {
    return handleReplyDecision(interaction, ctx, "approve");
  }
  if (interaction.isButton() && id.startsWith(MM_IDS.REJECT_PREFIX)) {
    return handleReplyDecision(interaction, ctx, "reject");
  }
  if (interaction.isButton() && id.startsWith(MM_IDS.REPLY_ATTACHMENT_PREFIX)) {
    return handleReplyAttachmentButton(interaction, ctx);
  }
  if (interaction.isModalSubmit() && id.startsWith(MM_IDS.REPLY_ATTACHMENT_MODAL_PREFIX)) {
    return handleReplyAttachmentModal(interaction, ctx);
  }
  if (interaction.isButton() && id.startsWith(MM_IDS.START_ATTACHMENT_PREFIX)) {
    return handleStartAttachmentButton(interaction, ctx);
  }
  if (interaction.isModalSubmit() && id.startsWith(MM_IDS.START_ATTACHMENT_MODAL_PREFIX)) {
    return handleStartAttachmentModal(interaction, ctx);
  }
  if (interaction.isButton() && id.startsWith(MM_IDS.USER_ATTACHMENT_PREFIX)) {
    return handleUserAttachmentButton(interaction, ctx);
  }
  if (interaction.isModalSubmit() && id.startsWith(MM_IDS.USER_ATTACHMENT_MODAL_PREFIX)) {
    return handleUserAttachmentModal(interaction, ctx);
  }
  if (interaction.isButton() && id.startsWith(MM_IDS.USER_REPLY_PREFIX)) {
    return handleUserReplyButton(interaction, ctx);
  }
  if (interaction.isModalSubmit() && id.startsWith(MM_IDS.USER_REPLY_MODAL_PREFIX)) {
    return handleUserReplyModal(interaction, ctx);
  }

  return false;
}

async function handleCloseButton(interaction: ButtonInteraction, ctx: BotContext): Promise<boolean> {
  if (!interaction.guild || !interaction.channel?.isThread()) {
    await replyEphemeral(interaction, "チケットスレッド内で実行してください。");
    return true;
  }
  const ticketId = parseUuidTail(interaction.customId, MM_IDS.CLOSE_PREFIX);
  if (!ticketId) {
    await replyEphemeral(interaction, "無効な操作です。");
    return true;
  }
  const staff = await isModmailStaff(interaction.guild, interaction.user.id, interaction.member, ctx);
  if (!staff) {
    await replyEphemeral(interaction, "権限がありません。");
    return true;
  }
  const ticket = await getModmailTicketRow(ctx, ticketId);
  if (
    !ticket ||
    ticket.status !== "open" ||
    String(ticket.thread_id) !== String(interaction.channel.id)
  ) {
    await replyEphemeral(interaction, "このチケットはすでに処理済みか、無効です。");
    return true;
  }
  const triggerKey = `${ticketId}:${interaction.message?.id ?? "nomsg"}`;
  if (!markCloseButtonFired(triggerKey)) {
    await replyEphemeral(interaction, "このクローズボタンは既に使用済みです。");
    return true;
  }
  const modal = new ModalBuilder()
    .setCustomId(`${MM_IDS.CLOSE_MODAL_PREFIX}${ticketId}`)
    .setTitle("チケットをクローズ")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("close_reason")
          .setLabel("クローズ理由（任意）")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(1000),
      ),
    );
  try {
    await interaction.showModal(modal);
    await interaction.message?.edit({ components: [] }).catch(() => undefined);
  } catch {
    unmarkCloseButtonFired(triggerKey);
    await replyEphemeral(interaction, "モーダル表示に失敗しました。");
  }
  return true;
}

async function handleCloseModal(interaction: ModalSubmitInteraction, ctx: BotContext): Promise<boolean> {
  if (!interaction.guild || !interaction.channel?.isThread()) {
    await replyEphemeral(interaction, "チケットスレッド内で実行してください。");
    return true;
  }
  const ticketId = parseUuidTail(interaction.customId, MM_IDS.CLOSE_MODAL_PREFIX);
  if (!ticketId) {
    await replyEphemeral(interaction, "無効な操作です。");
    return true;
  }
  const staff = await isModmailStaff(interaction.guild, interaction.user.id, interaction.member, ctx);
  if (!staff) {
    await replyEphemeral(interaction, "権限がありません。");
    return true;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => undefined);
  const reason = interaction.fields.getTextInputValue("close_reason")?.trim() || "";
  const res = await closeModmailTicketFull(ctx, {
    ticketId,
    guildId: interaction.guild.id,
    threadId: interaction.channel.id,
    closerId: interaction.user.id,
    reason: reason || "理由未入力",
  });
  await interaction.editReply({ content: res.message }).catch(() => undefined);
  return true;
}

async function handleReplyDecision(
  interaction: ButtonInteraction,
  ctx: BotContext,
  mode: "approve" | "reject",
): Promise<boolean> {
  const prefix = mode === "approve" ? MM_IDS.APPROVE_PREFIX : MM_IDS.REJECT_PREFIX;
  const replyId = parseUuidTail(interaction.customId, prefix);
  if (!replyId) {
    await replyEphemeral(interaction, "無効な操作です。");
    return true;
  }
  if (!interaction.guild) {
    await replyEphemeral(interaction, "ギルド内でのみ利用できます。");
    return true;
  }
  const staff = await isModmailStaff(interaction.guild, interaction.user.id, interaction.member, ctx);
  if (!staff) {
    await replyEphemeral(interaction, "権限がありません。");
    return true;
  }
  const lock = `${mode}:${replyId}`;
  if (replyLocks.has(lock)) {
    await replyEphemeral(interaction, "この操作は処理中です。");
    return true;
  }
  replyLocks.add(lock);
  try {
    await interaction.deferUpdate();
    const msg = interaction.message;
    if (mode === "approve") {
      const r = await approveModmailReply(ctx, replyId, interaction.user.id, msg);
      if (!r.ok) await interaction.followUp({ content: r.message, flags: MessageFlags.Ephemeral }).catch(() => undefined);
    } else {
      const r = await rejectModmailReply(ctx, replyId, interaction.user.id, msg);
      if (!r.ok) await interaction.followUp({ content: r.message, flags: MessageFlags.Ephemeral }).catch(() => undefined);
    }
  } finally {
    replyLocks.delete(lock);
  }
  return true;
}

async function handleReplyAttachmentButton(interaction: ButtonInteraction, ctx: BotContext): Promise<boolean> {
  const parsed = parseThreePartId(interaction.customId, MM_IDS.REPLY_ATTACHMENT_PREFIX);
  if (!parsed) {
    await replyEphemeral(interaction, "無効な操作です。");
    return true;
  }
  if (!interaction.guild || !interaction.channel?.isThread()) {
    await replyEphemeral(interaction, "Modmail スレッド内で使用してください。");
    return true;
  }
  const reply = await replyById(ctx, parsed.partA);
  if (!reply || reply.status !== REPLY_STATUS.PENDING) {
    await replyEphemeral(interaction, "返信予約が見つからないか、既に処理済みです。");
    return true;
  }
  if (interaction.user.id !== reply.author_staff_id) {
    await replyEphemeral(interaction, "!reply したスタッフのみ使えます。");
    return true;
  }
  const key = `${parsed.partA}:${parsed.partB}:${parsed.nonce}`;
  if (replyAttachmentFired.has(key)) {
    await interaction.message?.edit({ components: [] }).catch(() => undefined);
    await replyEphemeral(interaction, "このボタンは使用済みです。");
    return true;
  }
  try {
    await interaction.showModal(
      buildModmailAttachmentUploadModal(
        `${MM_IDS.REPLY_ATTACHMENT_MODAL_PREFIX}${interaction.customId.slice(MM_IDS.REPLY_ATTACHMENT_PREFIX.length)}`,
        "返信にファイルを添付",
      ),
    );
  } catch {
    await replyEphemeral(interaction, "モーダルを開けませんでした。");
  }
  return true;
}

async function handleReplyAttachmentModal(interaction: ModalSubmitInteraction, ctx: BotContext): Promise<boolean> {
  const raw = interaction.customId.slice(MM_IDS.REPLY_ATTACHMENT_MODAL_PREFIX.length);
  const fakeId = `${MM_IDS.REPLY_ATTACHMENT_PREFIX}${raw}`;
  const parsed = parseThreePartId(fakeId, MM_IDS.REPLY_ATTACHMENT_PREFIX);
  if (!parsed) {
    await replyEphemeral(interaction, "無効な操作です。");
    return true;
  }
  const key = `${parsed.partA}:${parsed.partB}:${parsed.nonce}`;
  if (replyAttachmentFired.has(key)) {
    await replyEphemeral(interaction, "このボタンは使用済みです。");
    return true;
  }
  if (!interaction.guild || !interaction.channel?.isThread()) {
    await replyEphemeral(interaction, "スレッド内で実行してください。");
    return true;
  }
  const reply = await replyById(ctx, parsed.partA);
  if (!reply || reply.status !== REPLY_STATUS.PENDING || interaction.user.id !== reply.author_staff_id) {
    await replyEphemeral(interaction, "返信予約が無効です。");
    return true;
  }
  const uploaded = interaction.fields.getUploadedFiles(MM_IDS.ATTACHMENT_MODAL_FILES_ID, false);
  const meta = serializeUploadedCollection(uploaded);
  if (meta.length === 0) {
    await replyEphemeral(interaction, "有効な添付がありません。");
    return true;
  }
  const ok = await appendReplyAttachmentsMeta(ctx, reply.id, meta);
  if (!ok) {
    await replyEphemeral(interaction, "添付の追加に失敗しました。");
    return true;
  }
  replyAttachmentFired.add(key);
  await replyEphemeral(interaction, "添付を返信キューに追加しました。");
  return true;
}

async function handleStartAttachmentButton(interaction: ButtonInteraction, ctx: BotContext): Promise<boolean> {
  const parsed = parseThreePartId(interaction.customId, MM_IDS.START_ATTACHMENT_PREFIX);
  if (!parsed || interaction.user.id !== parsed.partB) {
    await replyEphemeral(interaction, "このボタンは対象ユーザーのみ使えます。");
    return true;
  }
  const guildId = parsed.partA;
  const key = `${guildId}:${parsed.partB}:${parsed.nonce}`;
  if (startAttachmentFired.has(key)) {
    await interaction.message?.edit({ components: [] }).catch(() => undefined);
    await replyEphemeral(interaction, "このボタンは使用済みです。");
    return true;
  }
  const open = await openModmailByGuildUser(ctx, guildId, parsed.partB);
  const intake = await activeIntakeByGuildUser(ctx, guildId, parsed.partB);
  if (!open && !intake) {
    await replyEphemeral(interaction, "この添付ボタンの有効期限が切れています。");
    return true;
  }
  try {
    await interaction.showModal(
      buildModmailAttachmentUploadModal(
        `${MM_IDS.START_ATTACHMENT_MODAL_PREFIX}${interaction.customId.slice(MM_IDS.START_ATTACHMENT_PREFIX.length)}`,
      ),
    );
  } catch {
    await replyEphemeral(interaction, "モーダルを開けませんでした。");
  }
  return true;
}

async function handleStartAttachmentModal(interaction: ModalSubmitInteraction, ctx: BotContext): Promise<boolean> {
  const raw = interaction.customId.slice(MM_IDS.START_ATTACHMENT_MODAL_PREFIX.length);
  const fake = `${MM_IDS.START_ATTACHMENT_PREFIX}${raw}`;
  const parsed = parseThreePartId(fake, MM_IDS.START_ATTACHMENT_PREFIX);
  if (!parsed || interaction.user.id !== parsed.partB) {
    await replyEphemeral(interaction, "無効な操作です。");
    return true;
  }
  const guildId = parsed.partA;
  const key = `${guildId}:${parsed.partB}:${parsed.nonce}`;
  if (startAttachmentFired.has(key)) {
    await replyEphemeral(interaction, "このボタンは使用済みです。");
    return true;
  }
  const uploaded = interaction.fields.getUploadedFiles(MM_IDS.ATTACHMENT_MODAL_FILES_ID, false);
  const meta = serializeUploadedCollection(uploaded);
  if (meta.length === 0) {
    await replyEphemeral(interaction, "有効な添付がありません。");
    return true;
  }

  let handled = false;
  const open = await openModmailByGuildUser(ctx, guildId, parsed.partB);
  if (open) {
    await relayUserPayloadToThread(ctx, open, "User DM 受信", "(添付のみ)", meta);
    handled = true;
  } else {
    const intake = await activeIntakeByGuildUser(ctx, guildId, parsed.partB);
    if (intake) {
      const created = await createFromFirstDmWithAttachments(ctx, guildId, parsed.partB, "(添付のみ)", meta);
      handled = Boolean(created);
    }
  }
  if (!handled) {
    const anyOpen = await anyOpenModmailByUser(ctx, parsed.partB);
    if (anyOpen) {
      await relayUserPayloadToThread(ctx, anyOpen, "User DM 受信", "(添付のみ)", meta);
      handled = true;
    }
  }
  if (handled) startAttachmentFired.add(key);
  await replyEphemeral(
    interaction,
    handled ? "添付ファイルを送信しました。" : "サーバー内の Modmail ボタンから相談を開始してください。",
  );
  return true;
}

async function handleUserAttachmentButton(interaction: ButtonInteraction, ctx: BotContext): Promise<boolean> {
  const parsed = parseThreePartId(interaction.customId, MM_IDS.USER_ATTACHMENT_PREFIX);
  if (!parsed || interaction.user.id !== parsed.partB) {
    await replyEphemeral(interaction, "このボタンは対象ユーザーのみ使えます。");
    return true;
  }
  const ticketId = parsed.partA;
  const key = `${ticketId}:${parsed.partB}:${parsed.nonce}`;
  if (userAttachmentFired.has(key)) {
    await interaction.message?.edit({ components: [] }).catch(() => undefined);
    await replyEphemeral(interaction, "このボタンは使用済みです。");
    return true;
  }
  const ticket = await getModmailTicketRow(ctx, ticketId);
  if (!ticket || ticket.status !== "open" || ticket.user_id !== parsed.partB) {
    await replyEphemeral(interaction, "このチケットには返信できません。");
    return true;
  }
  try {
    await interaction.showModal(
      buildModmailAttachmentUploadModal(
        `${MM_IDS.USER_ATTACHMENT_MODAL_PREFIX}${interaction.customId.slice(MM_IDS.USER_ATTACHMENT_PREFIX.length)}`,
      ),
    );
  } catch {
    await replyEphemeral(interaction, "モーダルを開けませんでした。");
  }
  return true;
}

async function handleUserAttachmentModal(interaction: ModalSubmitInteraction, ctx: BotContext): Promise<boolean> {
  const raw = interaction.customId.slice(MM_IDS.USER_ATTACHMENT_MODAL_PREFIX.length);
  const fake = `${MM_IDS.USER_ATTACHMENT_PREFIX}${raw}`;
  const parsed = parseThreePartId(fake, MM_IDS.USER_ATTACHMENT_PREFIX);
  if (!parsed || interaction.user.id !== parsed.partB) {
    await replyEphemeral(interaction, "無効な操作です。");
    return true;
  }
  const key = `${parsed.partA}:${parsed.partB}:${parsed.nonce}`;
  if (userAttachmentFired.has(key)) {
    await replyEphemeral(interaction, "このボタンは使用済みです。");
    return true;
  }
  const ticket = await getModmailTicketRow(ctx, parsed.partA);
  if (!ticket || ticket.status !== "open" || ticket.user_id !== parsed.partB) {
    await replyEphemeral(interaction, "このチケットには返信できません。");
    return true;
  }
  const uploaded = interaction.fields.getUploadedFiles(MM_IDS.ATTACHMENT_MODAL_FILES_ID, false);
  const meta = serializeUploadedCollection(uploaded);
  if (meta.length === 0) {
    await replyEphemeral(interaction, "有効な添付がありません。");
    return true;
  }
  await relayUserPayloadToThread(ctx, ticket, "User Reply Attachment", "(添付)", meta);
  userAttachmentFired.add(key);
  await replyEphemeral(interaction, "添付を送信しました。");
  return true;
}

async function handleUserReplyButton(interaction: ButtonInteraction, ctx: BotContext): Promise<boolean> {
  const parsed = parseThreePartId(interaction.customId, MM_IDS.USER_REPLY_PREFIX);
  if (!parsed || interaction.user.id !== parsed.partB) {
    await replyEphemeral(interaction, "このボタンは対象ユーザーのみ使えます。");
    return true;
  }
  const key = `${parsed.partA}:${parsed.partB}:${parsed.nonce}`;
  if (userReplyFired.has(key)) {
    await interaction.message?.edit({ components: [] }).catch(() => undefined);
    await replyEphemeral(interaction, "この返信ボタンは使用済みです。");
    return true;
  }
  const ticket = await getModmailTicketRow(ctx, parsed.partA);
  if (!ticket || ticket.status !== "open" || ticket.user_id !== parsed.partB) {
    await replyEphemeral(interaction, "このチケットは返信できません。");
    return true;
  }
  pendingUserReplyButtons.set(key, {
    channel_id: interaction.channelId!,
    message_id: interaction.message?.id ?? "",
    custom_id: interaction.customId,
  });
  try {
    await interaction.showModal(
      buildModmailUserReplyModal(`${MM_IDS.USER_REPLY_MODAL_PREFIX}${interaction.customId.slice(MM_IDS.USER_REPLY_PREFIX.length)}`),
    );
  } catch {
    pendingUserReplyButtons.delete(key);
    await replyEphemeral(interaction, "モーダルを開けませんでした。");
  }
  return true;
}

async function removeUserReplyButtonFromDm(key: string, _ctx: BotContext): Promise<void> {
  const ref = pendingUserReplyButtons.get(key);
  pendingUserReplyButtons.delete(key);
  if (!ref?.channel_id || !ref.message_id) return;
  const ch = await _ctx.client.channels.fetch(ref.channel_id).catch(() => null);
  if (!ch?.isTextBased()) return;
  const msg = await ch.messages.fetch(ref.message_id).catch(() => null);
  if (!msg) return;
  await msg.edit({ components: [] }).catch(() => undefined);
}

async function handleUserReplyModal(interaction: ModalSubmitInteraction, ctx: BotContext): Promise<boolean> {
  const raw = interaction.customId.slice(MM_IDS.USER_REPLY_MODAL_PREFIX.length);
  const fake = `${MM_IDS.USER_REPLY_PREFIX}${raw}`;
  const parsed = parseThreePartId(fake, MM_IDS.USER_REPLY_PREFIX);
  if (!parsed || interaction.user.id !== parsed.partB) {
    await replyEphemeral(interaction, "無効な操作です。");
    return true;
  }
  const key = `${parsed.partA}:${parsed.partB}:${parsed.nonce}`;
  if (userReplyFired.has(key)) {
    await replyEphemeral(interaction, "この返信ボタンは使用済みです。");
    return true;
  }
  userReplyFired.add(key);
  await removeUserReplyButtonFromDm(key, ctx);

  await (interaction.guildId
    ? interaction.deferReply({ flags: MessageFlags.Ephemeral })
    : interaction.deferReply()
  ).catch(() => undefined);

  const ticket = await getModmailTicketRow(ctx, parsed.partA);
  if (!ticket || ticket.status !== "open" || ticket.user_id !== parsed.partB) {
    await interaction.editReply({ content: "このチケットは返信できません。" }).catch(() => undefined);
    return true;
  }

  const body = interaction.fields.getTextInputValue("reply_body") || "";
  let uploaded = interaction.fields.getUploadedFiles(MM_IDS.USER_REPLY_MODAL_FILES_ID, false);
  try {
    if (!uploaded || uploaded.size === 0) uploaded = null;
  } catch {
    uploaded = null;
  }

  if (uploaded && uploaded.size > 0) {
    const pseudo = pseudoMessageFromUploads(interaction.user.id, uploaded, body);
    await relayUserPayloadToThread(ctx, ticket, "User Reply Attachment", pseudo.content, pseudo.attachments);
    await interaction.editReply({ content: "返信を送信しました。" }).catch(() => undefined);
  } else {
    await relayUserPayloadToThread(ctx, ticket, "User Reply", body, []);
    await interaction.editReply({ content: "返信を送信しました。" }).catch(() => undefined);
  }
  return true;
}
