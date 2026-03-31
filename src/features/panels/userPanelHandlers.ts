import type { ButtonInteraction } from "discord.js";
import type { BotContext } from "../../bot/context.js";
import {
  handleUserPanelModmailStart,
  handleUserPanelTicketGuild,
} from "../modmail/modmailHandlers.js";
import {
  USER_PANEL_MODMAIL_BUTTON_ID,
  USER_PANEL_TICKET_BUTTON_ID,
} from "./userPanelsPayload.js";

export async function handleUserContactPanelButton(
  interaction: ButtonInteraction,
  ctx: BotContext,
): Promise<boolean> {
  const id = interaction.customId;
  if (id !== USER_PANEL_MODMAIL_BUTTON_ID && id !== USER_PANEL_TICKET_BUTTON_ID) return false;

  if (id === USER_PANEL_MODMAIL_BUTTON_ID) {
    await handleUserPanelModmailStart(interaction, ctx);
    return true;
  }

  await handleUserPanelTicketGuild(interaction, ctx);
  return true;
}
