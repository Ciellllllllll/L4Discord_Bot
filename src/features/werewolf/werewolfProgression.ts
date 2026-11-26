import { componentCardsPayload } from "../../core/componentCard.js";
import {
  ActionRowBuilder,
  ChannelType,
  StringSelectMenuBuilder,
  type TextChannel,
} from "discord.js";
import {
  ROLE_LABELS,
  ROLE_THREAD_LABELS,
  THREAD_ROLES,
  checkWinner,
  resolveMajorityRandom,
  resolveVotes,
  type WerewolfState,
  type WerewolfWinner,
} from "./werewolfState.js";
import {
  findWerewolfGameById,
  markWerewolfEnded,
  saveWerewolfState,
} from "./werewolfRepository.js";
import {
  WEREWOLF_SELECT_PREFIX,
  buildDawnMessage,
  buildRoleThreadIntro,
  buildVoteResultMessage,
  nightPlaceholder,
  nightPrompt,
  werewolfCard,
} from "./werewolfUi.js";
import {
  DAY_MS,
  NIGHT_MS,
  VOTE_MS,
  alivePlayers,
  buildPlayerSelectOptions,
  deleteLobbyMessage,
  fetchTextChannel,
  fetchThread,
  type WerewolfDeps,
} from "./werewolfInteractionUtils.js";

// 人狼ゲームの進行 (夜・投票・終了)。

const timers = new Map<string, NodeJS.Timeout>();

async function createRoleThreads(
  ctx: WerewolfDeps,
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

async function postNightUis(ctx: WerewolfDeps, sessionId: string, state: WerewolfState): Promise<void> {
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

async function finalizeNight(ctx: WerewolfDeps, sessionId: string): Promise<void> {
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

async function startVoting(ctx: WerewolfDeps, sessionId: string): Promise<void> {
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

async function finalizeVoting(ctx: WerewolfDeps, sessionId: string): Promise<void> {
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
  ctx: WerewolfDeps,
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

async function archiveRoleThreads(ctx: WerewolfDeps, state: WerewolfState): Promise<void> {
  for (const threadId of Object.values(state.rolePrivateThreadIds)) {
    if (!threadId) continue;
    const thread = await fetchThread(ctx, threadId);
    if (!thread) continue;
    await thread.setArchived(true, "werewolf game ended").catch((err) => {
      ctx.log.warn({ err, threadId }, "werewolf: archive role thread failed");
    });
  }
}

function scheduleDeadline(ctx: WerewolfDeps, sessionId: string, state: WerewolfState): void {
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

export {
  createRoleThreads,
  postNightUis,
  finalizeNight,
  startVoting,
  finalizeVoting,
  finishGame,
  scheduleDeadline,
};
