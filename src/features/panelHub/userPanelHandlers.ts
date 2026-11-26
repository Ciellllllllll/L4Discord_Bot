import { MessageFlags, type ButtonInteraction } from "discord.js";
import type { CoreDeps } from "../../core/deps.js";
import { handleUserPanelModmailStart } from "../modmail/modmailHandlers.js";
import { USER_PANEL_MODMAIL_BUTTON_ID, USER_PANEL_TICKET_BUTTON_ID } from "../panels/userPanelsPayload.js";

// UserPanelHandler が使う依存。
type UserPanelHandlerDeps = Pick<CoreDeps, "ticketDb" | "log">;

export async function handleUserContactPanelButton(
  interaction: ButtonInteraction,
  ctx: UserPanelHandlerDeps,
): Promise<boolean> {
  const id = interaction.customId;
  if (id !== USER_PANEL_MODMAIL_BUTTON_ID && id !== USER_PANEL_TICKET_BUTTON_ID) return false;

  if (id === USER_PANEL_TICKET_BUTTON_ID) {
    await interaction.reply({
      content:
        "「チケットを作る」は廃止されました。「お問い合わせを始める」から DM で受付してください。",
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  await handleUserPanelModmailStart(interaction, ctx);
  return true;
}
