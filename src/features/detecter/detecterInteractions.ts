import {
  ActionRowBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ModalSubmitInteraction,
} from "discord.js";
import type { BotContext } from "../../bot/context.js";
import { parseCustomId } from "../../interactions/parseCustomId.js";
import { DETECTER_REASON_INPUT_ID, getDetecterService } from "./detecterService.js";

export async function handleDetecterButton(
  interaction: ButtonInteraction,
  ctx: BotContext,
): Promise<boolean> {
  const parsed = parseCustomId(interaction.customId);
  if (!parsed || parsed.domain !== "detecter") return false;

  if (parsed.action === "reasonPrompt") {
    const svc = getDetecterService(ctx);
    const event = svc.getPendingEvent(parsed.shortId);
    if (!event) {
      await interaction.reply({ content: "このイベントは期限切れか、既に処理済みです。", flags: MessageFlags.Ephemeral });
      return true;
    }
    if (event.reasonButtonFired) {
      await interaction.reply({ content: "この理由入力は既に処理済みです。", flags: MessageFlags.Ephemeral });
      return true;
    }
    if (interaction.user.id !== event.actorUserId) {
      await interaction.reply({ content: "処罰を実行したユーザーのみこのボタンを使用できます。", flags: MessageFlags.Ephemeral });
      return true;
    }
    const modal = new ModalBuilder()
      .setCustomId(`detecter:reasonModalPrompt:${parsed.shortId}`)
      .setTitle("処罰理由の入力")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId(DETECTER_REASON_INPUT_ID)
            .setLabel("理由")
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMaxLength(1000)
            .setPlaceholder("対象ユーザーに送信する理由を入力してください。"),
        ),
      );
    try {
      await interaction.showModal(modal);
    } catch {
      if (!interaction.replied && !interaction.deferred) {
        await interaction
          .reply({
            content: "モーダルを表示できませんでした。しばらくしてから再度お試しください。",
            flags: MessageFlags.Ephemeral,
          })
          .catch(() => undefined);
      }
    }
    return true;
  }

  return false;
}

export async function handleDetecterModal(
  interaction: ModalSubmitInteraction,
  ctx: BotContext,
): Promise<boolean> {
  const parsed = parseCustomId(interaction.customId);
  if (!parsed || parsed.domain !== "detecter") return false;

  if (parsed.action === "reasonModalPrompt") {
    const reason = interaction.fields.getTextInputValue(DETECTER_REASON_INPUT_ID);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const result = await getDetecterService(ctx).submitModeratorReason(
        interaction.user.id,
        parsed.shortId,
        reason,
      );
      await interaction.editReply({ content: result.message });
    } catch (err) {
      ctx.log.error({ err }, "detecter: reason modal submit failed");
      await interaction.editReply({ content: "処理中にエラーが発生しました。" }).catch(() => undefined);
    }
    return true;
  }

  return false;
}
