import { ActionRowBuilder, ButtonBuilder, ButtonStyle, TextInputStyle } from "discord.js";
import {
  ActionRowBuilder as IntakeActionRowBuilder,
  FileUploadBuilder,
  LabelBuilder,
  ModalBuilder as IntakeModalBuilder,
  TextInputBuilder as IntakeTextInputBuilder,
} from "@discordjs/builders";
import { buildThreePartId, MM_IDS } from "./modmailIds.js";

// DM: 「チケットを作成」→モーダル（DiscordBOTv2 `modmail_ticket_start:` 相当）

export function buildModmailTicketCreateRow(ctxId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${MM_IDS.TICKET_START_PREFIX}${ctxId}`)
      .setLabel("チケットを作成")
      .setStyle(ButtonStyle.Primary),
  );
}

// Modmail 受付モーダル。
// TextInput は Action Row のみ @discordjs/builders で組み立てる（discord.js との instanceof 不一致を避ける）。
// 添付は Label + FileUpload（同一パッケージ）で追加する。

export function buildModmailIntakeTicketModal(ctxId: string): IntakeModalBuilder {
  return new IntakeModalBuilder()
    .setCustomId(`${MM_IDS.TICKET_SUBMIT_PREFIX}${ctxId}`)
    .setTitle("チケットを作成")
    .addComponents(
      new IntakeActionRowBuilder<IntakeTextInputBuilder>().addComponents(
        new IntakeTextInputBuilder()
          .setCustomId(MM_IDS.MODAL_INTAKE_TITLE)
          .setLabel("タイトル")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(120),
      ),
      new IntakeActionRowBuilder<IntakeTextInputBuilder>().addComponents(
        new IntakeTextInputBuilder()
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

/** ユーザー DM: 本文＋添付を1モーダルで送信（旧 DM の「添付ファイルを送信」ボタンは互換のためハンドラのみ残す） */
export function buildModmailUserReplyRow(ticketId: string, userId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(buildThreePartId(MM_IDS.USER_REPLY_PREFIX, ticketId, userId))
      .setLabel("スタッフへ返信")
      .setStyle(ButtonStyle.Primary),
  );
}

/** @deprecated 旧メッセージ互換。新規 DM は {@link buildModmailUserReplyRow} のみ使用 */
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

/**
 * スタッフ（!reply 承認前の「ファイルを添付」）および旧ユーザー添付ボタン用。
 * {@link buildModmailIntakeTicketModal} と同じ builders のみ（FileUpload 付きモーダルの showModal 互換）。
 */
export function buildModmailAttachmentUploadModal(customId: string, title = "ファイルを添付"): IntakeModalBuilder {
  return new IntakeModalBuilder()
    .setCustomId(customId)
    .setTitle(title.slice(0, 45))
    .addComponents(
      new IntakeActionRowBuilder<IntakeTextInputBuilder>().addComponents(
        new IntakeTextInputBuilder()
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

/**
 * ユーザー DM の「スタッフへ返信」用モーダル（本文 + 任意添付を1つに統合）。
 * TextInput を先に置く（FileUpload のみのモーダルより DM で開きやすい）。
 * 構成は {@link buildModmailIntakeTicketModal} と同じ builders のみ。
 * （discord.js の ModalBuilder と Label/FileUpload を混ぜると DM で showModal が失敗することがある）
 */
export function buildModmailUserReplyModal(customId: string): IntakeModalBuilder {
  return new IntakeModalBuilder()
    .setCustomId(customId)
    .setTitle("スタッフへ返信")
    .addComponents(
      new IntakeActionRowBuilder<IntakeTextInputBuilder>().addComponents(
        new IntakeTextInputBuilder()
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
