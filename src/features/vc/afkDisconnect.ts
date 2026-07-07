import { ComponentCardBuilder, componentCardsPayload } from "../panels/componentCard.js";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  DiscordAPIError,
  MessageFlags,
  PermissionFlagsBits,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type GuildMember,
} from "discord.js";
import type { BotContext } from "../../bot/context.js";

const AFK_CUSTOM_ID_PREFIX = "afk:";
const AFK_CONFIRM_TTL_MS = 10 * 60 * 1000;

type AfkButtonAction = "approve" | "cancel";

type AfkButtonPayload = {
  action: AfkButtonAction;
  invokerId: string;
  targetId: string;
  createdAtMs: number;
};

function buildAfkCustomId(action: AfkButtonAction, invokerId: string, targetId: string, createdAtMs: number): string {
  return `${AFK_CUSTOM_ID_PREFIX}${action}:${invokerId}:${targetId}:${createdAtMs}`;
}

function parseAfkCustomId(customId: string): AfkButtonPayload | null {
  if (!customId.startsWith(AFK_CUSTOM_ID_PREFIX)) return null;
  const parts = customId.split(":");
  if (parts.length !== 5) return null;
  const [, action, invokerId, targetId, createdAt] = parts;
  if (action !== "approve" && action !== "cancel") return null;
  if (!/^\d+$/.test(invokerId) || !/^\d+$/.test(targetId)) return null;
  const createdAtMs = Number(createdAt);
  if (!Number.isFinite(createdAtMs) || createdAtMs <= 0) return null;
  return { action, invokerId, targetId, createdAtMs };
}

function buildConfirmRows(
  invokerId: string,
  targetId: string,
  createdAtMs: number,
  disabled: boolean,
): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(buildAfkCustomId("approve", invokerId, targetId, createdAtMs))
        .setLabel("承認")
        .setStyle(ButtonStyle.Success)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId(buildAfkCustomId("cancel", invokerId, targetId, createdAtMs))
        .setLabel("取り消し")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled),
    ),
  ];
}

function buildConfirmEmbed(invokerId: string, targetId: string, channelId: string): ComponentCardBuilder {
  return new ComponentCardBuilder()
    .setTitle("AFKユーザー切断確認")
    .setDescription(`<@${targetId}>（寝落ちユーザー）を切断してもよろしいでしょうか？`)
    .addFields(
      { name: "対象VC", value: `<#${channelId}>`, inline: false },
      { name: "実行者", value: `<@${invokerId}>`, inline: true },
      { name: "対象ユーザー", value: `<@${targetId}>`, inline: true },
    )
    .setColor(0xf1c40f)
    .setTimestamp(new Date());
}

function buildResultEmbed(title: string, description: string, color: number): ComponentCardBuilder {
  return new ComponentCardBuilder().setTitle(title).setDescription(description).setColor(color).setTimestamp(new Date());
}

function isSameVoiceChannel(invoker: GuildMember, target: GuildMember): boolean {
  const invokerChannelId = invoker.voice.channelId;
  const targetChannelId = target.voice.channelId;
  return Boolean(invokerChannelId && targetChannelId && invokerChannelId === targetChannelId);
}

function canBotDisconnect(target: GuildMember): boolean {
  const channel = target.voice.channel;
  const me = target.guild.members.me;
  if (!channel || !me) return false;
  return channel.permissionsFor(me)?.has(PermissionFlagsBits.MoveMembers) ?? false;
}

function disconnectReason(invoker: GuildMember): string {
  return `/afk command approved by ${invoker.user.tag} (${invoker.id})`;
}

async function sendAfkModLog(
  ctx: BotContext,
  invoker: GuildMember,
  target: GuildMember,
  channelId: string,
  disconnectedAt: Date,
): Promise<void> {
  const modLogChannelId = ctx.config.MOD_LOG_CHANNEL_ID?.trim();
  if (!modLogChannelId) {
    ctx.log.warn({ command: "afk" }, "afk: MOD_LOG_CHANNEL_ID is not configured");
    return;
  }

  const channel = await ctx.client.channels.fetch(modLogChannelId).catch((err) => {
    ctx.log.warn({ err, modLogChannelId }, "afk: failed to fetch MOD_LOG_CHANNEL_ID channel");
    return null;
  });
  if (!channel?.isTextBased() || channel.isDMBased()) {
    ctx.log.warn({ modLogChannelId }, "afk: MOD_LOG_CHANNEL_ID is not a guild text-based channel");
    return;
  }

  const unix = Math.floor(disconnectedAt.getTime() / 1000);
  const embed = new ComponentCardBuilder()
    .setTitle("/afk VC切断ログ")
    .setDescription("コマンドを介してVCからユーザーを切断しました。")
    .addFields(
      { name: "実行者", value: `<@${invoker.id}> (${invoker.id})`, inline: false },
      { name: "対象ユーザー", value: `<@${target.id}> (${target.id})`, inline: false },
      { name: "実行時刻", value: `<t:${unix}:F>`, inline: false },
      { name: "対象VC", value: `<#${channelId}>`, inline: false },
    )
    .setColor(0xe67e22)
    .setTimestamp(disconnectedAt);

  await channel
    .send({
      ...componentCardsPayload([embed]),
      allowedMentions: { parse: [] },
    })
    .catch((err) => ctx.log.warn({ err, modLogChannelId }, "afk: failed to send mod log"));
}

export async function startAfkDisconnectCommand(
  interaction: ChatInputCommandInteraction,
  _ctx: BotContext,
): Promise<void> {
  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({ content: "サーバー内でのみ実行できます。", flags: MessageFlags.Ephemeral });
    return;
  }

  const targetUser = interaction.options.getUser("target", true);
  if (targetUser.id === interaction.user.id) {
    await interaction.reply({ content: "自分自身は対象にできません。", flags: MessageFlags.Ephemeral });
    return;
  }

  let invokerMember: GuildMember;
  let targetMember: GuildMember;
  try {
    [invokerMember, targetMember] = await Promise.all([
      guild.members.fetch(interaction.user.id),
      guild.members.fetch(targetUser.id),
    ]);
  } catch {
    await interaction.reply({
      content: "ユーザー情報を取得できませんでした。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!invokerMember.voice.channelId || !targetMember.voice.channelId) {
    await interaction.reply({
      content: "実行者と対象ユーザーの両方がVCに接続している必要があります。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!isSameVoiceChannel(invokerMember, targetMember)) {
    await interaction.reply({
      content: "実行者と対象ユーザーが同じVCにいる場合のみ実行できます。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!canBotDisconnect(targetMember)) {
    await interaction.reply({
      content: "BOTに対象VCでメンバーを移動する権限がないため、切断できません。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const voiceChannelId = targetMember.voice.channelId;
  const createdAtMs = Date.now();
  await interaction.reply({
    ...componentCardsPayload(
      [buildConfirmEmbed(interaction.user.id, targetUser.id, voiceChannelId)],
      buildConfirmRows(interaction.user.id, targetUser.id, createdAtMs, false),
    ),
    allowedMentions: { users: [interaction.user.id, targetUser.id] },
  });
}

export async function handleAfkDisconnectButton(
  interaction: ButtonInteraction,
  ctx: BotContext,
): Promise<boolean> {
  const payload = parseAfkCustomId(interaction.customId);
  if (!payload) return false;

  if (interaction.user.id !== payload.invokerId) {
    await interaction.reply({
      content: "この確認ボタンはコマンド実行者のみ操作できます。",
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (Date.now() - payload.createdAtMs > AFK_CONFIRM_TTL_MS) {
    await interaction.update({
      ...componentCardsPayload(
        [
          buildResultEmbed(
          "AFKユーザー切断確認",
          "確認の有効期限が切れたため、操作を終了しました。",
          0x95a5a6,
        ),
        ],
        buildConfirmRows(payload.invokerId, payload.targetId, payload.createdAtMs, true),
      ),
    });
    return true;
  }

  if (payload.action === "cancel") {
    await interaction.update({
      ...componentCardsPayload(
        [buildResultEmbed("AFKユーザー切断確認", "切断操作を取り消しました。", 0x95a5a6)],
        buildConfirmRows(payload.invokerId, payload.targetId, payload.createdAtMs, true),
      ),
    });
    return true;
  }

  const guild = interaction.guild;
  if (!guild) {
    await interaction.update({
      ...componentCardsPayload(
        [buildResultEmbed("AFKユーザー切断失敗", "サーバー情報を取得できませんでした。", 0xe74c3c)],
        buildConfirmRows(payload.invokerId, payload.targetId, payload.createdAtMs, true),
      ),
    });
    return true;
  }

  await interaction.deferUpdate();

  let invokerMember: GuildMember;
  let targetMember: GuildMember;
  try {
    [invokerMember, targetMember] = await Promise.all([
      guild.members.fetch(payload.invokerId),
      guild.members.fetch(payload.targetId),
    ]);
  } catch {
    await interaction.editReply({
      ...componentCardsPayload(
        [buildResultEmbed("AFKユーザー切断失敗", "ユーザー情報を取得できませんでした。", 0xe74c3c)],
        buildConfirmRows(payload.invokerId, payload.targetId, payload.createdAtMs, true),
      ),
    });
    return true;
  }

  if (!invokerMember.voice.channelId || !targetMember.voice.channelId || !isSameVoiceChannel(invokerMember, targetMember)) {
    await interaction.editReply({
      ...componentCardsPayload(
        [
          buildResultEmbed(
          "AFKユーザー切断中止",
          "実行者と対象ユーザーが同じVCに接続していないため、操作を終了しました。",
          0x95a5a6,
        ),
        ],
        buildConfirmRows(payload.invokerId, payload.targetId, payload.createdAtMs, true),
      ),
    });
    return true;
  }

  if (!canBotDisconnect(targetMember)) {
    await interaction.editReply({
      ...componentCardsPayload(
        [
          buildResultEmbed(
          "AFKユーザー切断失敗",
          "BOTに対象VCでメンバーを移動する権限がないため、切断できません。",
          0xe74c3c,
        ),
        ],
        buildConfirmRows(payload.invokerId, payload.targetId, payload.createdAtMs, true),
      ),
    });
    return true;
  }

  const disconnectedFromChannelId = targetMember.voice.channelId;
  try {
    await targetMember.voice.disconnect(disconnectReason(invokerMember));
  } catch (err) {
    ctx.log.warn({ err, targetId: payload.targetId, invokerId: payload.invokerId }, "afk: disconnect failed");
    const errorText = err instanceof DiscordAPIError ? `Discord API: ${err.message}` : "Discord APIで切断に失敗しました。";
    await interaction.editReply({
      ...componentCardsPayload(
        [buildResultEmbed("AFKユーザー切断失敗", errorText, 0xe74c3c)],
        buildConfirmRows(payload.invokerId, payload.targetId, payload.createdAtMs, true),
      ),
    });
    return true;
  }

  const disconnectedAt = new Date();
  await sendAfkModLog(ctx, invokerMember, targetMember, disconnectedFromChannelId, disconnectedAt);

  await interaction.editReply({
    ...componentCardsPayload(
      [
        buildResultEmbed(
        "AFKユーザー切断完了",
        `<@${payload.targetId}> を <#${disconnectedFromChannelId}> から切断しました。`,
        0x2ecc71,
      ),
      ],
      buildConfirmRows(payload.invokerId, payload.targetId, payload.createdAtMs, true),
    ),
    allowedMentions: { users: [payload.targetId] },
  });
  return true;
}
