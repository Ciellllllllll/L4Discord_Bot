import type {
  ButtonInteraction,
  ChannelSelectMenuInteraction,
  ModalSubmitInteraction,
  StringSelectMenuInteraction,
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
  handleVcRenameModal,
} from "../features/vc/vcInteractionHandlers.js";
import { handleAfkDisconnectButton } from "../features/vc/afkDisconnect.js";
import {
  handleReactionRoleButton,
  handleReactionRoleModal,
  handleReactionRoleStringSelect,
} from "../features/reactionRoles/reactionRoleHandlers.js";
import {
  handleAiHistoryAdminButton,
  handleAiHistoryAdminStringSelect,
} from "../features/ai/aiHistoryAdminPanel.js";
import { handleAiHistoryClearButton, handleShowPromptApplyButton } from "../features/ai/aiQueryService.js";
import { handleChangePromptModalSubmit } from "../features/ai/changePromptHandlers.js";
import { handleCreatePromptButton, handleCreatePromptModalSubmit } from "../features/ai/createPrompt.js";
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
import { handleDetecterButton, handleDetecterModal } from "../features/detecter/detecterInteractions.js";
import { handleExecutionFlowButton } from "../features/execution/executionFlow.js";
import { handleTimeoutExtendFlowButton } from "../features/execution/timeoutExtendFlow.js";
import { handleGameDealButton } from "../features/gameDeals/gameDealWatcher.js";
import { handleWerewolfButton, handleWerewolfStringSelect } from "../features/werewolf/werewolfGame.js";
import { handleAnonymousSurveyButton, handleAnonymousSurveyModalSubmit } from "../features/anonymousSurvey/surveyHandlers.js";
import { handleAnonymousSurveyViewButton } from "../features/anonymousSurvey/surveyView.js";
import { handleBokeruButton, handleBokeruModal } from "../features/bokeru/bokeru.js";
import { handleVxTwitterPreviewButton } from "../features/utilities/vxtwitterPreviewInteractions.js";
import { handlePreviewInteraction } from "../features/linkPreviews/shared/previewInteractions.js";
import { refreshPreviewTranslationState } from "../features/linkPreviews/linkPreviewMessageHandler.js";
import { handleWebSummaryInteraction } from "../features/linkPreviews/web/webSummaryInteractions.js";
import { handleYouTubeMediaRefresh } from "../features/linkPreviews/youtube/youtubeMediaRefresh.js";

export async function routeButton(interaction: ButtonInteraction, ctx: BotContext): Promise<void> {
  if (await handlePreviewInteraction(interaction, ctx, {
    refreshState: async ({ message, guildId, channelId }) => await refreshPreviewTranslationState(
      message,
      ctx,
      guildId,
      channelId,
    ),
  })) return;
  if (await handleWebSummaryInteraction(interaction, ctx)) return;
  if (await handleYouTubeMediaRefresh(interaction, ctx)) return;
  if (await handleVxTwitterPreviewButton(interaction, ctx)) return;
  if (await handleAnonymousSurveyViewButton(interaction, ctx)) return;
  if (await handleAnonymousSurveyButton(interaction, ctx)) return;
  if (await handleExecutionFlowButton(interaction, ctx)) return;
  if (await handleTimeoutExtendFlowButton(interaction, ctx)) return;
  if (await handleWerewolfButton(interaction, ctx)) return;
  if (await handleBokeruButton(interaction, ctx)) return;
  if (await handleAutoModRaidButton(interaction, ctx)) return;
  if (await handleReminderHubButton(interaction, ctx)) return;
  if (await handleAiHistoryClearButton(interaction, ctx)) return;
  if (await handleShowPromptApplyButton(interaction, ctx)) return;
  if (await handleCreatePromptButton(interaction, ctx)) return;
  if (await handleAiHistoryAdminButton(interaction, ctx)) return;
  if (await routeMessageLogButton(interaction, ctx)) return;
  if (await routeModmailStaffAndUserInteractions(interaction, ctx)) return;
  if (await handleAppealStartButton(interaction, ctx)) return;
  if (await handleAppealReviewButton(interaction, ctx)) return;
  if (await handleUserContactPanelButton(interaction, ctx)) return;
  if (await handleReactionRoleButton(interaction, ctx)) return;
  if (await handleDetecterButton(interaction, ctx)) return;
  if (await handleAfkDisconnectButton(interaction, ctx)) return;
  if (await handleGameDealButton(interaction, ctx)) return;
  if (await handleVcCreatorButton(interaction, ctx)) return;
  if (await handleSetupUiOpenButton(interaction, ctx)) return;
}

export async function routeModal(interaction: ModalSubmitInteraction, ctx: BotContext): Promise<void> {
  if (await handleAnonymousSurveyModalSubmit(interaction, ctx)) return;
  if (await handleBokeruModal(interaction, ctx)) return;
  if (await handleChangePromptModalSubmit(interaction, ctx)) return;
  if (await handleCreatePromptModalSubmit(interaction, ctx)) return;
  if (await handleReminderHubModal(interaction, ctx)) return;
  if (await routeMessageLogModal(interaction, ctx)) return;
  if (await handleReactionRoleModal(interaction, ctx)) return;
  if (await handleAppealSubmitModal(interaction, ctx)) return;
  if (await routeModmailStaffAndUserInteractions(interaction, ctx)) return;
  if (await handleDetecterModal(interaction, ctx)) return;
  if (await handleVcRenameModal(interaction, ctx)) return;
  if (await handleVcCreateModal(interaction, ctx)) return;
}

export async function routeStringSelectMenu(
  interaction: StringSelectMenuInteraction,
  ctx: BotContext,
): Promise<void> {
  if (await handleAutoModStringSelect(interaction, ctx)) return;
  if (await handleWerewolfStringSelect(interaction, ctx)) return;
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
