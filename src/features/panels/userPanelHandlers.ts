import { MessageFlags, type ButtonInteraction } from "discord.js";
import type { BotContext } from "../../bot/context.js";
import { handleUserPanelModmailStart } from "../modmail/modmailHandlers.js";
import { USER_PANEL_MODMAIL_BUTTON_ID, USER_PANEL_TICKET_BUTTON_ID } from "./userPanelsPayload.js";

export async function handleUserContactPanelButton(
  interaction: ButtonInteraction,
  ctx: BotContext,
): Promise<boolean> {
  const id = interaction.customId;
  if (id !== USER_PANEL_MODMAIL_BUTTON_ID && id !== USER_PANEL_TICKET_BUTTON_ID) return false;

  if (id === USER_PANEL_TICKET_BUTTON_ID) {
    await interaction.reply({
      content:
        "「チケットを作る」は廃止されました。「Modmailを始める」から DM で受付してください。",
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  await handleUserPanelModmailStart(interaction, ctx);
  return true;
}
