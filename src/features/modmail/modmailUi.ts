import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  FileUploadBuilder,
  LabelBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { buildThreePartId, MM_IDS } from "./modmailIds.js";

export function buildModmailTicketCreateRow(ctxId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${MM_IDS.TICKET_START_PREFIX}${ctxId}`)
      .setLabel("チケットを作成")
      .setStyle(ButtonStyle.Primary),
  );
}

export function buildModmailIntakeCancelRow(guildId: string, userId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(buildThreePartId(MM_IDS.INTAKE_CANCEL_PREFIX, guildId, userId))
      .setLabel("受付待機をキャンセル")
      .setStyle(ButtonStyle.Secondary),
  );
}

export function buildModmailThreadLinkRow(
  guildId: string,
  threadId: string,
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setLabel("対応スレッドへ移動")
      .setStyle(ButtonStyle.Link)
      .setURL(`https://discord.com/channels/${guildId}/${threadId}`),
  );
}

export function buildModmailIntakeTicketModal(ctxId: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`${MM_IDS.TICKET_SUBMIT_PREFIX}${ctxId}`)
    .setTitle("チケットを作成")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(MM_IDS.MODAL_INTAKE_TITLE)
          .setLabel("タイトル")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(120),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(MM_IDS.MODAL_INTAKE_BODY)
          .setLabel("詳細")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(2000),
      ),
    )
    .addLabelComponents(
      new LabelBuilder()
        .setLabel("添付（任意）")
        .setFileUploadComponent(
          new FileUploadBuilder()
            .setCustomId(MM_IDS.MODAL_INTAKE_FILES)
            .setRequired(false)
            .setMaxValues(8),
        ),
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
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(MM_IDS.ATTACHMENT_MODAL_NOTE_ID)
          .setLabel("メモ（任意）")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(100),
      ),
    )
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

// TextInput を先に置く（FileUpload のみのモーダルより DM で開きやすいため）。
export function buildModmailUserReplyModal(customId: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle("返信する")
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
