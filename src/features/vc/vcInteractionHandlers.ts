import {
  MessageFlags,
  type ButtonInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import type { BotContext } from "../../bot/context.js";
import {
  buildVcCreatorGenreRows,
  buildVcRenameGenreRows,
  parseVcRenameGenreSelectId,
  parseVcRenameModalCustomId,
  VC_GENRE_SELECT_ID,
  VC_NAME_MODAL_PREFIX,
  VC_OPEN_MODAL_ID,
  VC_RENAME_BUTTON_ID,
} from "./vcCreatorUi.js";
import { runNologToggleAndBuildEmbed, trySendNologEmbedInChannel } from "../messageLog/messageLogNolog.js";
import { buildVcNameModal, buildVcRenameModal } from "./vcCreatorPanel.js";
import { vcCreatorErrText, vcRenameErrText } from "./vcTemporaryChannelManager.js";

async function resolveCurrentVoiceChannel(
  interaction: ButtonInteraction | ModalSubmitInteraction | StringSelectMenuInteraction,
) {
  const guild = interaction.guild;
  if (!guild) return null;
  const member = guild.members.cache.get(interaction.user.id) ?? (await guild.members.fetch(interaction.user.id).catch(() => null));
  return member?.voice.channel ?? null;
}

function normalizeRenamedVcName(rawName: string, genre: string): string {
  const prefix = `[${genre}]:`;
  const trimmed = rawName.trim();
  const withoutPrefix = trimmed.startsWith(prefix)
    ? trimmed.slice(prefix.length).trim()
    : trimmed.replace(/^\[[^\]]+\]:\s*/, "").trim();
  return withoutPrefix ? `${prefix}${withoutPrefix}` : prefix;
}

export async function handleVcCreatorButton(
  interaction: ButtonInteraction,
  ctx: BotContext,
): Promise<boolean> {
  if (interaction.customId === VC_OPEN_MODAL_ID) {
    await interaction.reply({
      content: "ジャンルを選択してください",
      components: buildVcCreatorGenreRows(),
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (interaction.customId !== VC_RENAME_BUTTON_ID) return false;

  const voiceChannel = await resolveCurrentVoiceChannel(interaction);
  if (!voiceChannel) {
    await interaction.reply({
      content: "現在VCに接続していないため、VC名変更は開始できません。",
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (!ctx.vcTemp.isTrackedTemporaryVc(voiceChannel.id)) {
    await interaction.reply({
      content: "現在接続中のVCは変更対象ではありません。",
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  await interaction.reply({
    content: "ジャンルを選択するとVC名変更モーダルを開きます。",
    components: buildVcRenameGenreRows(voiceChannel.id),
    flags: MessageFlags.Ephemeral,
  });
  return true;
}

export async function handleVcGenreSelect(
  interaction: StringSelectMenuInteraction,
  ctx: BotContext,
): Promise<boolean> {
  if (interaction.customId === VC_GENRE_SELECT_ID) {
    const genre = interaction.values?.[0];
    if (!genre) {
      await interaction.reply({ content: "ジャンル選択に失敗しました。", flags: MessageFlags.Ephemeral });
      return true;
    }
    await interaction.showModal(buildVcNameModal(genre));
    return true;
  }

  const renameChannelId = parseVcRenameGenreSelectId(interaction.customId);
  if (!renameChannelId) return false;

  const genre = interaction.values?.[0];
  if (!genre) {
    await interaction.reply({ content: "ジャンル選択に失敗しました。", flags: MessageFlags.Ephemeral });
    return true;
  }

  const voiceChannel = await resolveCurrentVoiceChannel(interaction);
  if (!voiceChannel || voiceChannel.id !== renameChannelId) {
    await interaction.reply({
      content: "同じVCに接続したまま操作してください。",
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (!ctx.vcTemp.isTrackedTemporaryVc(renameChannelId)) {
    await interaction.reply({
      content: "現在接続中のVCは変更対象ではありません。",
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  await interaction.showModal(buildVcRenameModal(renameChannelId, genre, voiceChannel.name));
  return true;
}

export async function handleVcCreateModal(
  interaction: ModalSubmitInteraction,
  ctx: BotContext,
): Promise<boolean> {
  if (!interaction.customId.startsWith(VC_NAME_MODAL_PREFIX)) return false;
  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({ content: "この機能はサーバー内のみ使用できます。", flags: MessageFlags.Ephemeral });
    return true;
  }

  // VC作成とDB保存は3秒の応答期限を超えることがあるため、先に応答を保留する。
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const genre = interaction.customId.slice(VC_NAME_MODAL_PREFIX.length).trim();
  const vcName = interaction.fields.getTextInputValue("vc_name_input").trim();
  const finalName = genre ? `[${genre}]:${vcName}` : vcName;
  const result = await ctx.vcTemp.createTemporaryVc(guild, {
    name: finalName,
    creatorUserId: interaction.user.id,
    creatorTag: interaction.user.tag,
  });

  if (!result.ok) {
    await interaction.editReply({ content: vcCreatorErrText[result.error] ?? "VC作成に失敗しました。" });
    return true;
  }

  // VCは作成済みなので、完了通知に失敗してもnolog案内の送信は続ける。
  await interaction
    .editReply({ content: `VC ${result.name} を作成しました` })
    .catch((err) => ctx.log.warn({ err, channelId: result.channelId }, "temporary VC create reply failed"));
  const created = await guild.channels.fetch(result.channelId).catch(() => null);
  if (created) {
    const botId = ctx.client.user?.id;
    if (botId) {
      const nologEmbed = await runNologToggleAndBuildEmbed(ctx.db, guild.id, created.id, botId);
      await trySendNologEmbedInChannel(created, nologEmbed, ctx.log, botId);
    }
  }
  return true;
}

export async function handleVcRenameModal(
  interaction: ModalSubmitInteraction,
  ctx: BotContext,
): Promise<boolean> {
  const parsed = parseVcRenameModalCustomId(interaction.customId);
  if (!parsed) return false;

  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({ content: "この機能はサーバー内のみ使用できます。", flags: MessageFlags.Ephemeral });
    return true;
  }

  // メンバー取得とVC名変更は3秒の応答期限を超えることがあるため、先に応答を保留する。
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const voiceChannel = await resolveCurrentVoiceChannel(interaction);
  if (!voiceChannel || voiceChannel.id !== parsed.channelId) {
    await interaction.editReply({ content: "同じVCに接続したまま操作してください。" });
    return true;
  }

  if (!ctx.vcTemp.isTrackedTemporaryVc(parsed.channelId)) {
    await interaction.editReply({ content: "現在接続中のVCは変更対象ではありません。" });
    return true;
  }

  const finalName = normalizeRenamedVcName(
    interaction.fields.getTextInputValue("vc_name_after_input"),
    parsed.genre,
  );
  if (finalName === `[${parsed.genre}]:`) {
    await interaction.editReply({ content: "変更後VC名を入力してください。" });
    return true;
  }

  const result = await ctx.vcTemp.renameTemporaryVc(parsed.channelId, {
    name: finalName,
    actorUserId: interaction.user.id,
    actorTag: interaction.user.tag,
  });

  if (result.ok) {
    await interaction.editReply({ content: `VC名を ${result.name} に変更しました。` });
  } else {
    await interaction.editReply({ content: vcRenameErrText[result.error] ?? "VC名の変更に失敗しました。" });
  }
  return true;
}
