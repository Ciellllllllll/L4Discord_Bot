import type {
  ButtonInteraction,
  ModalSubmitInteraction,
  StringSelectMenuInteraction,
} from "discord.js";
import type { BotContext } from "../../bot/context.js";
import {
  buildVcCreatorGenreRows,
  VC_GENRE_SELECT_ID,
  VC_NAME_MODAL_PREFIX,
  VC_OPEN_MODAL_ID,
} from "./vcCreatorUi.js";
import { runNologToggleAndBuildEmbed, trySendNologEmbedInChannel } from "../messageLog/messageLogNolog.js";
import { buildVcNameModal, vcCreatorErrText } from "./vcTemporaryChannelManager.js";

export async function handleVcCreatorButton(
  interaction: ButtonInteraction,
  _ctx: BotContext,
): Promise<boolean> {
  if (interaction.customId !== VC_OPEN_MODAL_ID) return false;
  await interaction.reply({
    content: "ジャンルを選択してください",
    components: buildVcCreatorGenreRows(),
    ephemeral: true,
  });
  return true;
}

export async function handleVcGenreSelect(
  interaction: StringSelectMenuInteraction,
  _ctx: BotContext,
): Promise<boolean> {
  if (interaction.customId !== VC_GENRE_SELECT_ID) return false;
  const genre = interaction.values?.[0];
  if (!genre) {
    await interaction.reply({ content: "ジャンル選択に失敗しました。", ephemeral: true });
    return true;
  }
  await interaction.showModal(buildVcNameModal(genre));
  return true;
}

export async function handleVcCreateModal(
  interaction: ModalSubmitInteraction,
  ctx: BotContext,
): Promise<boolean> {
  if (!interaction.customId.startsWith(VC_NAME_MODAL_PREFIX)) return false;
  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({ content: "この機能はサーバー内のみ使用できます。", ephemeral: true });
    return true;
  }

  const vcName = interaction.fields.getTextInputValue("vc_name_input").trim();
  const result = await ctx.vcTemp.createTemporaryVc(guild, {
    name: vcName,
    creatorUserId: interaction.user.id,
    creatorTag: interaction.user.tag,
  });

  if (result.ok) {
    await interaction.reply({ content: `VC ${result.name} を作成しました`, ephemeral: true });
    const created = await guild.channels.fetch(result.channelId).catch(() => null);
    if (created) {
      const botId = ctx.client.user?.id;
      if (botId) {
        const nologEmbed = await runNologToggleAndBuildEmbed(ctx.db, guild.id, created.id, botId);
        await trySendNologEmbedInChannel(created, nologEmbed, ctx.log, botId);
      }
    }
  } else {
    await interaction.reply({
      content: vcCreatorErrText[result.error] ?? "VC作成に失敗しました。",
      ephemeral: true,
    });
  }
  return true;
}
