import { componentCardsPayload } from "../../core/componentCard.js";
import {
  ActionRowBuilder,
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type GuildMember,
  type StringSelectMenuInteraction,
  type TextChannel,
  type ThreadChannel,
} from "discord.js";
import { randomUUID } from "node:crypto";
import type { BotContext } from "../../bot/context.js";
import { isAdmin } from "../../core/permission.js";
import {
  ROLE_LABELS,
  ROLE_THREAD_LABELS,
  THREAD_ROLES,
  assignRoles,
  canUseRoleThreadAction,
  checkWinner,
  createInitialWerewolfState,
  resolveMajorityRandom,
  resolveVotes,
  type WerewolfPhase,
  type WerewolfPlayer,
  type WerewolfRole,
  type WerewolfState,
  type WerewolfThreadRole,
  type WerewolfWinner,
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
  buildDawnMessage,
  buildLobbyRows,
  buildRoleThreadIntro,
  buildVoteResultMessage,
  errorCard,
  formatMentions,
  lobbyCard,
  nightPlaceholder,
  nightPrompt,
  parseWerewolfButtonId,
  parseWerewolfSelectId,
  statusCard,
  truncateSelectLabel,
  werewolfCard,
} from "./werewolfUi.js";

const NIGHT_MS = 2 * 60_000;
const DAY_MS = 5 * 60_000;
const VOTE_MS = 2 * 60_000;
const REQUIRED_PERMISSIONS = [
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.CreatePrivateThreads,
  PermissionFlagsBits.SendMessagesInThreads,
  PermissionFlagsBits.ManageThreads,
];

const timers = new Map<string, NodeJS.Timeout>();

function replyError(
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

function replyStatus(interaction: ButtonInteraction | StringSelectMenuInteraction, message: string) {
  return interaction.reply({
    ...componentCardsPayload([statusCard(message)]),
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
  });
}

export async function handleWerewolfCreate(
  interaction: ChatInputCommandInteraction,
  ctx: BotContext,
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
  ctx: BotContext,
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

export async function handleWerewolfButton(interaction: ButtonInteraction, ctx: BotContext): Promise<boolean> {
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
  ctx: BotContext,
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

export async function reconcileWerewolfGames(ctx: BotContext): Promise<void> {
  for (const { row, state } of await listActiveWerewolfGames(ctx.db)) {
    if (!state.deadlineAt) continue;
    scheduleDeadline(ctx, row.id, state);
  }
}

async function handleJoin(interaction: ButtonInteraction, ctx: BotContext, game: LoadedWerewolfGame): Promise<boolean> {
  if (!validatePublicInteraction(interaction, game.state, "lobby")) return replyRejected(interaction);
  if (!game.state.participants.includes(interaction.user.id)) {
    game.state.participants.push(interaction.user.id);
    await saveWerewolfState(ctx.db, game.row.id, game.state);
  }
  await updateLobbyMessage(interaction, game.row.id, game.state);
  await replyStatus(interaction, "参加しました。");
  return true;
}

async function handleLeave(interaction: ButtonInteraction, ctx: BotContext, game: LoadedWerewolfGame): Promise<boolean> {
  if (!validatePublicInteraction(interaction, game.state, "lobby")) return replyRejected(interaction);
  game.state.participants = game.state.participants.filter((id) => id !== interaction.user.id);
  await saveWerewolfState(ctx.db, game.row.id, game.state);
  await updateLobbyMessage(interaction, game.row.id, game.state);
  await replyStatus(interaction, "参加を取り消しました。");
  return true;
}

async function handleStart(interaction: ButtonInteraction, ctx: BotContext, game: LoadedWerewolfGame): Promise<boolean> {
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

async function handleCancel(interaction: ButtonInteraction, ctx: BotContext, game: LoadedWerewolfGame): Promise<boolean> {
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
  ctx: BotContext,
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
  ctx: BotContext,
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

async function createRoleThreads(
  ctx: BotContext,
  channel: TextChannel,
  sessionId: string,
  state: WerewolfState,
): Promise<void> {
  await channel.send({ ...componentCardsPayload([werewolfCard("役職スレッド作成", "役職専用プライベートスレッドを作成します。")]), allowedMentions: { parse: [] } });
  for (const role of THREAD_ROLES) {
    const members = state.players.filter((p) => p.role === role).map((p) => p.userId);
    if (members.length === 0) continue;
    const thread = await channel.threads.create({
      name: `人狼-${ROLE_THREAD_LABELS[role]}-${sessionId.slice(0, 8)}`,
      type: ChannelType.PrivateThread,
      autoArchiveDuration: 1440,
      invitable: false,
      reason: "werewolf role private thread",
    });
    for (const userId of members) {
      await thread.members.add(userId).catch((err) => {
        ctx.log.warn({ err, sessionId, role, userId }, "werewolf: add thread member failed");
      });
    }
    state.rolePrivateThreadIds[role] = thread.id;
    state.roleThreadMembersByRole[role] = members;
    await thread.send({
      ...componentCardsPayload([werewolfCard(`${ROLE_THREAD_LABELS[role]}スレッド`, buildRoleThreadIntro(role, members))]),
      allowedMentions: { users: members },
    });
  }
}

async function postNightUis(ctx: BotContext, sessionId: string, state: WerewolfState): Promise<void> {
  for (const role of THREAD_ROLES) {
    const threadId = state.rolePrivateThreadIds[role];
    if (!threadId) continue;
    const thread = await fetchThread(ctx, threadId);
    if (!thread) continue;
    const options = await buildPlayerSelectOptions(ctx, state.werewolfChannelId, alivePlayers(state));
    if (options.length === 0) continue;
    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`${WEREWOLF_SELECT_PREFIX}night:${role}:${sessionId}`)
        .setPlaceholder(nightPlaceholder(role))
        .addOptions(options.slice(0, 25)),
    );
    await thread.send({
      ...componentCardsPayload([werewolfCard(`夜フェーズ ${state.dayNumber}日目`, nightPrompt(role))], [row]),
      allowedMentions: { parse: [] },
    }).catch((err) => ctx.log.warn({ err, sessionId, role }, "werewolf: post night UI failed"));
  }
}

async function finalizeNight(ctx: BotContext, sessionId: string): Promise<void> {
  const game = await findWerewolfGameById(ctx.db, sessionId);
  if (!game || game.state.phase !== "night") return;
  const state = game.state;
  clearDeadline(sessionId);
  const aliveIds = alivePlayers(state).map((p) => p.userId);
  const attackTarget = resolveMajorityRandom(state.nightActions.attack, aliveIds);
  const guarded = new Set(Object.values(state.nightActions.guard).filter((id) => aliveIds.includes(id)));
  const deaths: string[] = [];
  if (attackTarget && !guarded.has(attackTarget)) {
    const target = state.players.find((p) => p.userId === attackTarget);
    if (target?.alive) {
      target.alive = false;
      deaths.push(attackTarget);
      state.deadUserIds.push(attackTarget);
    }
  }
  const winner = checkWinner(state.players);
  if (winner) {
    await finishGame(ctx, sessionId, { ...state, winner }, buildDawnMessage(deaths), winner);
    return;
  }
  state.phase = "day_discussion";
  state.deadlineAt = new Date(Date.now() + DAY_MS).toISOString();
  await saveWerewolfState(ctx.db, sessionId, state);
  const channel = await fetchTextChannel(ctx, state.werewolfChannelId);
  await channel?.send({
    ...componentCardsPayload([werewolfCard("夜明け", `${buildDawnMessage(deaths)}\n昼議論を開始します。5分後に投票へ移ります。`)]),
    allowedMentions: { parse: [] },
  }).catch(() => undefined);
  scheduleDeadline(ctx, sessionId, state);
}

async function startVoting(ctx: BotContext, sessionId: string): Promise<void> {
  const game = await findWerewolfGameById(ctx.db, sessionId);
  if (!game || game.state.phase !== "day_discussion") return;
  const state = game.state;
  clearDeadline(sessionId);
  state.phase = "voting";
  state.votes = {};
  state.deadlineAt = new Date(Date.now() + VOTE_MS).toISOString();
  await saveWerewolfState(ctx.db, sessionId, state);
  const options = await buildPlayerSelectOptions(ctx, state.werewolfChannelId, alivePlayers(state));
  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`${WEREWOLF_SELECT_PREFIX}vote:${sessionId}`)
      .setPlaceholder("処刑投票の対象を選択")
      .addOptions(options.slice(0, 25)),
  );
  const channel = await fetchTextChannel(ctx, state.werewolfChannelId);
  await channel?.send({
    ...componentCardsPayload([werewolfCard("投票開始", "2分以内に処刑対象を選択してください。")], [row]),
    allowedMentions: { parse: [] },
  }).catch(() => undefined);
  scheduleDeadline(ctx, sessionId, state);
}

async function finalizeVoting(ctx: BotContext, sessionId: string): Promise<void> {
  const game = await findWerewolfGameById(ctx.db, sessionId);
  if (!game || game.state.phase !== "voting") return;
  clearDeadline(sessionId);
  const state = game.state;
  const aliveIds = alivePlayers(state).map((p) => p.userId);
  const executed = resolveVotes(state.votes, aliveIds);
  if (executed) {
    const target = state.players.find((p) => p.userId === executed);
    if (target) {
      target.alive = false;
      state.deadUserIds.push(executed);
    }
  }
  const winner = checkWinner(state.players);
  if (winner) {
    await finishGame(ctx, sessionId, { ...state, winner }, buildVoteResultMessage(executed), winner);
    return;
  }
  state.phase = "night";
  state.dayNumber += 1;
  state.votes = {};
  state.nightActions = { attack: {}, inspect: {}, guard: {} };
  state.deadlineAt = new Date(Date.now() + NIGHT_MS).toISOString();
  await saveWerewolfState(ctx.db, sessionId, state);
  const channel = await fetchTextChannel(ctx, state.werewolfChannelId);
  await channel?.send({
    ...componentCardsPayload([werewolfCard("投票結果", `${buildVoteResultMessage(executed)}\n夜フェーズを開始します。`)]),
    allowedMentions: { parse: [] },
  }).catch(() => undefined);
  await postNightUis(ctx, sessionId, state);
  scheduleDeadline(ctx, sessionId, state);
}

async function finishGame(
  ctx: BotContext,
  sessionId: string,
  state: WerewolfState,
  publicMessage: string,
  winner: WerewolfWinner | undefined,
): Promise<void> {
  clearDeadline(sessionId);
  state.phase = "ended";
  state.deadlineAt = null;
  if (winner) state.winner = winner;
  await markWerewolfEnded(ctx.db, sessionId, state);
  await deleteLobbyMessage(ctx, state);
  const channel = await fetchTextChannel(ctx, state.werewolfChannelId);
  const lines = [publicMessage];
  if (winner) lines.push(`勝敗: ${winner === "villagers" ? "村人陣営の勝利" : "人狼陣営の勝利"}`);
  if (state.players.length > 0) {
    lines.push("最終役職一覧:");
    for (const player of state.players) {
      lines.push(`- <@${player.userId}>: ${ROLE_LABELS[player.role]}${player.alive ? "" : "（死亡）"}`);
    }
  }
  await channel?.send({ ...componentCardsPayload([werewolfCard("人狼ゲーム終了", lines.join("\n"))]), allowedMentions: { parse: [] } }).catch(() => undefined);
  await archiveRoleThreads(ctx, state);
}

async function archiveRoleThreads(ctx: BotContext, state: WerewolfState): Promise<void> {
  for (const threadId of Object.values(state.rolePrivateThreadIds)) {
    if (!threadId) continue;
    const thread = await fetchThread(ctx, threadId);
    if (!thread) continue;
    await thread.setArchived(true, "werewolf game ended").catch((err) => {
      ctx.log.warn({ err, threadId }, "werewolf: archive role thread failed");
    });
  }
}

function scheduleDeadline(ctx: BotContext, sessionId: string, state: WerewolfState): void {
  clearDeadline(sessionId);
  if (!state.deadlineAt || state.phase === "lobby" || state.phase === "ended") return;
  const delayMs = Math.max(0, Date.parse(state.deadlineAt) - Date.now());
  const timer = setTimeout(() => {
    const task = state.phase === "night"
      ? finalizeNight(ctx, sessionId)
      : state.phase === "day_discussion"
        ? startVoting(ctx, sessionId)
        : state.phase === "voting"
          ? finalizeVoting(ctx, sessionId)
          : Promise.resolve();
    void task.catch((err) => ctx.log.error({ err, sessionId, phase: state.phase }, "werewolf: deadline task failed"));
  }, delayMs);
  timers.set(sessionId, timer);
}

function clearDeadline(sessionId: string): void {
  const timer = timers.get(sessionId);
  if (timer) clearTimeout(timer);
  timers.delete(sessionId);
}

function validatePublicInteraction(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  state: WerewolfState,
  phase: WerewolfPhase,
): boolean {
  return state.phase === phase && interaction.channelId === state.werewolfChannelId;
}

async function replyRejected(interaction: ButtonInteraction | StringSelectMenuInteraction): Promise<boolean> {
  await replyError(interaction, "この操作は現在の状態では実行できません。");
  return true;
}

async function updateLobbyMessage(
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

async function deleteLobbyMessage(ctx: BotContext, state: WerewolfState): Promise<void> {
  if (!state.lobbyMessageId) return;
  const channel = await fetchTextChannel(ctx, state.werewolfChannelId);
  const message = await channel?.messages.fetch(state.lobbyMessageId).catch(() => null);
  await message?.delete().catch((err) => {
    ctx.log.warn({ err, lobbyMessageId: state.lobbyMessageId }, "werewolf: delete lobby message failed");
  });
}

function allNightActionsSubmitted(state: WerewolfState): boolean {
  const alive = alivePlayers(state);
  const aliveByRole = (role: WerewolfRole) => alive.filter((p) => p.role === role);
  return aliveByRole("werewolf").every((p) => state.nightActions.attack[p.userId])
    && aliveByRole("seer").every((p) => state.nightActions.inspect[p.userId])
    && aliveByRole("knight").every((p) => state.nightActions.guard[p.userId]);
}

function alivePlayers(state: WerewolfState): WerewolfPlayer[] {
  return state.players.filter((p) => p.alive);
}

async function buildPlayerSelectOptions(
  ctx: BotContext,
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

async function fetchTextChannel(ctx: BotContext, channelId: string): Promise<TextChannel | null> {
  const channel = await ctx.client.channels.fetch(channelId).catch(() => null);
  if (!channel || channel.isDMBased() || !channel.isTextBased() || channel.isThread()) return null;
  return channel as TextChannel;
}

async function fetchThread(ctx: BotContext, threadId: string): Promise<ThreadChannel | null> {
  const channel = await ctx.client.channels.fetch(threadId).catch(() => null);
  return channel?.isThread() ? channel : null;
}

function hasWerewolfPermissions(member: GuildMember | null, channel: TextChannel): boolean {
  if (!member) return false;
  const perms = member.permissionsIn(channel);
  return REQUIRED_PERMISSIONS.every((p) => perms.has(p));
}
