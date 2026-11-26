import { ComponentCardBuilder, componentCardsPayload } from "../../core/componentCard.js";
import { handleModmailTicketStartButton, handleModmailTicketSubmitModal } from "./modmailTicketIntake.js";
import {
  ComponentType,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  type ButtonInteraction,
  type Message,
  type ModalSubmitInteraction,
} from "discord.js";
import type { CoreDeps } from "../../core/deps.js";
import { getAppealById, relayUserPayloadToAppealHoldThread } from "../appeals/appealService.js";
import { pseudoMessageFromUploads, serializeUploadedCollection } from "../../core/discordAttachments.js";
import { appendReplyAttachmentsMeta, REPLY_STATUS, replyById } from "./modmailRepliesDb.js";
import {
  MM_IDS,
  parseThreePartId,
  parseUuidTail,
} from "./modmailIds.js";
import {
  cancelModmailIntake,
  getModmailTicketRow,
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
  unmarkCloseButtonFired,
  userReplyFired,
} from "./modmailSessions.js";
import {
  buildModmailAttachmentUploadModal,
  buildModmailUserReplyModal,
} from "./modmailUi.js";
export { replyEphemeral } from "./modmailInteractionReply.js";
import { replyEphemeral } from "./modmailInteractionReply.js";

// Modmail のスタッフ操作が使う依存。routeModmailStaffAndUserInteractions が全部を使う。
type ModmailStaffDeps = Pick<CoreDeps, "config" | "ticketDb" | "log" | "client">;

async function removeTopLevelActionRows(message: ButtonInteraction["message"] | Message | null | undefined): Promise<void> {
  if (!message) return;
  const retained = message.components
    .map((component) => component.toJSON())
    .filter((component) => component.type !== ComponentType.ActionRow);
  await message.edit({ components: retained as never }).catch(() => undefined);
}

export async function routeModmailStaffAndUserInteractions(
  interaction: ButtonInteraction | ModalSubmitInteraction,
  ctx: ModmailStaffDeps,
): Promise<boolean> {
  const id = interaction.customId;

  if (interaction.isButton() && id.startsWith(MM_IDS.TICKET_START_PREFIX)) {
    return handleModmailTicketStartButton(interaction, ctx);
  }
  if (interaction.isModalSubmit() && id.startsWith(MM_IDS.TICKET_SUBMIT_PREFIX)) {
    return handleModmailTicketSubmitModal(interaction, ctx);
  }
  if (interaction.isButton() && id.startsWith(MM_IDS.INTAKE_CANCEL_PREFIX)) {
    return handleModmailIntakeCancelButton(interaction, ctx);
  }

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

async function handleCloseButton(interaction: ButtonInteraction, ctx: ModmailStaffDeps): Promise<boolean> {
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
    await removeTopLevelActionRows(interaction.message);
  } catch {
    unmarkCloseButtonFired(triggerKey);
    await replyEphemeral(interaction, "モーダル表示に失敗しました。");
  }
  return true;
}

async function handleModmailIntakeCancelButton(interaction: ButtonInteraction, ctx: ModmailStaffDeps): Promise<boolean> {
  const parsed = parseThreePartId(interaction.customId, MM_IDS.INTAKE_CANCEL_PREFIX);
  if (!parsed || interaction.user.id !== parsed.partB) {
    await replyEphemeral(interaction, "このボタンは対象ユーザーのみ利用できます。");
    return true;
  }

  const cancelled = await cancelModmailIntake(ctx, parsed.partA, parsed.partB);
  const embed = new ComponentCardBuilder()
    .setTitle(cancelled ? "Modmail 受付待機をキャンセルしました" : "Modmail 受付待機は終了済みです")
    .setDescription(
      cancelled
        ? "受付待機をキャンセルしました。再度開始する場合は、サーバー内の「Modmailを始める」からやり直してください。"
        : "この受付待機は既にキャンセル済み、またはチケット作成済みです。",
    )
    .setTimestamp(new Date());

  try {
    await interaction.update(componentCardsPayload([embed]));
  } catch {
    await replyEphemeral(interaction, embed.data.description ?? "受付待機を更新しました。");
  }
  return true;
}

async function handleCloseModal(interaction: ModalSubmitInteraction, ctx: ModmailStaffDeps): Promise<boolean> {
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
  ctx: ModmailStaffDeps,
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

async function handleReplyAttachmentButton(interaction: ButtonInteraction, ctx: ModmailStaffDeps): Promise<boolean> {
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
    await removeTopLevelActionRows(interaction.message);
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

async function handleReplyAttachmentModal(interaction: ModalSubmitInteraction, ctx: ModmailStaffDeps): Promise<boolean> {
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
  let uploaded = null;
  if (interaction.fields.fields.has(MM_IDS.ATTACHMENT_MODAL_FILES_ID)) {
    try {
      uploaded = interaction.fields.getUploadedFiles(MM_IDS.ATTACHMENT_MODAL_FILES_ID, false);
    } catch {
      uploaded = null;
    }
  }
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

async function handleUserAttachmentButton(interaction: ButtonInteraction, _ctx: ModmailStaffDeps): Promise<boolean> {
  await replyEphemeral(interaction, "管理者側へ送信するには、返信メッセージの「返信する」ボタン、または `!send 本文` を使ってください。");
  return true;
}

async function handleUserAttachmentModal(interaction: ModalSubmitInteraction, _ctx: ModmailStaffDeps): Promise<boolean> {
  await replyEphemeral(interaction, "管理者側へ送信するには、返信メッセージの「返信する」ボタン、または `!send 本文` を使ってください。");
  return true;
}

async function handleUserReplyButton(interaction: ButtonInteraction, ctx: ModmailStaffDeps): Promise<boolean> {
  const parsed = parseThreePartId(interaction.customId, MM_IDS.USER_REPLY_PREFIX);
  if (!parsed || interaction.user.id !== parsed.partB) {
    await replyEphemeral(interaction, "このボタンは対象ユーザーのみ使えます。");
    return true;
  }
  const key = `${parsed.partA}:${parsed.partB}:${parsed.nonce}`;
  if (userReplyFired.has(key)) {
    await removeTopLevelActionRows(interaction.message);
    await replyEphemeral(interaction, "この返信ボタンは使用済みです。");
    return true;
  }
  const ticket = await getModmailTicketRow(ctx, parsed.partA);
  const appeal =
    ticket && ticket.status === "open" && ticket.user_id === parsed.partB
      ? null
      : await getAppealById(ctx, parsed.partA);
  const appealOk = appeal && appeal.status === "hold" && appeal.user_id === parsed.partB;
  const ticketOk = ticket && ticket.status === "open" && ticket.user_id === parsed.partB;
  if (!ticketOk && !appealOk) {
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

async function removeUserReplyButtonFromDm(key: string, _ctx: ModmailStaffDeps): Promise<void> {
  const ref = pendingUserReplyButtons.get(key);
  pendingUserReplyButtons.delete(key);
  if (!ref?.channel_id || !ref.message_id) return;
  const ch = await _ctx.client.channels.fetch(ref.channel_id).catch(() => null);
  if (!ch?.isTextBased()) return;
  const msg = await ch.messages.fetch(ref.message_id).catch(() => null);
  if (!msg) return;
  await removeTopLevelActionRows(msg);
}

async function handleUserReplyModal(interaction: ModalSubmitInteraction, ctx: ModmailStaffDeps): Promise<boolean> {
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
  const appeal =
    ticket && ticket.status === "open" && ticket.user_id === parsed.partB
      ? null
      : await getAppealById(ctx, parsed.partA);
  const appealOk = appeal && appeal.status === "hold" && appeal.user_id === parsed.partB;
  const ticketOk = ticket && ticket.status === "open" && ticket.user_id === parsed.partB;
  if (!ticketOk && !appealOk) {
    await interaction.editReply({ content: "このチケットは返信できません。" }).catch(() => undefined);
    return true;
  }

  const body = interaction.fields.getTextInputValue("reply_body") || "";
  let uploaded = null;
  if (interaction.fields.fields.has(MM_IDS.USER_REPLY_MODAL_FILES_ID)) {
    try {
      uploaded = interaction.fields.getUploadedFiles(MM_IDS.USER_REPLY_MODAL_FILES_ID, false);
    } catch {
      uploaded = null;
    }
  }

  if (ticketOk && ticket) {
    if (uploaded && uploaded.size > 0) {
      const pseudo = pseudoMessageFromUploads(interaction.user.id, uploaded, body);
      await relayUserPayloadToThread(ctx, ticket, "User Reply Attachment", pseudo.content, pseudo.attachments);
    } else {
      await relayUserPayloadToThread(ctx, ticket, "User Reply", body, []);
    }
  } else if (appealOk && appeal) {
    if (uploaded && uploaded.size > 0) {
      const pseudo = pseudoMessageFromUploads(interaction.user.id, uploaded, body);
      await relayUserPayloadToAppealHoldThread(ctx, appeal, "User Reply Attachment", pseudo.content, pseudo.attachments);
    } else {
      await relayUserPayloadToAppealHoldThread(ctx, appeal, "User Reply", body, []);
    }
  }
  await interaction.editReply({ content: "返信を送信しました。" }).catch(() => undefined);
  return true;
}
