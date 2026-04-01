import {
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChannelSelectMenuInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import type { BotContext } from "../bot/context.js";
import { routeMessageLogButton, routeMessageLogModal } from "../features/messageLog/messageLogsView.js";
import {
  handleSetupChannelSelect,
  handleSetupUiOpenButton,
} from "../features/panels/setupWizard.js";
import { routeModmailStaffAndUserInteractions } from "../features/modmail/modmailStaffInteractions.js";
import { handleUserContactPanelButton } from "../features/panels/userPanelHandlers.js";
import {
  handleVcCreateModal,
  handleVcCreatorButton,
  handleVcGenreSelect,
} from "../features/vc/vcInteractionHandlers.js";
import {
  handleReactionRoleButton,
  handleReactionRoleModal,
  handleReactionRoleStringSelect,
} from "../features/reactionRoles/reactionRoleHandlers.js";
import {
  handleAiHistoryAdminButton,
  handleAiHistoryAdminStringSelect,
} from "../features/ai/aiHistoryAdminPanel.js";
import { handleAiHistoryClearButton } from "../features/ai/aiQueryService.js";
import {
  handleReminderHubButton,
  handleReminderHubChannelSelect,
  handleReminderHubModal,
  handleReminderHubStringSelect,
} from "../features/reminders/reminderHubHandlers.js";
import {
  handleAutoModRaidButton,
  handleAutoModStringSelect,
} from "../features/moderation/autoModerationHandlers.js";
import {
  handleAppealReviewButton,
  handleAppealStartButton,
  handleAppealSubmitModal,
} from "../features/appeals/appealHandlers.js";
import { getDetecterService, DETECTER_REASON_INPUT_ID } from "../features/detecter/detecterService.js";
import { parseCustomId } from "./parseCustomId.js";

export async function handlePanelButton(interaction: ButtonInteraction, ctx: BotContext): Promise<boolean> {
  if (await handleSetupUiOpenButton(interaction, ctx)) return true;
  return false;
}

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
      await interaction.reply({ content: "このイベントは期限切れか、既に処理済みです。", ephemeral: true });
      return true;
    }
    if (event.reasonButtonFired) {
      await interaction.reply({ content: "この理由入力は既に処理済みです。", ephemeral: true });
      return true;
    }
    if (interaction.user.id !== event.actorUserId) {
      await interaction.reply({ content: "処罰を実行したユーザーのみこのボタンを使用できます。", ephemeral: true });
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
            ephemeral: true,
          })
          .catch(() => undefined);
      }
    }
    return true;
  }

  return false;
}

export async function routeButton(interaction: ButtonInteraction, ctx: BotContext): Promise<void> {
  if (await handleAutoModRaidButton(interaction, ctx)) return;
  if (await handleReminderHubButton(interaction, ctx)) return;
  if (await handleAiHistoryClearButton(interaction, ctx)) return;
  if (await handleAiHistoryAdminButton(interaction, ctx)) return;
  if (await routeMessageLogButton(interaction, ctx)) return;
  if (await routeModmailStaffAndUserInteractions(interaction, ctx)) return;
  if (await handleAppealStartButton(interaction, ctx)) return;
  if (await handleAppealReviewButton(interaction, ctx)) return;
  if (await handleUserContactPanelButton(interaction, ctx)) return;
  if (await handleReactionRoleButton(interaction, ctx)) return;
  if (await handleDetecterButton(interaction, ctx)) return;
  if (await handleVcCreatorButton(interaction, ctx)) return;
  if (await handlePanelButton(interaction, ctx)) return;
}

export async function handleDetecterModal(
  interaction: ModalSubmitInteraction,
  ctx: BotContext,
): Promise<boolean> {
  const parsed = parseCustomId(interaction.customId);
  if (!parsed || parsed.domain !== "detecter") return false;

  if (parsed.action === "reasonModalPrompt") {
    const reason = interaction.fields.getTextInputValue(DETECTER_REASON_INPUT_ID);
    const result = await getDetecterService(ctx).submitModeratorReason(
      interaction.user.id,
      parsed.shortId,
      reason,
    );
    await interaction.reply({ content: result.message, ephemeral: true });
    return true;
  }

  return false;
}

export async function routeModal(interaction: ModalSubmitInteraction, ctx: BotContext): Promise<void> {
  if (await handleReminderHubModal(interaction, ctx)) return;
  if (await routeMessageLogModal(interaction, ctx)) return;
  if (await handleReactionRoleModal(interaction, ctx)) return;
  if (await handleAppealSubmitModal(interaction, ctx)) return;
  if (await routeModmailStaffAndUserInteractions(interaction, ctx)) return;
  if (await handleDetecterModal(interaction, ctx)) return;
  if (await handleVcCreateModal(interaction, ctx)) return;
}

export async function routeStringSelectMenu(
  interaction: StringSelectMenuInteraction,
  ctx: BotContext,
): Promise<void> {
  if (await handleAutoModStringSelect(interaction, ctx)) return;
  if (await handleReminderHubStringSelect(interaction, ctx)) return;
  if (await handleAiHistoryAdminStringSelect(interaction, ctx)) return;
  if (await handleReactionRoleStringSelect(interaction, ctx)) return;
  if (await handleVcGenreSelect(interaction, ctx)) return;
}

export async function routeChannelSelectMenu(
  interaction: ChannelSelectMenuInteraction,
  ctx: BotContext,
): Promise<void> {
  if (await handleSetupChannelSelect(interaction, ctx)) return;
  if (await handleReminderHubChannelSelect(interaction, ctx)) return;
}
