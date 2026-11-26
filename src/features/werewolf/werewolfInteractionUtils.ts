import { componentCardsPayload } from "../../core/componentCard.js";
import {
  MessageFlags,
  PermissionFlagsBits,
  StringSelectMenuOptionBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type GuildMember,
  type StringSelectMenuInteraction,
  type TextChannel,
  type ThreadChannel,
} from "discord.js";
import type { CoreDeps } from "../../core/deps.js";
import { buildLobbyRows, errorCard, lobbyCard, statusCard, truncateSelectLabel } from "./werewolfUi.js";
import type { WerewolfPhase, WerewolfPlayer, WerewolfRole, WerewolfState } from "./werewolfState.js";

// 人狼ゲームの共通ヘルパー。

// Werewolf が使う依存。
export type WerewolfDeps = Pick<CoreDeps, "config" | "db" | "log" | "client">;

export const NIGHT_MS = 2 * 60_000;
export const DAY_MS = 5 * 60_000;
export const VOTE_MS = 2 * 60_000;
export const REQUIRED_PERMISSIONS = [
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.CreatePrivateThreads,
  PermissionFlagsBits.SendMessagesInThreads,
  PermissionFlagsBits.ManageThreads,
];

export function replyError(
  interaction: ChatInputCommandInteraction | ButtonInteraction | StringSelectMenuInteraction,
  message: string,
  suppressMentions = false,
) {
  return interaction.reply({
    ...componentCardsPayload([errorCard(message)]),
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    ...(suppressMentions ? { allowedMentions: { parse: [] as const } } : {}),
  });
}

export function replyStatus(interaction: ButtonInteraction | StringSelectMenuInteraction, message: string) {
  return interaction.reply({
    ...componentCardsPayload([statusCard(message)]),
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
  });
}

export function validatePublicInteraction(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  state: WerewolfState,
  phase: WerewolfPhase,
): boolean {
  return state.phase === phase && interaction.channelId === state.werewolfChannelId;
}

export async function replyRejected(interaction: ButtonInteraction | StringSelectMenuInteraction): Promise<boolean> {
  await replyError(interaction, "この操作は現在の状態では実行できません。");
  return true;
}

export async function updateLobbyMessage(
  interaction: ButtonInteraction,
  sessionId: string,
  state: WerewolfState,
  disabled = false,
): Promise<void> {
  await interaction.message.edit({
    ...componentCardsPayload([lobbyCard(state, disabled)], buildLobbyRows(sessionId, disabled)),
    allowedMentions: { parse: [] },
  }).catch(() => undefined);
}

export async function deleteLobbyMessage(ctx: WerewolfDeps, state: WerewolfState): Promise<void> {
  if (!state.lobbyMessageId) return;
  const channel = await fetchTextChannel(ctx, state.werewolfChannelId);
  const message = await channel?.messages.fetch(state.lobbyMessageId).catch(() => null);
  await message?.delete().catch((err) => {
    ctx.log.warn({ err, lobbyMessageId: state.lobbyMessageId }, "werewolf: delete lobby message failed");
  });
}

export function allNightActionsSubmitted(state: WerewolfState): boolean {
  const alive = alivePlayers(state);
  const aliveByRole = (role: WerewolfRole) => alive.filter((p) => p.role === role);
  return aliveByRole("werewolf").every((p) => state.nightActions.attack[p.userId])
    && aliveByRole("seer").every((p) => state.nightActions.inspect[p.userId])
    && aliveByRole("knight").every((p) => state.nightActions.guard[p.userId]);
}

export function alivePlayers(state: WerewolfState): WerewolfPlayer[] {
  return state.players.filter((p) => p.alive);
}

export async function buildPlayerSelectOptions(
  ctx: WerewolfDeps,
  channelId: string,
  players: WerewolfPlayer[],
): Promise<StringSelectMenuOptionBuilder[]> {
  const channel = await fetchTextChannel(ctx, channelId);
  const guild = channel?.guild ?? ctx.client.guilds.cache.get(ctx.config.GUILD_ID) ?? null;
  return Promise.all(players.map(async (player) => {
    const member = guild
      ? guild.members.cache.get(player.userId) ?? (await guild.members.fetch(player.userId).catch(() => null))
      : null;
    const label = truncateSelectLabel(member?.displayName ?? member?.user.globalName ?? member?.user.username ?? player.userId);
    return new StringSelectMenuOptionBuilder()
      .setLabel(label)
      .setDescription(`ID: ${player.userId.slice(0, 20)}`)
      .setValue(player.userId);
  }));
}

export async function fetchTextChannel(ctx: WerewolfDeps, channelId: string): Promise<TextChannel | null> {
  const channel = await ctx.client.channels.fetch(channelId).catch(() => null);
  if (!channel || channel.isDMBased() || !channel.isTextBased() || channel.isThread()) return null;
  return channel as TextChannel;
}

export async function fetchThread(ctx: WerewolfDeps, threadId: string): Promise<ThreadChannel | null> {
  const channel = await ctx.client.channels.fetch(threadId).catch(() => null);
  return channel?.isThread() ? channel : null;
}

export function hasWerewolfPermissions(member: GuildMember | null, channel: TextChannel): boolean {
  if (!member) return false;
  const perms = member.permissionsIn(channel);
  return REQUIRED_PERMISSIONS.every((p) => perms.has(p));
}
