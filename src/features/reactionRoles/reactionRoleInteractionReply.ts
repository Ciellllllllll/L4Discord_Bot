import {
  ActionRowBuilder,
  MessageFlags,
  type InteractionReplyOptions,
  type StringSelectMenuBuilder,
} from "discord.js";

// リアクションロールの一時返信。

export async function replyEphemeral(
  interaction: {
    replied: boolean;
    deferred: boolean;
    reply(options: InteractionReplyOptions): Promise<unknown>;
    followUp(options: InteractionReplyOptions): Promise<unknown>;
  },
  content: string,
  components?: ActionRowBuilder<StringSelectMenuBuilder>[],
): Promise<void> {
  const payload: InteractionReplyOptions = { content, flags: MessageFlags.Ephemeral, components };
  if (interaction.replied || interaction.deferred) {
    await interaction.followUp(payload).catch(() => undefined);
    return;
  }
  await interaction.reply(payload).catch(() => undefined);
}
