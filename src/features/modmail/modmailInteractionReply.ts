import { MessageFlags, type ButtonInteraction, type ModalSubmitInteraction } from "discord.js";

// Modmail のボタン・モーダル応答で共有する一時返信。
// modmailStaffInteractions.ts と modmailTicketIntake.ts の両方から使う。
export async function replyEphemeral(interaction: ButtonInteraction | ModalSubmitInteraction, text: string): Promise<void> {
  const flags = interaction.guildId ? MessageFlags.Ephemeral : undefined;
  try {
    if (interaction.deferred) await interaction.editReply({ content: text });
    else if (interaction.replied) await interaction.followUp({ content: text, ...(flags ? { flags } : {}) });
    else await interaction.reply({ content: text, ...(flags ? { flags } : {}) });
  } catch {}
}
