import { MessageFlags, type ButtonInteraction, type ModalSubmitInteraction } from "discord.js";
import type { CoreDeps } from "../../core/deps.js";
import { type AttachmentMeta, serializeUploadedCollection } from "../../core/discordAttachments.js";
import { createTicketFromIntakeForm } from "./modmailService.js";
import { buildModmailStartDmPayload } from "./modmailCards.js";
import { replyEphemeral } from "./modmailInteractionReply.js";
import { MM_IDS } from "./modmailIds.js";
import { pendingModmailTicketContexts } from "./modmailSessions.js";
import { buildModmailIntakeTicketModal } from "./modmailUi.js";

// Modmail のチケット作成ボタン・フォーム。

export async function handleModmailTicketStartButton(interaction: ButtonInteraction, ctx: Pick<CoreDeps, "log">): Promise<boolean> {
  const ctxId = interaction.customId.slice(MM_IDS.TICKET_START_PREFIX.length);
  const pending = pendingModmailTicketContexts.get(ctxId);
  if (!pending) {
    await replyEphemeral(interaction, "このチケット作成ボタンは期限切れです。");
    return true;
  }
  if (interaction.user.id !== pending.userId) {
    await replyEphemeral(interaction, "このボタンは対象ユーザーのみ利用できます。");
    return true;
  }
  if (pending.buttonFired) {
    await interaction.message?.edit(buildModmailStartDmPayload([])).catch(() => undefined);
    await replyEphemeral(interaction, "このチケット作成ボタンはすでに使用済みです。");
    return true;
  }
  pending.buttonFired = true;
  try {
    await interaction.showModal(buildModmailIntakeTicketModal(ctxId));
    await interaction.message?.edit(buildModmailStartDmPayload([])).catch(() => undefined);
  } catch (e) {
    pending.buttonFired = false;
    ctx.log.warn({ err: e }, "modmail intake modal show failed");
    await replyEphemeral(interaction, "モーダルの表示に失敗しました。時間をおいて再試行してください。");
  }
  return true;
}

export async function handleModmailTicketSubmitModal(interaction: ModalSubmitInteraction, ctx: Pick<CoreDeps, "config" | "ticketDb" | "log" | "client">): Promise<boolean> {
  const ctxId = interaction.customId.slice(MM_IDS.TICKET_SUBMIT_PREFIX.length);
  const pending = pendingModmailTicketContexts.get(ctxId);
  if (!pending) {
    await replyEphemeral(interaction, "チケット作成情報が期限切れです。");
    return true;
  }
  if (interaction.user.id !== pending.userId) {
    await replyEphemeral(interaction, "このフォームは対象ユーザーのみ送信できます。");
    return true;
  }

  const title = interaction.fields.getTextInputValue(MM_IDS.MODAL_INTAKE_TITLE)?.trim() ?? "";
  const body = interaction.fields.getTextInputValue(MM_IDS.MODAL_INTAKE_BODY)?.trim() ?? "";
  let attachments: AttachmentMeta[] = [];
  try {
    const uploaded = interaction.fields.getUploadedFiles(MM_IDS.MODAL_INTAKE_FILES, false);
    attachments = serializeUploadedCollection(uploaded);
  } catch {
    attachments = [];
  }

  await (interaction.guildId
    ? interaction.deferReply({ flags: MessageFlags.Ephemeral })
    : interaction.deferReply()
  ).catch(() => undefined);
  if (!interaction.deferred && !interaction.replied) {
    return true;
  }

  try {
    const result = await createTicketFromIntakeForm(ctx, {
      guildId: pending.guildId,
      userId: pending.userId,
      title,
      body,
      attachments,
    });
    if (!result.ok) {
      await interaction.editReply({ content: result.message }).catch(() => undefined);
      return true;
    }
    pendingModmailTicketContexts.delete(ctxId);
    await interaction.editReply({ content: result.message }).catch(() => undefined);
  } catch (e) {
    ctx.log.warn({ err: e }, "modmail ticket intake submit failed");
    await interaction
      .editReply({ content: "チケット作成に失敗しました。時間をおいて再試行してください。" })
      .catch(() => undefined);
  }
  return true;
}
