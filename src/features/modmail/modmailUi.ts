import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { FileUploadBuilder, LabelBuilder } from "@discordjs/builders";
import {
  createPendingModmailContext,
  MODMAIL_TICKET_START_PREFIX,
} from "./modmailConstants.js";
import { buildThreePartId, MM_IDS } from "./modmailIds.js";

export function buildModmailTicketStartRows(guildId: string, userId: string): {
  ctxId: string;
  rows: ActionRowBuilder<ButtonBuilder>[];
} {
  const ctxId = createPendingModmailContext(guildId, userId);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${MODMAIL_TICKET_START_PREFIX}${ctxId}`)
      .setLabel("チケットを作成")
      .setStyle(ButtonStyle.Primary),
  );
  return { ctxId, rows: [row] };
}

/** DM 開始時: 添付用（guildId.userId.nonce） */
export function buildModmailStartAttachmentRow(guildId: string, userId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(buildThreePartId(MM_IDS.START_ATTACHMENT_PREFIX, guildId, userId))
      .setLabel("添付ファイルを送信")
      .setStyle(ButtonStyle.Secondary),
  );
}

export function buildModmailCloseRow(ticketId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${MM_IDS.CLOSE_PREFIX}${ticketId}`)
      .setLabel("チケットをクローズ")
      .setStyle(ButtonStyle.Danger),
  );
}

export function buildModmailUserReplyRow(ticketId: string, userId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(buildThreePartId(MM_IDS.USER_REPLY_PREFIX, ticketId, userId))
      .setLabel("返信する")
      .setStyle(ButtonStyle.Primary),
  );
}

export function buildModmailUserAttachmentRow(ticketId: string, userId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(buildThreePartId(MM_IDS.USER_ATTACHMENT_PREFIX, ticketId, userId))
      .setLabel("添付ファイルを送信")
      .setStyle(ButtonStyle.Secondary),
  );
}

export function buildModmailConfirmRow(replyId: string, authorStaffId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${MM_IDS.APPROVE_PREFIX}${replyId}`)
      .setLabel("承認")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${MM_IDS.REJECT_PREFIX}${replyId}`)
      .setLabel("非承認")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(buildThreePartId(MM_IDS.REPLY_ATTACHMENT_PREFIX, replyId, authorStaffId))
      .setLabel("ファイルを添付")
      .setStyle(ButtonStyle.Secondary),
  );
}

export function buildModmailAttachmentUploadModal(customId: string, title = "ファイルを添付"): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(title.slice(0, 45))
    .addLabelComponents(
      new LabelBuilder()
        .setLabel("添付ファイル")
        .setFileUploadComponent(
          new FileUploadBuilder()
            .setCustomId(MM_IDS.ATTACHMENT_MODAL_FILES_ID)
            .setRequired(true)
            .setMaxValues(8),
        ),
    );
}

export function buildModmailUserReplyModal(customId: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle("スタッフへ返信")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("reply_body")
          .setLabel("メッセージ")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(1000),
      ),
    )
    .addLabelComponents(
      new LabelBuilder()
        .setLabel("添付（任意）")
        .setFileUploadComponent(
          new FileUploadBuilder()
            .setCustomId(MM_IDS.USER_REPLY_MODAL_FILES_ID)
            .setRequired(false)
            .setMaxValues(8),
        ),
    );
}
