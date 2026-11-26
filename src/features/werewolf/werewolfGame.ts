import { componentCardsPayload } from "../../core/componentCard.js";
import {
  MessageFlags,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type GuildMember,
  type StringSelectMenuInteraction,
  type TextChannel,
  type ThreadChannel,
} from "discord.js";
import { randomUUID } from "node:crypto";
import { isAdmin } from "../../core/permission.js";
import {
  assignRoles,
  canUseRoleThreadAction,
  createInitialWerewolfState,
  type WerewolfThreadRole,
} from "./werewolfState.js";
import {
  findOpenWerewolfGameForChannel,
  findWerewolfGameById,
  insertWerewolfGame,
  listActiveWerewolfGames,
  markWerewolfEnded,
  saveWerewolfState,
  type LoadedWerewolfGame,
} from "./werewolfRepository.js";
import {
  WEREWOLF_BUTTON_PREFIX,
  WEREWOLF_SELECT_PREFIX,
  buildLobbyRows,
  errorCard,
  formatMentions,
  lobbyCard,
  parseWerewolfButtonId,
  parseWerewolfSelectId,
  statusCard,
  werewolfCard,
} from "./werewolfUi.js";
import {
  NIGHT_MS,
  alivePlayers,
  allNightActionsSubmitted,
  deleteLobbyMessage,
  fetchTextChannel,
  hasWerewolfPermissions,
  replyError,
  replyRejected,
  replyStatus,
  updateLobbyMessage,
  validatePublicInteraction,
  type WerewolfDeps,
} from "./werewolfInteractionUtils.js";
import {
  createRoleThreads,
  finalizeNight,
  finalizeVoting,
  finishGame,
  postNightUis,
  scheduleDeadline,
} from "./werewolfProgression.js";

// 人狼ゲームの入口 (コマンド・ボタン・セレクト)。

export async function handleWerewolfCreate(
  interaction: ChatInputCommandInteraction,
  ctx: WerewolfDeps,
  member: GuildMember | null,
): Promise<void> {
  if (!member || !isAdmin(member, ctx.config)) {
    await replyError(interaction, "権限がありません。");
    return;
  }
  const channel = interaction.channel;
  if (!channel || channel.isDMBased() || !channel.isTextBased() || channel.isThread()) {
    await replyError(interaction, "人狼チャンネルで実行してください。");
    return;
  }
  if (ctx.config.BOT_PROFILE === "production") {
    const allowedChannelId = ctx.config.WEREWOLF_CHANNEL_ID?.trim();
    if (!allowedChannelId) {
      await replyError(interaction, "production では WEREWOLF_CHANNEL_ID を設定してください。");
      return;
    }
    if (interaction.channelId !== allowedChannelId) {
      await replyError(interaction, `このコマンドは <#${allowedChannelId}> でのみ使用できます。`, true);
      return;
    }
  }
  if (!hasWerewolfPermissions(member.guild.members.me, channel as TextChannel)) {
    await replyError(interaction, "BOTにプライベートスレッド作成・スレッド送信・スレッド管理権限が必要です。");
    return;
  }

  const existing = await findOpenWerewolfGameForChannel(ctx.db, interaction.guildId!, interaction.channelId);
  if (existing) {
    await replyError(interaction, "このチャンネルには進行中の人狼セッションがあります。");
    return;
  }

  const id = randomUUID();
  const state = createInitialWerewolfState({ channelId: interaction.channelId, hostId: interaction.user.id });
  await insertWerewolfGame(ctx.db, {
    id,
    guildId: interaction.guildId!,
    channelId: interaction.channelId,
    hostId: interaction.user.id,
    state,
  });

  await interaction.reply({
    ...componentCardsPayload([lobbyCard(state, false)], buildLobbyRows(id, false)),
    allowedMentions: { parse: [] },
  });
  const message = await interaction.fetchReply();
  state.lobbyMessageId = message.id;
  await saveWerewolfState(ctx.db, id, state);
}

export async function handleWerewolfEnd(
  interaction: ChatInputCommandInteraction,
  ctx: WerewolfDeps,
  member: GuildMember | null,
): Promise<void> {
  if (!member || !isAdmin(member, ctx.config)) {
    await replyError(interaction, "権限がありません。");
    return;
  }
  const game = await findOpenWerewolfGameForChannel(ctx.db, interaction.guildId!, interaction.channelId);
  if (!game) {
    await replyError(interaction, "終了対象のゲームがありません。");
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await finishGame(ctx, game.row.id, game.state, "管理者がゲームを終了しました。", undefined);
  await interaction.editReply({ ...componentCardsPayload([statusCard("このチャンネルの人狼セッションを終了しました。")]) });
}

export async function handleWerewolfButton(interaction: ButtonInteraction, ctx: WerewolfDeps): Promise<boolean> {
  if (!interaction.customId.startsWith(WEREWOLF_BUTTON_PREFIX)) return false;
  const parsed = parseWerewolfButtonId(interaction.customId);
  if (!parsed) {
    await replyError(interaction, "無効な操作です。");
    return true;
  }
  const game = await findWerewolfGameById(ctx.db, parsed.sessionId);
  if (!game || game.row.guild_id !== interaction.guildId) {
    await replyError(interaction, "このボタンは期限切れです。");
    return true;
  }
  if (parsed.action === "join") return handleJoin(interaction, ctx, game);
  if (parsed.action === "leave") return handleLeave(interaction, ctx, game);
  if (parsed.action === "start") return handleStart(interaction, ctx, game);
  if (parsed.action === "cancel") return handleCancel(interaction, ctx, game);
  await replyError(interaction, "無効な操作です。");
  return true;
}

export async function handleWerewolfStringSelect(
  interaction: StringSelectMenuInteraction,
  ctx: WerewolfDeps,
): Promise<boolean> {
  if (!interaction.customId.startsWith(WEREWOLF_SELECT_PREFIX)) return false;
  const parsed = parseWerewolfSelectId(interaction.customId);
  if (!parsed) {
    await replyError(interaction, "無効な操作です。");
    return true;
  }
  const game = await findWerewolfGameById(ctx.db, parsed.sessionId);
  const targetUserId = interaction.values[0];
  if (!game || game.row.guild_id !== interaction.guildId || !targetUserId) {
    await replyError(interaction, "この操作は期限切れです。");
    return true;
  }
  if (parsed.action === "vote") return handleVote(interaction, ctx, game, targetUserId);
  if (parsed.action === "night") return handleNightAction(interaction, ctx, game, parsed.role, targetUserId);
  await replyError(interaction, "無効な操作です。");
  return true;
}

export async function reconcileWerewolfGames(ctx: WerewolfDeps): Promise<void> {
  for (const { row, state } of await listActiveWerewolfGames(ctx.db)) {
    if (!state.deadlineAt) continue;
    scheduleDeadline(ctx, row.id, state);
  }
}

async function handleJoin(interaction: ButtonInteraction, ctx: WerewolfDeps, game: LoadedWerewolfGame): Promise<boolean> {
  if (!validatePublicInteraction(interaction, game.state, "lobby")) return replyRejected(interaction);
  if (!game.state.participants.includes(interaction.user.id)) {
    game.state.participants.push(interaction.user.id);
    await saveWerewolfState(ctx.db, game.row.id, game.state);
  }
  await updateLobbyMessage(interaction, game.row.id, game.state);
  await replyStatus(interaction, "参加しました。");
  return true;
}

async function handleLeave(interaction: ButtonInteraction, ctx: WerewolfDeps, game: LoadedWerewolfGame): Promise<boolean> {
  if (!validatePublicInteraction(interaction, game.state, "lobby")) return replyRejected(interaction);
  game.state.participants = game.state.participants.filter((id) => id !== interaction.user.id);
  await saveWerewolfState(ctx.db, game.row.id, game.state);
  await updateLobbyMessage(interaction, game.row.id, game.state);
  await replyStatus(interaction, "参加を取り消しました。");
  return true;
}

async function handleStart(interaction: ButtonInteraction, ctx: WerewolfDeps, game: LoadedWerewolfGame): Promise<boolean> {
  if (!validatePublicInteraction(interaction, game.state, "lobby")) return replyRejected(interaction);
  const member = interaction.member && "roles" in interaction.member ? (interaction.member as GuildMember) : null;
  if (interaction.user.id !== game.state.hostId && (!member || !isAdmin(member, ctx.config))) {
    await replyError(interaction, "開始できるのはホストまたは管理者だけです。");
    return true;
  }
  const allowSmallGame = ctx.config.BOT_PROFILE === "debug";
  if (!allowSmallGame && game.state.participants.length < 5) {
    await replyError(interaction, "人狼は5人以上で開始できます。");
    return true;
  }
  if (game.state.participants.length > 25) {
    await replyError(interaction, "初回実装では25人まで開始できます。");
    return true;
  }
  const channel = await fetchTextChannel(ctx, game.row.channel_id);
  if (!channel || !hasWerewolfPermissions(interaction.guild?.members.me ?? null, channel)) {
    await markWerewolfEnded(ctx.db, game.row.id, { ...game.state, phase: "ended" });
    await deleteLobbyMessage(ctx, game.state);
    await replyError(interaction, "BOTに必要なスレッド権限がないため、人狼セッションを中止しました。");
    await channel?.send({ ...componentCardsPayload([errorCard("BOTに必要なスレッド権限がないため、人狼セッションを中止しました。")]) }).catch(() => undefined);
    return true;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const state = game.state;
  state.players = assignRoles(state.participants, Math.random, { allowSmallGame });
  state.rolePrivateThreadIds = {};
  state.roleThreadMembersByRole = {};
  state.phase = "night";
  state.dayNumber = 1;
  state.votes = {};
  state.nightActions = { attack: {}, inspect: {}, guard: {} };
  state.deadlineAt = new Date(Date.now() + NIGHT_MS).toISOString();

  try {
    await createRoleThreads(ctx, channel, game.row.id, state);
  } catch (err) {
    ctx.log.error({ err, sessionId: game.row.id }, "werewolf: role thread creation failed");
    await markWerewolfEnded(ctx.db, game.row.id, { ...state, phase: "ended" });
    await deleteLobbyMessage(ctx, state);
    await channel.send({ ...componentCardsPayload([errorCard("役職スレッドの作成に失敗したため、人狼セッションを中止しました。")]) }).catch(() => undefined);
    await interaction.editReply({ ...componentCardsPayload([errorCard("役職スレッドの作成に失敗しました。")]) });
    return true;
  }

  await saveWerewolfState(ctx.db, game.row.id, state);
  await deleteLobbyMessage(ctx, state);
  await channel.send({
    ...componentCardsPayload([
      werewolfCard(
        "人狼ゲーム開始",
        [
          `参加者: ${formatMentions(state.players.map((p) => p.userId))}`,
          "夜フェーズを開始します。夜行動は各役職専用プライベートスレッドで行ってください。",
        ].join("\n"),
      ),
    ]),
    allowedMentions: { parse: [] },
  });
  await postNightUis(ctx, game.row.id, state);
  scheduleDeadline(ctx, game.row.id, state);
  await interaction.editReply({ ...componentCardsPayload([statusCard("ゲームを開始しました。")]) });
  return true;
}

async function handleCancel(interaction: ButtonInteraction, ctx: WerewolfDeps, game: LoadedWerewolfGame): Promise<boolean> {
  if (!validatePublicInteraction(interaction, game.state, "lobby")) return replyRejected(interaction);
  const member = interaction.member && "roles" in interaction.member ? (interaction.member as GuildMember) : null;
  if (interaction.user.id !== game.state.hostId && (!member || !isAdmin(member, ctx.config))) {
    await replyError(interaction, "中止できるのはホストまたは管理者だけです。");
    return true;
  }
  await finishGame(ctx, game.row.id, game.state, "募集を中止しました。", undefined);
  await replyStatus(interaction, "募集を中止しました。");
  return true;
}

async function handleVote(
  interaction: StringSelectMenuInteraction,
  ctx: WerewolfDeps,
  game: LoadedWerewolfGame,
  targetUserId: string,
): Promise<boolean> {
  if (!validatePublicInteraction(interaction, game.state, "voting")) return replyRejected(interaction);
  const voter = game.state.players.find((p) => p.userId === interaction.user.id);
  const target = game.state.players.find((p) => p.userId === targetUserId);
  if (!voter?.alive || !target?.alive) return replyRejected(interaction);
  game.state.votes[interaction.user.id] = targetUserId;
  await saveWerewolfState(ctx.db, game.row.id, game.state);
  await replyStatus(interaction, "投票を受け付けました。");
  if (alivePlayers(game.state).every((p) => game.state.votes[p.userId])) {
    await finalizeVoting(ctx, game.row.id);
  }
  return true;
}

async function handleNightAction(
  interaction: StringSelectMenuInteraction,
  ctx: WerewolfDeps,
  game: LoadedWerewolfGame,
  role: WerewolfThreadRole | null,
  targetUserId: string,
): Promise<boolean> {
  if (!role) return replyRejected(interaction);
  if (!canUseRoleThreadAction({
    state: game.state,
    userId: interaction.user.id,
    role,
    channelId: interaction.channelId,
    phase: "night",
    targetUserId,
  })) {
    return replyRejected(interaction);
  }
  if (role === "werewolf") game.state.nightActions.attack[interaction.user.id] = targetUserId;
  if (role === "seer") game.state.nightActions.inspect[interaction.user.id] = targetUserId;
  if (role === "knight") game.state.nightActions.guard[interaction.user.id] = targetUserId;
  await saveWerewolfState(ctx.db, game.row.id, game.state);
  await replyStatus(interaction, "夜行動を受け付けました。");

  if (role === "seer") {
    const target = game.state.players.find((p) => p.userId === targetUserId);
    await (interaction.channel as ThreadChannel | null)?.send({
      ...componentCardsPayload([
        werewolfCard(
          "占い結果",
          `<@${interaction.user.id}> の占い結果: <@${targetUserId}> は ${target?.role === "werewolf" ? "人狼" : "人狼ではありません"}。`,
        ),
      ]),
      allowedMentions: { parse: [] },
    }).catch(() => undefined);
  }
  if (allNightActionsSubmitted(game.state)) {
    await finalizeNight(ctx, game.row.id);
  }
  return true;
}
