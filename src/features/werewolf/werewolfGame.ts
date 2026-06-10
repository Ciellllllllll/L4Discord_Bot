import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
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
import { sqliteTimestamp } from "../../core/db/sqliteTimestamp.js";
import { isAdmin } from "../../core/permission.js";
import {
  ROLE_LABELS,
  ROLE_THREAD_LABELS,
  THREAD_ROLES,
  assignRoles,
  canUseRoleThreadAction,
  checkWinner,
  createInitialWerewolfState,
  parseWerewolfState,
  resolveMajorityRandom,
  resolveVotes,
  type WerewolfPhase,
  type WerewolfPlayer,
  type WerewolfRole,
  type WerewolfState,
  type WerewolfThreadRole,
  type WerewolfWinner,
} from "./werewolfState.js";

const BUTTON_PREFIX = "ww:";
const SELECT_PREFIX = "wws:";
const NIGHT_MS = 2 * 60_000;
const DAY_MS = 5 * 60_000;
const VOTE_MS = 2 * 60_000;
const REQUIRED_PERMISSIONS = [
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.CreatePrivateThreads,
  PermissionFlagsBits.SendMessagesInThreads,
  PermissionFlagsBits.ManageThreads,
];

type WerewolfGameRow = {
  id: string;
  guild_id: string;
  channel_id: string;
  host_id: string;
  phase: string;
  state: unknown;
};

type LoadedGame = {
  row: WerewolfGameRow;
  state: WerewolfState;
};

const timers = new Map<string, NodeJS.Timeout>();

export async function handleWerewolfCreate(
  interaction: ChatInputCommandInteraction,
  ctx: BotContext,
  member: GuildMember | null,
): Promise<void> {
  if (!member || !isAdmin(member, ctx.config)) {
    await interaction.reply({ embeds: [errorEmbed("権限がありません。")], flags: MessageFlags.Ephemeral });
    return;
  }
  const channel = interaction.channel;
  if (!channel || channel.isDMBased() || !channel.isTextBased() || channel.isThread()) {
    await interaction.reply({ embeds: [errorEmbed("人狼チャンネルで実行してください。")], flags: MessageFlags.Ephemeral });
    return;
  }
  if (ctx.config.BOT_PROFILE === "production") {
    const allowedChannelId = ctx.config.WEREWOLF_CHANNEL_ID?.trim();
    if (!allowedChannelId) {
      await interaction.reply({
        embeds: [errorEmbed("production では WEREWOLF_CHANNEL_ID を設定してください。")],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (interaction.channelId !== allowedChannelId) {
      await interaction.reply({
        embeds: [errorEmbed(`このコマンドは <#${allowedChannelId}> でのみ使用できます。`)],
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }
  }
  if (!hasWerewolfPermissions(member.guild.members.me, channel as TextChannel)) {
    await interaction.reply({
      embeds: [errorEmbed("BOTにプライベートスレッド作成・スレッド送信・スレッド管理権限が必要です。")],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const existing = await findOpenGameForChannel(ctx, interaction.guildId!, interaction.channelId);
  if (existing) {
    await interaction.reply({ embeds: [errorEmbed("このチャンネルには進行中の人狼セッションがあります。")], flags: MessageFlags.Ephemeral });
    return;
  }

  const id = randomUUID();
  const state = createInitialWerewolfState({ channelId: interaction.channelId, hostId: interaction.user.id });
  await ctx.db
    .insertInto("werewolf_games")
    .values({
      id,
      guild_id: interaction.guildId!,
      channel_id: interaction.channelId,
      host_id: interaction.user.id,
      phase: state.phase,
      state: JSON.stringify(state) as unknown as Record<string, unknown>,
      created_at: sqliteTimestamp() as unknown as Date,
      updated_at: sqliteTimestamp() as unknown as Date,
    })
    .execute();

  await interaction.reply({
    embeds: [lobbyEmbed(state, false)],
    components: buildLobbyRows(id, false),
    allowedMentions: { parse: [] },
  });
  const message = await interaction.fetchReply();
  state.lobbyMessageId = message.id;
  await saveState(ctx, id, state);
}

export async function handleWerewolfEnd(
  interaction: ChatInputCommandInteraction,
  ctx: BotContext,
  member: GuildMember | null,
): Promise<void> {
  if (!member || !isAdmin(member, ctx.config)) {
    await interaction.reply({ embeds: [errorEmbed("権限がありません。")], flags: MessageFlags.Ephemeral });
    return;
  }
  const game = await findOpenGameForChannel(ctx, interaction.guildId!, interaction.channelId);
  if (!game) {
    await interaction.reply({ embeds: [errorEmbed("終了対象のゲームがありません。")], flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await finishGame(ctx, game.row.id, game.state, "管理者がゲームを終了しました。", undefined);
  await interaction.editReply({ embeds: [statusEmbed("このチャンネルの人狼セッションを終了しました。")] });
}

export async function handleWerewolfButton(interaction: ButtonInteraction, ctx: BotContext): Promise<boolean> {
  if (!interaction.customId.startsWith(BUTTON_PREFIX)) return false;
  const parsed = parseButtonId(interaction.customId);
  if (!parsed) {
    await interaction.reply({ embeds: [errorEmbed("無効な操作です。")], flags: MessageFlags.Ephemeral });
    return true;
  }
  const game = await findGameById(ctx, parsed.sessionId);
  if (!game || game.row.guild_id !== interaction.guildId) {
    await interaction.reply({ embeds: [errorEmbed("このボタンは期限切れです。")], flags: MessageFlags.Ephemeral });
    return true;
  }
  if (parsed.action === "join") return handleJoin(interaction, ctx, game);
  if (parsed.action === "leave") return handleLeave(interaction, ctx, game);
  if (parsed.action === "start") return handleStart(interaction, ctx, game);
  if (parsed.action === "cancel") return handleCancel(interaction, ctx, game);
  await interaction.reply({ embeds: [errorEmbed("無効な操作です。")], flags: MessageFlags.Ephemeral });
  return true;
}

export async function handleWerewolfStringSelect(
  interaction: StringSelectMenuInteraction,
  ctx: BotContext,
): Promise<boolean> {
  if (!interaction.customId.startsWith(SELECT_PREFIX)) return false;
  const parsed = parseSelectId(interaction.customId);
  if (!parsed) {
    await interaction.reply({ embeds: [errorEmbed("無効な操作です。")], flags: MessageFlags.Ephemeral });
    return true;
  }
  const game = await findGameById(ctx, parsed.sessionId);
  const targetUserId = interaction.values[0];
  if (!game || game.row.guild_id !== interaction.guildId || !targetUserId) {
    await interaction.reply({ embeds: [errorEmbed("この操作は期限切れです。")], flags: MessageFlags.Ephemeral });
    return true;
  }
  if (parsed.action === "vote") return handleVote(interaction, ctx, game, targetUserId);
  if (parsed.action === "night") return handleNightAction(interaction, ctx, game, parsed.role, targetUserId);
  await interaction.reply({ embeds: [errorEmbed("無効な操作です。")], flags: MessageFlags.Ephemeral });
  return true;
}

export async function reconcileWerewolfGames(ctx: BotContext): Promise<void> {
  const rows = await ctx.db
    .selectFrom("werewolf_games")
    .select(["id", "guild_id", "channel_id", "host_id", "phase", "state"])
    .where("phase", "!=", "ended")
    .execute();
  for (const row of rows) {
    const state = parseWerewolfState(row.state);
    if (!state || !state.deadlineAt) continue;
    scheduleDeadline(ctx, row.id, state);
  }
}

async function handleJoin(interaction: ButtonInteraction, ctx: BotContext, game: LoadedGame): Promise<boolean> {
  if (!validatePublicInteraction(interaction, game.state, "lobby")) return replyRejected(interaction);
  if (!game.state.participants.includes(interaction.user.id)) {
    game.state.participants.push(interaction.user.id);
    await saveState(ctx, game.row.id, game.state);
  }
  await updateLobbyMessage(interaction, game.row.id, game.state);
  await interaction.reply({ embeds: [statusEmbed("参加しました。")], flags: MessageFlags.Ephemeral });
  return true;
}

async function handleLeave(interaction: ButtonInteraction, ctx: BotContext, game: LoadedGame): Promise<boolean> {
  if (!validatePublicInteraction(interaction, game.state, "lobby")) return replyRejected(interaction);
  game.state.participants = game.state.participants.filter((id) => id !== interaction.user.id);
  await saveState(ctx, game.row.id, game.state);
  await updateLobbyMessage(interaction, game.row.id, game.state);
  await interaction.reply({ embeds: [statusEmbed("参加を取り消しました。")], flags: MessageFlags.Ephemeral });
  return true;
}

async function handleStart(interaction: ButtonInteraction, ctx: BotContext, game: LoadedGame): Promise<boolean> {
  if (!validatePublicInteraction(interaction, game.state, "lobby")) return replyRejected(interaction);
  const member = interaction.member && "roles" in interaction.member ? (interaction.member as GuildMember) : null;
  if (interaction.user.id !== game.state.hostId && (!member || !isAdmin(member, ctx.config))) {
    await interaction.reply({ embeds: [errorEmbed("開始できるのはホストまたは管理者だけです。")], flags: MessageFlags.Ephemeral });
    return true;
  }
  const allowSmallGame = ctx.config.BOT_PROFILE === "debug";
  if (!allowSmallGame && game.state.participants.length < 5) {
    await interaction.reply({ embeds: [errorEmbed("人狼は5人以上で開始できます。")], flags: MessageFlags.Ephemeral });
    return true;
  }
  if (game.state.participants.length > 25) {
    await interaction.reply({ embeds: [errorEmbed("初回実装では25人まで開始できます。")], flags: MessageFlags.Ephemeral });
    return true;
  }
  const channel = await fetchTextChannel(ctx, game.row.channel_id);
  if (!channel || !hasWerewolfPermissions(interaction.guild?.members.me ?? null, channel)) {
    await markEnded(ctx, game.row.id, { ...game.state, phase: "ended" });
    await deleteLobbyMessage(ctx, game.state);
    await interaction.reply({
      embeds: [errorEmbed("BOTに必要なスレッド権限がないため、人狼セッションを中止しました。")],
      flags: MessageFlags.Ephemeral,
    });
    await channel?.send({ embeds: [errorEmbed("BOTに必要なスレッド権限がないため、人狼セッションを中止しました。")] }).catch(() => undefined);
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
    await markEnded(ctx, game.row.id, { ...state, phase: "ended" });
    await deleteLobbyMessage(ctx, state);
    await channel.send({ embeds: [errorEmbed("役職スレッドの作成に失敗したため、人狼セッションを中止しました。")] }).catch(() => undefined);
    await interaction.editReply({ embeds: [errorEmbed("役職スレッドの作成に失敗しました。")] });
    return true;
  }

  await saveState(ctx, game.row.id, state);
  await deleteLobbyMessage(ctx, state);
  await channel.send({
    embeds: [werewolfEmbed(
      "人狼ゲーム開始",
      [
        `参加者: ${formatMentions(state.players.map((p) => p.userId))}`,
        "夜フェーズを開始します。夜行動は各役職専用プライベートスレッドで行ってください。",
      ].join("\n"),
    )],
    allowedMentions: { parse: [] },
  });
  await postNightUis(ctx, game.row.id, state);
  scheduleDeadline(ctx, game.row.id, state);
  await interaction.editReply({ embeds: [statusEmbed("ゲームを開始しました。")] });
  return true;
}

async function handleCancel(interaction: ButtonInteraction, ctx: BotContext, game: LoadedGame): Promise<boolean> {
  if (!validatePublicInteraction(interaction, game.state, "lobby")) return replyRejected(interaction);
  const member = interaction.member && "roles" in interaction.member ? (interaction.member as GuildMember) : null;
  if (interaction.user.id !== game.state.hostId && (!member || !isAdmin(member, ctx.config))) {
    await interaction.reply({ embeds: [errorEmbed("中止できるのはホストまたは管理者だけです。")], flags: MessageFlags.Ephemeral });
    return true;
  }
  await finishGame(ctx, game.row.id, game.state, "募集を中止しました。", undefined);
  await interaction.reply({ embeds: [statusEmbed("募集を中止しました。")], flags: MessageFlags.Ephemeral });
  return true;
}

async function handleVote(
  interaction: StringSelectMenuInteraction,
  ctx: BotContext,
  game: LoadedGame,
  targetUserId: string,
): Promise<boolean> {
  if (!validatePublicInteraction(interaction, game.state, "voting")) return replyRejected(interaction);
  const voter = game.state.players.find((p) => p.userId === interaction.user.id);
  const target = game.state.players.find((p) => p.userId === targetUserId);
  if (!voter?.alive || !target?.alive) return replyRejected(interaction);
  game.state.votes[interaction.user.id] = targetUserId;
  await saveState(ctx, game.row.id, game.state);
  await interaction.reply({ embeds: [statusEmbed("投票を受け付けました。")], flags: MessageFlags.Ephemeral });
  if (alivePlayers(game.state).every((p) => game.state.votes[p.userId])) {
    await finalizeVoting(ctx, game.row.id);
  }
  return true;
}

async function handleNightAction(
  interaction: StringSelectMenuInteraction,
  ctx: BotContext,
  game: LoadedGame,
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
  await saveState(ctx, game.row.id, game.state);
  await interaction.reply({ embeds: [statusEmbed("夜行動を受け付けました。")], flags: MessageFlags.Ephemeral });

  if (role === "seer") {
    const target = game.state.players.find((p) => p.userId === targetUserId);
    await (interaction.channel as ThreadChannel | null)?.send({
      embeds: [werewolfEmbed(
        "占い結果",
        `<@${interaction.user.id}> の占い結果: <@${targetUserId}> は ${target?.role === "werewolf" ? "人狼" : "人狼ではありません"}。`,
      )],
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
  await channel.send({ embeds: [werewolfEmbed("役職スレッド作成", "役職専用プライベートスレッドを作成します。")], allowedMentions: { parse: [] } });
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
      embeds: [werewolfEmbed(`${ROLE_THREAD_LABELS[role]}スレッド`, buildRoleThreadIntro(role, members))],
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
    const alive = alivePlayers(state);
    const options = await buildPlayerSelectOptions(ctx, state.werewolfChannelId, alive);
    if (options.length === 0) continue;
    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`${SELECT_PREFIX}night:${role}:${sessionId}`)
        .setPlaceholder(nightPlaceholder(role))
        .addOptions(options.slice(0, 25)),
    );
    await thread.send({
      embeds: [werewolfEmbed(`夜フェーズ ${state.dayNumber}日目`, nightPrompt(role))],
      components: [row],
      allowedMentions: { parse: [] },
    }).catch((err) => ctx.log.warn({ err, sessionId, role }, "werewolf: post night UI failed"));
  }
}

async function finalizeNight(ctx: BotContext, sessionId: string): Promise<void> {
  const game = await findGameById(ctx, sessionId);
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
  await saveState(ctx, sessionId, state);
  const channel = await fetchTextChannel(ctx, state.werewolfChannelId);
  await channel?.send({
    embeds: [werewolfEmbed("夜明け", `${buildDawnMessage(deaths)}\n昼議論を開始します。5分後に投票へ移ります。`)],
    allowedMentions: { parse: [] },
  }).catch(() => undefined);
  scheduleDeadline(ctx, sessionId, state);
}

async function startVoting(ctx: BotContext, sessionId: string): Promise<void> {
  const game = await findGameById(ctx, sessionId);
  if (!game || game.state.phase !== "day_discussion") return;
  const state = game.state;
  clearDeadline(sessionId);
  state.phase = "voting";
  state.votes = {};
  state.deadlineAt = new Date(Date.now() + VOTE_MS).toISOString();
  await saveState(ctx, sessionId, state);
  const alive = alivePlayers(state);
  const options = await buildPlayerSelectOptions(ctx, state.werewolfChannelId, alive);
  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`${SELECT_PREFIX}vote:${sessionId}`)
      .setPlaceholder("処刑投票の対象を選択")
      .addOptions(options.slice(0, 25)),
  );
  const channel = await fetchTextChannel(ctx, state.werewolfChannelId);
  await channel?.send({
    embeds: [werewolfEmbed("投票開始", "2分以内に処刑対象を選択してください。")],
    components: [row],
    allowedMentions: { parse: [] },
  }).catch(() => undefined);
  scheduleDeadline(ctx, sessionId, state);
}

async function finalizeVoting(ctx: BotContext, sessionId: string): Promise<void> {
  const game = await findGameById(ctx, sessionId);
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
  await saveState(ctx, sessionId, state);
  const channel = await fetchTextChannel(ctx, state.werewolfChannelId);
  await channel?.send({
    embeds: [werewolfEmbed("投票結果", `${buildVoteResultMessage(executed)}\n夜フェーズを開始します。`)],
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
  await markEnded(ctx, sessionId, state);
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
  await channel?.send({ embeds: [werewolfEmbed("人狼ゲーム終了", lines.join("\n"))], allowedMentions: { parse: [] } }).catch(() => undefined);
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
  const delay = Math.max(0, Date.parse(state.deadlineAt) - Date.now());
  const timer = setTimeout(() => {
    const task = state.phase === "night"
      ? finalizeNight(ctx, sessionId)
      : state.phase === "day_discussion"
        ? startVoting(ctx, sessionId)
        : state.phase === "voting"
          ? finalizeVoting(ctx, sessionId)
          : Promise.resolve();
    void task.catch((err) => ctx.log.error({ err, sessionId, phase: state.phase }, "werewolf: deadline task failed"));
  }, delay);
  timers.set(sessionId, timer);
}

function clearDeadline(sessionId: string): void {
  const timer = timers.get(sessionId);
  if (timer) clearTimeout(timer);
  timers.delete(sessionId);
}

async function findOpenGameForChannel(ctx: BotContext, guildId: string, channelId: string): Promise<LoadedGame | null> {
  const row = await ctx.db
    .selectFrom("werewolf_games")
    .select(["id", "guild_id", "channel_id", "host_id", "phase", "state"])
    .where("guild_id", "=", guildId)
    .where("channel_id", "=", channelId)
    .where("phase", "!=", "ended")
    .executeTakeFirst();
  return normalizeLoadedRow(row);
}

async function findGameById(ctx: BotContext, sessionId: string): Promise<LoadedGame | null> {
  const row = await ctx.db
    .selectFrom("werewolf_games")
    .select(["id", "guild_id", "channel_id", "host_id", "phase", "state"])
    .where("id", "=", sessionId)
    .executeTakeFirst();
  return normalizeLoadedRow(row);
}

function normalizeLoadedRow(row: WerewolfGameRow | undefined): LoadedGame | null {
  if (!row) return null;
  const state = parseWerewolfState(row.state);
  if (!state) return null;
  return { row, state };
}

async function saveState(ctx: BotContext, sessionId: string, state: WerewolfState): Promise<void> {
  await ctx.db
    .updateTable("werewolf_games")
    .set({
      phase: state.phase,
      state: JSON.stringify(state) as unknown as Record<string, unknown>,
      updated_at: sqliteTimestamp() as unknown as Date,
    })
    .where("id", "=", sessionId)
    .execute();
}

async function markEnded(ctx: BotContext, sessionId: string, state: WerewolfState): Promise<void> {
  await saveState(ctx, sessionId, { ...state, phase: "ended", deadlineAt: null });
}

function validatePublicInteraction(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  state: WerewolfState,
  phase: WerewolfPhase,
): boolean {
  return state.phase === phase && interaction.channelId === state.werewolfChannelId;
}

async function replyRejected(interaction: ButtonInteraction | StringSelectMenuInteraction): Promise<boolean> {
  await interaction.reply({ embeds: [errorEmbed("この操作は現在の状態では実行できません。")], flags: MessageFlags.Ephemeral });
  return true;
}

function buildLobbyRows(sessionId: string, disabled: boolean): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`${BUTTON_PREFIX}join:${sessionId}`).setLabel("Join").setStyle(ButtonStyle.Success).setDisabled(disabled),
      new ButtonBuilder().setCustomId(`${BUTTON_PREFIX}leave:${sessionId}`).setLabel("Leave").setStyle(ButtonStyle.Secondary).setDisabled(disabled),
      new ButtonBuilder().setCustomId(`${BUTTON_PREFIX}start:${sessionId}`).setLabel("Start").setStyle(ButtonStyle.Primary).setDisabled(disabled),
      new ButtonBuilder().setCustomId(`${BUTTON_PREFIX}cancel:${sessionId}`).setLabel("Cancel").setStyle(ButtonStyle.Danger).setDisabled(disabled),
    ),
  ];
}

function werewolfEmbed(title: string, description: string): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(description.slice(0, 4096) || "\u200b")
    .setColor(0x8e44ad);
}

function statusEmbed(description: string): EmbedBuilder {
  return werewolfEmbed("人狼", description).setColor(0x3498db);
}

function errorEmbed(description: string): EmbedBuilder {
  return werewolfEmbed("人狼エラー", description).setColor(0xe74c3c);
}

function lobbyEmbed(state: WerewolfState, disabled: boolean): EmbedBuilder {
  return werewolfEmbed(
    disabled ? "人狼募集終了" : "人狼募集中",
    `参加者 (${state.participants.length}): ${state.participants.length ? formatMentions(state.participants) : "なし"}`,
  );
}

async function updateLobbyMessage(
  interaction: ButtonInteraction,
  sessionId: string,
  state: WerewolfState,
  disabled = false,
): Promise<void> {
  await interaction.message.edit({
    content: "",
    embeds: [lobbyEmbed(state, disabled)],
    components: buildLobbyRows(sessionId, disabled),
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

function buildRoleThreadIntro(role: WerewolfThreadRole, members: string[]): string {
  const base = `あなたの役職は ${ROLE_THREAD_LABELS[role]} です。`;
  if (role === "werewolf") return `${base}\nこのスレッドで夜の相談と襲撃対象の選択を行ってください。\n対象: ${formatMentions(members)}`;
  if (role === "seer") return `${base}\nこのスレッドで占い対象を選択してください。`;
  return `${base}\nこのスレッドで護衛対象を選択してください。`;
}

function nightPrompt(role: WerewolfThreadRole): string {
  if (role === "werewolf") return "襲撃対象を選択してください。";
  if (role === "seer") return "占い対象を選択してください。";
  return "護衛対象を選択してください。";
}

function nightPlaceholder(role: WerewolfThreadRole): string {
  if (role === "werewolf") return "襲撃対象";
  if (role === "seer") return "占い対象";
  return "護衛対象";
}

function buildDawnMessage(deaths: string[]): string {
  return deaths.length === 0
    ? "夜が明けました。死亡者はいません。"
    : `夜が明けました。死亡者: ${formatMentions(deaths)}`;
}

function buildVoteResultMessage(executed: string | null): string {
  return executed ? `投票結果: ${formatMentions([executed])} が処刑されました。` : "投票結果: 同票または無投票のため処刑なしです。";
}

function allNightActionsSubmitted(state: WerewolfState): boolean {
  const alive = alivePlayers(state);
  const aliveByRole = (role: WerewolfRole) => alive.filter((p) => p.role === role);
  const werewolves = aliveByRole("werewolf");
  const seers = aliveByRole("seer");
  const knights = aliveByRole("knight");
  return werewolves.every((p) => state.nightActions.attack[p.userId])
    && seers.every((p) => state.nightActions.inspect[p.userId])
    && knights.every((p) => state.nightActions.guard[p.userId]);
}

function alivePlayers(state: WerewolfState): WerewolfPlayer[] {
  return state.players.filter((p) => p.alive);
}

function formatMentions(userIds: string[]): string {
  return userIds.map((id) => `<@${id}>`).join(", ");
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

function truncateSelectLabel(value: string): string {
  const normalized = value.trim() || "Unknown";
  return normalized.length > 100 ? normalized.slice(0, 100) : normalized;
}

function parseButtonId(customId: string): { action: string; sessionId: string } | null {
  const parts = customId.split(":");
  if (parts.length !== 3 || parts[0] !== "ww") return null;
  return { action: parts[1]!, sessionId: parts[2]! };
}

function parseSelectId(customId: string): { action: string; role: WerewolfThreadRole | null; sessionId: string } | null {
  const parts = customId.split(":");
  if (parts[0] !== "wws") return null;
  if (parts[1] === "vote" && parts[2]) return { action: "vote", role: null, sessionId: parts[2] };
  if (parts[1] === "night" && isThreadRole(parts[2]) && parts[3]) {
    return { action: "night", role: parts[2], sessionId: parts[3] };
  }
  return null;
}

function isThreadRole(value: unknown): value is WerewolfThreadRole {
  return value === "werewolf" || value === "seer" || value === "knight";
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
