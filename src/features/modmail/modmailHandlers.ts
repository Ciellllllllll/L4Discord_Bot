import { MessageFlags, type ButtonInteraction } from "discord.js";
import type { BotContext } from "../../bot/context.js";
import { buildModmailStartAttachmentRow } from "./modmailUi.js";
import { openModmailByGuildUser, sendModmailStartDm, upsertModmailIntake } from "./modmailService.js";

export async function handleUserPanelModmailStart(
  interaction: ButtonInteraction,
  ctx: BotContext,
): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({ content: "ギルド内でのみ利用できます。", ephemeral: true });
    return;
  }
  const guildId = interaction.guildId;
  const uid = interaction.user.id;

  const open = await openModmailByGuildUser(ctx, guildId, uid);
  if (open) {
    await interaction.reply({ content: "現在対応中のチケットがあります。新規作成はできません。", ephemeral: true });
    return;
  }

  try {
    await upsertModmailIntake(ctx, guildId, uid);
    await sendModmailStartDm(interaction.user, [buildModmailStartAttachmentRow(guildId, uid)]);
    await interaction.reply({
      content: "DM を送信しました。DM で相談内容を送ってください（最初のメッセージで受付が始まります）。",
      flags: MessageFlags.Ephemeral,
    });
  } catch (e) {
    ctx.log.warn({ err: e, guildId, userId: uid }, "modmail start DM failed");
    await interaction.reply({
      content: "Bot から DM を送信できませんでした。Bot の DM を受け取れる設定にしてください。",
      flags: MessageFlags.Ephemeral,
    });
  }
}
