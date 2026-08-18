import { ComponentCardBuilder, componentCardsPayload } from "../panels/componentCard.js";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  DiscordAPIError,
  MessageFlags,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
  type Message,
  type TextChannel,
} from "discord.js";
import { randomUUID } from "node:crypto";
import type { BotContext } from "../../bot/context.js";
import { sqliteTimestamp } from "../../core/db/sqliteTimestamp.js";
import { isAdmin } from "../../core/permission.js";
import {
  buildExecutionAuditReason,
  clampTimeoutMs,
  discordVoteDeadlineEmbedLine,
  EXECUTION_FLOW_KIND,
  EXEC_APPROVAL_PREFIX,
  EXEC_VOTE_PREFIX,
  POLL1_KEYS,
  POLL1_LABEL,
  POLL2_CHOICE_TO_SECONDS,
  POLL2_KEYS,
  POLL2_LABEL,
} from "./executionConstants.js";
import type { ExecutionAction, ExecutionFlowState } from "./executionFlow.types.js";
import { parseExecutionFlowState } from "./executionFlow.types.js";
import {
  FlowDeadlineTimers,
  type OpenPollFlow,
  PollFlowStateStore,
  flowTargetLocks,
  normalizePollStateRevision,
  saveOpenPollState,
} from "./flowLifecycle.js";
import { createTwoStagePollRuntime, parsePersistedFlowState, tallyChoices } from "./twoStagePollRuntime.js";

const EXECUTION_LOCK_NAMESPACE = "execution";
const executionTimers = new FlowDeadlineTimers<ReturnType<typeof setTimeout>>({ setTimeout, clearTimeout });
const executionFlowTargets = new Map<string, { guildId: string; targetId: string }>();

type OpenExecutionFlowRow = {
  id: string;
  guild_id: string;
  status: string;
  message_id: string | null;
  state: unknown;
  state_revision: number;
  updated_at: Date;
};

function timerKey(phase: "poll1" | "poll2" | "admin", flowId: string): string {
  return `${phase}:${flowId}`;
}

function retainExecutionTarget(flowId: string, guildId: string, targetId: string): boolean {
  const current = executionFlowTargets.get(flowId);
  if (current) return current.guildId === guildId && current.targetId === targetId;
  if (!flowTargetLocks.acquire(EXECUTION_LOCK_NAMESPACE, guildId, targetId)) return false;
  executionFlowTargets.set(flowId, { guildId, targetId });
  return true;
}

function releaseExecutionTarget(flowId: string): void {
  const target = executionFlowTargets.get(flowId);
  if (!target) return;
  flowTargetLocks.release(EXECUTION_LOCK_NAMESPACE, target.guildId, target.targetId);
  executionFlowTargets.delete(flowId);
}

/** プロセス終了時に、このランタイムが保持する処刑フローの期限タイマーと対象ロックを解放する。 */
export async function shutdownExecutionFlowRuntime(): Promise<void> {
  await executionOrchestrator.shutdown();
}

function adminWaitDeadlineMs(updatedAt: Date, waitSeconds: number): number {
  const updatedAtMs = new Date(updatedAt).getTime();
  const base = Number.isFinite(updatedAtMs) ? updatedAtMs : Date.now();
  return base + waitSeconds * 1000;
}

function memberHasRoleId(member: GuildMember, roleId: string): boolean {
  const id = roleId.trim();
  if (!id) return false;
  return member.roles.cache.has(id);
}

function parsePollRowState(row: { state: unknown }): ExecutionFlowState | null {
  return parsePersistedFlowState(row.state, parseExecutionFlowState);
}

export async function findOpenExecutionFlowById(
  ctx: BotContext,
  flowId: string,
): Promise<{ row: OpenExecutionFlowRow; state: ExecutionFlowState } | null> {
  const row = await ctx.db
    .selectFrom("polls")
    .select(["id", "guild_id", "status", "message_id", "state", "state_revision", "updated_at"])
    .where("id", "=", flowId)
    .where("kind", "=", EXECUTION_FLOW_KIND)
    .where("status", "=", "open")
    .executeTakeFirst();
  if (!row) return null;
  const stateRevision = normalizePollStateRevision(row.state_revision);
  if (stateRevision === null) {
    ctx.log.error({ flowId, guildId: row.guild_id, phase: "invalid_state_revision", stateRevision: row.state_revision }, "execution: ignoring unsafe flow state revision");
    return null;
  }
  const state = parsePollRowState(row);
  if (!state) return null;
  return { row: { ...row, state_revision: stateRevision }, state };
}

async function saveFullState(
  ctx: BotContext,
  flowId: string,
  state: ExecutionFlowState,
  messageId: string | null,
  expected?: OpenExecutionFlowRow,
): Promise<boolean> {
  return saveOpenPollState({
    store: new PollFlowStateStore(ctx.db),
    id: flowId,
    kind: EXECUTION_FLOW_KIND,
    parse: parseExecutionFlowState,
    nextState: state,
    messageId,
    ...(expected ? { expected: { state: parsePollRowState(expected) ?? state, state_revision: expected.state_revision, rawState: expected.state } } : {}),
  });
}

export async function deleteFlowMessagesQuietly(
  ctx: BotContext,
  channel: TextChannel,
  messageIds: string[],
  logLabel: string,
): Promise<void> {
  for (const id of messageIds) {
    try {
      const m = await channel.messages.fetch(id);
      if (m) await m.delete();
    } catch (err) {
      ctx.log.warn({ err, id, logLabel }, "execution: delete flow message failed");
    }
  }
}

function choiceToAction1(c: string): ExecutionAction | null {
  if (c === "1") return "timeout";
  if (c === "2") return "kick";
  if (c === "3") return "ban";
  return null;
}

/** 処刑フロー第1投票（処刑内容）。`pollEnded` 後は `:R` を使わず増加表示を防ぐ */
function buildPoll1Embed(state: ExecutionFlowState, poll1DeadlineMs: number, pollEnded = false): ComponentCardBuilder {
  const counts = tallyChoices(state.votes_poll1, POLL1_KEYS);
  const lines = POLL1_KEYS.map((k) => `**${k}.** ${POLL1_LABEL[k]} — ${counts[k] ?? 0} 票`);
  return new ComponentCardBuilder()
    .setTitle("処刑内容の投票")
    .setDescription(
      [
        `対象: <@${state.target_id}>`,
        "",
        "**投票先（ボタン 1〜3）**",
        ...lines,
        "",
        discordVoteDeadlineEmbedLine(poll1DeadlineMs, pollEnded),
      ].join("\n"),
    )
    .setTimestamp(new Date());
}

/** 処刑フロー第2投票（タイムアウト時間） */
function buildPoll2Embed(state: ExecutionFlowState, poll2DeadlineMs: number, pollEnded = false): ComponentCardBuilder {
  const counts = tallyChoices(state.votes_poll2, POLL2_KEYS);
  const lines = POLL2_KEYS.map((k) => `**${k}.** ${POLL2_LABEL[k]} — ${counts[k] ?? 0} 票`);
  return new ComponentCardBuilder()
    .setTitle("タイムアウト時間の投票")
    .setDescription(
      [
        `対象: <@${state.target_id}>`,
        "",
        "**投票先（ボタン 1〜4）**",
        ...lines,
        "",
        discordVoteDeadlineEmbedLine(poll2DeadlineMs, pollEnded),
      ].join("\n"),
    )
    .setTimestamp(new Date());
}

function poll1Rows(flowId: string, disabled: boolean): ActionRowBuilder<ButtonBuilder>[] {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...POLL1_KEYS.map((k) =>
      new ButtonBuilder()
        .setCustomId(`${EXEC_VOTE_PREFIX}${flowId}:${k}`)
        .setLabel(k)
        .setStyle(ButtonStyle.Primary)
        .setDisabled(disabled),
    ),
  );
  return [row];
}

function poll2Rows(flowId: string, disabled: boolean): ActionRowBuilder<ButtonBuilder>[] {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...POLL2_KEYS.map((k) =>
      new ButtonBuilder()
        .setCustomId(`${EXEC_VOTE_PREFIX}${flowId}:${k}`)
        .setLabel(k)
        .setStyle(ButtonStyle.Primary)
        .setDisabled(disabled),
    ),
  );
  return [row];
}

function approvalRows(flowId: string, disabled: boolean): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${EXEC_APPROVAL_PREFIX}${flowId}:approve`)
        .setLabel("承認")
        .setStyle(ButtonStyle.Success)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId(`${EXEC_APPROVAL_PREFIX}${flowId}:deny`)
        .setLabel("非承認")
        .setStyle(ButtonStyle.Danger)
        .setDisabled(disabled),
    ),
  ];
}

async function editMessagesStopped(
  ctx: BotContext,
  channel: TextChannel,
  messages: Array<{ id: string | null | undefined; components: ActionRowBuilder<ButtonBuilder>[] }>,
  heading: string,
): Promise<void> {
  const content = `# **${heading}**`;
  for (const { id: mid, components } of messages) {
    if (!mid) continue;
    try {
      const m = await channel.messages.fetch(mid);
      await m.edit({ content, embeds: [], components });
    } catch (err) {
      ctx.log.warn({ err, mid }, "execution: edit stopped message failed");
    }
  }
}

export async function abortFlow(
  ctx: BotContext,
  flowId: string,
  state: ExecutionFlowState,
  heading: string,
  guildId?: string,
  expected?: OpenExecutionFlowRow,
): Promise<boolean> {
  return executionOrchestrator.abort(ctx, flowId, state, heading, guildId, expected ? {
    id: expected.id,
    guildId: expected.guild_id,
    status: expected.status,
    messageId: expected.message_id,
    state,
    rawState: expected.state,
    stateRevision: expected.state_revision,
    updatedAt: expected.updated_at,
  } : undefined);
}

function scheduleAdminWait(
  ctx: BotContext,
  flowId: string,
  expectedPhase: "precheck_pending" | "admin_pending",
  delayMs = ctx.config.EXEC_ADMIN_WAIT_SECONDS * 1000,
): void {
  executionTimers.schedule(timerKey("admin", flowId), delayMs, () => {
    void (async () => {
      try {
        const found = await findOpenExecutionFlowById(ctx, flowId);
        if (!found || found.state.phase !== expectedPhase || found.state.admin_button_fired) return;
        ctx.log.warn({ flowId, guildId: found.row.guild_id, phase: found.state.phase }, "execution: admin wait timeout");
        await abortFlow(ctx, flowId, found.state, "処刑フロー: 承認がタイムアウトしました", found.row.guild_id, found.row);
      } catch (err) {
        ctx.log.error({ err, flowId, phase: expectedPhase }, "execution: admin timeout handler failed");
      }
    })();
  });
}

export async function reconcileExecutionFlows(ctx: BotContext): Promise<void> {
  await executionOrchestrator.reconcile(ctx);
}

async function postPrecheckRequest(ctx: BotContext, channel: TextChannel, flowId: string): Promise<Message | null> {
  const adminRoleId = ctx.config.ADMIN_ROLE_ID.trim();
  try {
    return await channel.send({
      content: `<@&${adminRoleId}> 対象に処刑者ロールがありません。続行するには管理者の承認が必要です。`,
      components: approvalRows(flowId, false),
      allowedMentions: { roles: [adminRoleId] },
    });
  } catch (err) {
    ctx.log.warn({ err, flowId }, "execution: precheck send failed");
    return null;
  }
}

async function postAdminRequest(ctx: BotContext, channel: TextChannel, flowId: string, body: string): Promise<Message | null> {
  const adminRoleId = ctx.config.ADMIN_ROLE_ID.trim();
  try {
    return await channel.send({
      content: `${body}\n<@&${adminRoleId}>`,
      components: approvalRows(flowId, false),
      allowedMentions: { roles: [adminRoleId] },
    });
  } catch (err) {
    ctx.log.warn({ err, flowId }, "execution: admin request send failed");
    return null;
  }
}

async function disableExecutionPollMessage(
  channel: TextChannel,
  messageId: string | null,
  payload: ReturnType<typeof componentCardsPayload>,
): Promise<void> {
  if (!messageId) return;
  try {
    const message = await channel.messages.fetch(messageId).catch(() => null);
    if (message) await message.edit(payload);
  } catch {
    /* UI の無効化失敗は状態確定を巻き戻さない */
  }
}

export function beginPoll1(ctx: BotContext, flowId: string, state: ExecutionFlowState): Promise<boolean> {
  return executionOrchestrator.beginPoll1(ctx, flowId, state, executionFlowTargets.get(flowId)?.guildId);
}
/** 初回の事前承認投稿は、Discord APIの副作用より先にCAS予約を確定する。 */
export async function beginInitialPrecheck(
  ctx: BotContext,
  flowId: string,
  guildId: string,
  state: ExecutionFlowState,
  channel: TextChannel,
): Promise<boolean> {
  const reservedState: ExecutionFlowState = {
    ...state,
    phase: "precheck_pending",
    precheck_message_id: null,
    precheck_publish_reserved: true,
  };
  if (!await saveFullState(ctx, flowId, reservedState, null)) return false;

  const reserved = await findOpenExecutionFlowById(ctx, flowId);
  if (!reserved
    || reserved.state.phase !== "precheck_pending"
    || !reserved.state.precheck_publish_reserved
    || reserved.state.precheck_message_id !== null) return false;

  const message = await postPrecheckRequest(ctx, channel, flowId);
  if (!message) {
    await abortFlow(ctx, flowId, reserved.state, "処刑フロー: 事前承認メッセージの送信に失敗しました", guildId, reserved.row);
    return false;
  }

  const next: ExecutionFlowState = {
    ...reserved.state,
    precheck_message_id: message.id,
    precheck_publish_reserved: false,
  };
  if (!await saveFullState(ctx, flowId, next, null, reserved.row)) {
    try {
      await message.delete();
    } catch (err) {
      ctx.log.warn({ err, flowId, messageId: message.id }, "execution: discard precheck message failed");
    }
    return false;
  }
  return true;
}

export function transitionPoll1ToNext(ctx: BotContext, flowId: string): Promise<void> {
  return executionOrchestrator.transitionPoll1(ctx, flowId, executionFlowTargets.get(flowId)?.guildId ?? "unknown");
}

export function transitionPoll2ToAdmin(ctx: BotContext, flowId: string): Promise<void> {
  return executionOrchestrator.transitionPoll2(ctx, flowId, executionFlowTargets.get(flowId)?.guildId ?? "unknown");
}
const executionOrchestrator = createTwoStagePollRuntime<BotContext, ExecutionFlowState, (typeof POLL1_KEYS)[number], (typeof POLL2_KEYS)[number]>({
  namespace: "execution",
  kind: EXECUTION_FLOW_KIND,
  votePrefix: EXEC_VOTE_PREFIX,
  approvalPrefix: EXEC_APPROVAL_PREFIX,
  timers: executionTimers,
  parse: (value) => parsePersistedFlowState(value, parseExecutionFlowState),
  targetId: (state) => state.target_id,
  retainTarget: retainExecutionTarget,
  releaseTarget: releaseExecutionTarget,
  releaseAllTargets: () => {
    for (const flowId of [...executionFlowTargets.keys()]) releaseExecutionTarget(flowId);
  },
  isAdmin: (ctx, member) => isAdmin(member, ctx.config),
  handleOtherApproval: handleExecutionPrecheckApproval,
  approvalComponents: (flowId) => approvalRows(flowId, true),
  canExecuteFinal: (state) => state.resolved_action !== null,
  executeFinal: executeApprovedExecution,
  notifyDenied: notifyExecutionDenied,
  cleanupFinal: cleanupExecutionApproval,
  afterApproved: (ctx, current, approverId, result) => {
    ctx.log.info({
      flowId: current.id,
      approverId,
      act: current.state.resolved_action,
      ok: result.ok,
      phase: current.state.phase,
      guildId: current.guildId,
    }, "execution: approved");
  },
  voteDurationMs: (ctx) => ctx.config.EXEC_VOTE_SECONDS * 1000,
  adminWaitMs: (ctx) => ctx.config.EXEC_ADMIN_WAIT_SECONDS * 1000,
  toPoll1Pending: (state, deadline) => ({
    ...state, phase: "poll1_pending", poll1_message_id: null, poll1_deadline_ms: deadline, votes_poll1: {},
  }),
  poll1Published: (state, messageId) => ({ ...state, poll1_message_id: messageId }),
  resolvePoll1: (state, winner, poll2Deadline) => {
    const action = choiceToAction1(winner);
    if (!action) throw new Error("invalid execution poll1 winner");
    return action === "timeout"
      ? { destination: "poll2", state: { ...state, phase: "poll2_pending", resolved_action: "timeout", poll2_message_id: null, poll2_deadline_ms: poll2Deadline, votes_poll2: {} } }
      : { destination: "admin", state: { ...state, phase: "admin_pending", resolved_action: action, duration_seconds: null, admin_message_id: null }, adminText: `処刑の最終承認: <@${state.target_id}> → ${action === "kick" ? "キック" : "BAN"}` };
  },
  poll2Published: (state, messageId) => ({ ...state, poll2_message_id: messageId }),
  resolvePoll2: (state, winner) => {
    const durationSeconds = POLL2_CHOICE_TO_SECONDS[winner] ?? 60;
    return {
      state: { ...state, phase: "admin_pending", resolved_action: "timeout", duration_seconds: durationSeconds, admin_message_id: null },
      adminText: `処刑の最終承認: <@${state.target_id}> → タイムアウト（${POLL2_LABEL[winner] ?? winner}）`,
    };
  },
  adminPublished: (state, messageId) => ({ ...state, admin_message_id: messageId }),
  publishPoll1: async (ctx, flowId, state) => {
    const channel = (await ctx.client.channels.fetch(state.channel_id).catch(() => null)) as TextChannel | null;
    if (!channel?.isTextBased()) {
      ctx.log.error({ flowId, phase: state.phase, guildId: executionFlowTargets.get(flowId)?.guildId ?? "unknown" }, "execution: vote channel unavailable");
      return { failureHeading: "処刑フロー: 投票チャンネルを取得できませんでした" };
    }
    try {
      return await channel.send({ ...componentCardsPayload([buildPoll1Embed(state, state.poll1_deadline_ms)], poll1Rows(flowId, false)), allowedMentions: { users: [state.target_id] } });
    } catch (err) {
      ctx.log.error({ err, flowId, phase: state.phase }, "execution: poll1 send failed");
      return null;
    }
  },
  publishPoll2: async (ctx, flowId, state) => {
    const channel = (await ctx.client.channels.fetch(state.channel_id).catch(() => null)) as TextChannel | null;
    if (!channel?.isTextBased()) {
      ctx.log.error({ flowId, phase: state.phase, guildId: executionFlowTargets.get(flowId)?.guildId ?? "unknown" }, "execution: vote channel unavailable");
      return { failureHeading: "処刑フロー: 投票チャンネルを取得できませんでした" };
    }
    try {
      return await channel.send({ ...componentCardsPayload([buildPoll2Embed(state, state.poll2_deadline_ms!)], poll2Rows(flowId, false)), allowedMentions: { users: [state.target_id] } });
    } catch (err) {
      ctx.log.error({ err, flowId, phase: state.phase }, "execution: poll2 send failed");
      return null;
    }
  },
  publishAdmin: async (ctx, flowId, state, text) => {
    const channel = (await ctx.client.channels.fetch(state.channel_id).catch(() => null)) as TextChannel | null;
    if (channel?.isTextBased()) return postAdminRequest(ctx, channel, flowId, text);
    ctx.log.error({ flowId, phase: state.phase, guildId: executionFlowTargets.get(flowId)?.guildId ?? "unknown" }, "execution: vote channel unavailable");
    return { failureHeading: "処刑フロー: 投票チャンネルを取得できませんでした" };
  },
  disablePoll1: async (ctx, flowId, state) => {
    const channel = (await ctx.client.channels.fetch(state.channel_id).catch(() => null)) as TextChannel | null;
    if (channel?.isTextBased()) await disableExecutionPollMessage(channel, state.poll1_message_id, componentCardsPayload([buildPoll1Embed(state, state.poll1_deadline_ms, true)], poll1Rows(flowId, true)));
  },
  disablePoll2: async (ctx, flowId, state) => {
    const channel = (await ctx.client.channels.fetch(state.channel_id).catch(() => null)) as TextChannel | null;
    if (channel?.isTextBased()) await disableExecutionPollMessage(channel, state.poll2_message_id, componentCardsPayload([buildPoll2Embed(state, state.poll2_deadline_ms!, true)], poll2Rows(flowId, true)));
  },
  discardMessage: async (ctx, flowId, message, label) => {
    try { await message.delete(); } catch (err) { ctx.log.warn({ err, flowId, messageId: message.id, label }, "execution: discard unpublished message failed"); }
  },
  stopMessages: async (ctx, flowId, state, heading) => {
    const channel = (await ctx.client.channels.fetch(state.channel_id).catch(() => null)) as TextChannel | null;
    if (!channel?.isTextBased()) return;
    await editMessagesStopped(ctx, channel, [
      { id: state.precheck_message_id, components: approvalRows(flowId, true) },
      { id: state.poll1_message_id, components: poll1Rows(flowId, true) },
      { id: state.poll2_message_id, components: poll2Rows(flowId, true) },
      { id: state.admin_message_id, components: approvalRows(flowId, true) },
    ], heading);
  },
  poll1Choices: POLL1_KEYS,
  poll2Choices: POLL2_KEYS,
  poll1Labels: POLL1_LABEL,
  poll2Labels: POLL2_LABEL,
  renderPoll1: (state, flowId) => componentCardsPayload([buildPoll1Embed(state, state.poll1_deadline_ms)], poll1Rows(flowId, false)),
  renderPoll2: (state, flowId) => componentCardsPayload([buildPoll2Embed(state, state.poll2_deadline_ms!)], poll2Rows(flowId, false)),
  adminPending: (state) => state.phase === "precheck_pending" || state.phase === "admin_pending",
  adminDeadline: (ctx, row) => adminWaitDeadlineMs(row.updated_at, ctx.config.EXEC_ADMIN_WAIT_SECONDS),
  claimed: (state) => state.phase === "admin_pending" && state.admin_button_fired,
  unpublished: (state) => (state.phase === "poll1_pending" && !state.poll1_message_id)
    || (state.phase === "poll2_pending" && !state.poll2_message_id)
    || (state.phase === "admin_pending" && !state.admin_message_id),
  poll1Deadline: (state) => state.phase === "poll1_pending" ? state.poll1_deadline_ms : null,
  poll2Deadline: (state) => state.phase === "poll2_pending" ? state.poll2_deadline_ms : null,
  restoredDeadlineExpiredHeading: "処刑フロー: 再起動後の復元時に期限切れを検出",
  adminTimeoutHeading: "処刑フロー: 承認がタイムアウトしました",
  duplicateTargetHeading: "処刑フロー: 同一対象の重複フローを中止しました",
  unpublishedHeading: "処刑フロー: 再起動後に未公開の遷移を中止しました",
  poll1NoWinnerHeading: "処刑フロー: 投票の最多票が確定しませんでした",
  poll2NoWinnerHeading: "処刑フロー: タイムアウト時間の最多票が確定しませんでした",
  poll1PublishFailureHeading: "処刑フロー: 投票メッセージの送信に失敗しました",
  poll2PublishFailureHeading: "処刑フロー: タイムアウト時間投票の送信に失敗しました",
  adminPublishFailureHeading: "処刑フロー: 最終承認メッセージの送信に失敗しました",
});

export async function startExecutionFlow(
  interaction: ChatInputCommandInteraction,
  ctx: BotContext,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const guild = interaction.guild;
  if (!guild) {
    await interaction.editReply({ content: "サーバー内でのみ実行できます。" });
    return;
  }

  const execCh = ctx.config.EXEC_CHANNEL_ID?.trim();
  if (execCh && interaction.channelId !== execCh) {
    await interaction.editReply({ content: "このコマンドは指定チャンネルでのみ使用できます。" });
    return;
  }

  const targetUser = interaction.options.getUser("target", true);

  let targetMember: GuildMember;
  try {
    targetMember = await guild.members.fetch(targetUser.id);
  } catch {
    await interaction.editReply({ content: "対象メンバーを取得できませんでした。" });
    return;
  }

  if (isAdmin(targetMember, ctx.config)) {
    const ch = interaction.channel;
    if (ch?.isTextBased() && !ch.isDMBased()) {
      await (ch as TextChannel).send({
        content: `<@${interaction.user.id}> が <@${targetUser.id}> に対し、処刑しようとしました`,
        allowedMentions: { users: [interaction.user.id, targetUser.id] },
      });
    }
    await interaction.editReply({ content: "記録しました。" });
    return;
  }

  const channel = interaction.channel;
  if (!channel || !channel.isTextBased() || channel.isDMBased()) {
    await interaction.editReply({ content: "このチャンネルでは実行できません。" });
    return;
  }
  const textChannel = channel as TextChannel;

  const flowId = randomUUID();
  if (!retainExecutionTarget(flowId, guild.id, targetUser.id)) {
    await interaction.editReply({ content: "この対象では既に処刑フローが進行中です。" });
    return;
  }
  const executorRole = ctx.config.EXECUTOR_ROLE_ID?.trim();
  const needsPrecheck = Boolean(executorRole && !memberHasRoleId(targetMember, executorRole));

  const baseState: ExecutionFlowState = {
    phase: needsPrecheck ? "precheck_pending" : "poll1_pending",
    invoker_id: interaction.user.id,
    target_id: targetUser.id,
    channel_id: textChannel.id,
    precheck_message_id: null,
    precheck_publish_reserved: false,
    poll1_message_id: null,
    poll2_message_id: null,
    votes_poll1: {},
    votes_poll2: {},
    poll1_deadline_ms: 0,
    poll2_deadline_ms: null,
    admin_message_id: null,
    resolved_action: null,
    duration_seconds: null,
    admin_button_fired: false,
  };

  try {
    await ctx.db
      .insertInto("polls")
      .values({
        id: flowId,
        guild_id: guild.id,
        channel_id: textChannel.id,
        message_id: null,
        kind: EXECUTION_FLOW_KIND,
        status: "open",
        state: JSON.stringify(baseState) as unknown as Record<string, unknown>,
        ends_at: null,
        created_at: sqliteTimestamp() as unknown as Date,
        updated_at: sqliteTimestamp() as unknown as Date,
        state_revision: 0,
      })
      .execute();
  } catch (err) {
    releaseExecutionTarget(flowId);
    ctx.log.error({ err, flowId, phase: baseState.phase, guildId: guild.id }, "execution: create flow failed");
    await interaction.editReply({ content: "フローの開始に失敗しました。" });
    return;
  }

  if (needsPrecheck) {
    const published = await beginInitialPrecheck(ctx, flowId, guild.id, baseState, textChannel);
    if (!published) {
      releaseExecutionTarget(flowId);
      await interaction.editReply({ content: "事前承認メッセージを投稿できなかったため、フローを開始できませんでした。" });
      return;
    }
    scheduleAdminWait(ctx, flowId, "precheck_pending");
    await interaction.editReply({ content: "管理者の事前承認を待っています。" });
    return;
  }

  try {
    const started = await executionOrchestrator.beginPoll1(ctx, flowId, baseState, guild.id);
    if (!started) {
      await interaction.editReply({ content: "投票チャンネルを取得できなかったため、フローを開始できませんでした。" });
      return;
    }
  } catch (err) {
    releaseExecutionTarget(flowId);
    await ctx.db.deleteFrom("polls").where("id", "=", flowId).execute().catch(() => undefined);
    ctx.log.error({ err, flowId, phase: baseState.phase, guildId: guild.id }, "execution: begin failed");
    await interaction.editReply({ content: "フローの開始に失敗しました。" });
    return;
  }
  await interaction.editReply({ content: "処刑投票を開始しました。" });
}

function actionLabelJa(action: ExecutionAction): string {
  if (action === "timeout") return "タイムアウト";
  if (action === "kick") return "キック";
  return "BAN";
}

function durationLabelFromSeconds(sec: number | null): string {
  if (sec == null) return "";
  if (sec < 120) return `${sec}秒`;
  if (sec < 3600) return `${Math.floor(sec / 60)}分`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}時間`;
  if (sec < 86400 * 7) return `${Math.floor(sec / 86400)}日`;
  return `${Math.floor(sec / (86400 * 7))}週間`;
}

/** 監査・キック/BAN/タイムアウト理由・Detecter 通知に渡す日本語の処罰内容（BOT が自動生成） */
function buildPunishmentDetailJa(state: ExecutionFlowState): string {
  const act = state.resolved_action;
  if (!act) return "処罰";
  if (act === "timeout") {
    const sec = state.duration_seconds;
    if (sec == null) return "タイムアウト";
    return `タイムアウト（${durationLabelFromSeconds(sec)}）`;
  }
  if (act === "kick") return "キック";
  return "BAN";
}

async function carryOutPunishment(
  guild: Guild,
  targetId: string,
  action: ExecutionAction,
  durationSeconds: number | null,
  reason: string,
  ctx: BotContext,
): Promise<{ ok: true } | { ok: false; message: string }> {
  let member: GuildMember;
  try {
    member = await guild.members.fetch(targetId);
  } catch {
    return { ok: false, message: "対象メンバーが見つかりません（退出済みなど）。" };
  }

  try {
    if (action === "timeout") {
      const sec = durationSeconds ?? 60;
      const ms = clampTimeoutMs(sec * 1000);
      await member.timeout(ms, reason);
    } else if (action === "kick") {
      await member.kick(reason);
    } else {
      await member.ban({ reason, deleteMessageSeconds: 0 });
    }
    return { ok: true };
  } catch (err) {
    ctx.log.warn({ err, targetId, action }, "execution: punishment failed");
    if (err instanceof DiscordAPIError) {
      return { ok: false, message: `Discord API: ${err.message}` };
    }
    return { ok: false, message: String(err) };
  }
}

async function handleExecutionPrecheckApproval(
  interaction: ButtonInteraction,
  ctx: BotContext,
  current: OpenPollFlow<ExecutionFlowState>,
  action: "approve" | "deny",
  controls: { abort(heading: string): Promise<boolean>; beginPoll1(state: ExecutionFlowState): Promise<boolean> },
): Promise<boolean> {
  const state = current.state;
  if (state.phase !== "precheck_pending") return false;
  const row: OpenExecutionFlowRow = {
    id: current.id,
    guild_id: current.guildId,
    status: current.status,
    message_id: current.messageId,
    state: current.rawState,
    state_revision: current.stateRevision,
    updated_at: current.updatedAt,
  };
  if (action === "deny") {
    if (!await controls.abort("処刑フロー: 事前承認が拒否されました")) {
      await interaction.reply({ content: "状態の保存に失敗しました。再試行してください。", flags: MessageFlags.Ephemeral });
      return true;
    }
    await interaction.update({ components: approvalRows(current.id, true) }).catch(() => undefined);
    return true;
  }

  const next: ExecutionFlowState = { ...state, phase: "poll1_pending", precheck_message_id: state.precheck_message_id };
  try {
    if (!await saveFullState(ctx, current.id, next, null, row)) {
      await interaction.reply({ content: "このフローは既に処理されています。再試行してください。", flags: MessageFlags.Ephemeral });
      return true;
    }
  } catch (err) {
    ctx.log.error({ err, flowId: current.id, phase: state.phase, guildId: current.guildId }, "execution: precheck approval persistence failed");
    await interaction.reply({ content: "状態の保存に失敗しました。再試行してください。", flags: MessageFlags.Ephemeral });
    return true;
  }
  executionTimers.clear(timerKey("admin", current.id));
  await interaction.update({ components: approvalRows(current.id, true) }).catch(() => undefined);
  await controls.beginPoll1(next);
  return true;
}

async function notifyExecutionDenied(
  ctx: BotContext,
  interaction: ButtonInteraction,
  current: OpenPollFlow<ExecutionFlowState>,
  approverId: string,
): Promise<void> {
  try {
    await (interaction.channel as TextChannel).send({ content: "処刑が非承認されたため、中止します" });
  } catch (err) {
    ctx.log.warn({ err, flowId: current.id, phase: current.state.phase, guildId: current.guildId }, "execution: abort message failed");
  }
  ctx.log.info({ flowId: current.id, approverId, phase: current.state.phase, guildId: current.guildId }, "execution: final deny");
}

async function cleanupExecutionApproval(
  ctx: BotContext,
  interaction: ButtonInteraction,
  state: ExecutionFlowState,
  label: "approve" | "deny",
): Promise<void> {
  const ids = [state.precheck_message_id, state.poll1_message_id, state.poll2_message_id, state.admin_message_id]
    .filter((id): id is string => Boolean(id));
  await deleteFlowMessagesQuietly(ctx, interaction.channel as TextChannel, ids, label === "deny" ? "reject" : label);
}

async function executeApprovedExecution(
  ctx: BotContext,
  interaction: ButtonInteraction,
  current: OpenPollFlow<ExecutionFlowState>,
  approverId: string,
): Promise<{ ok: boolean }> {
  const state = current.state;
  const action = state.resolved_action;
  if (!action || !interaction.guild) return { ok: false };
  const result = await carryOutPunishment(
    interaction.guild,
    state.target_id,
    action,
    state.duration_seconds,
    buildExecutionAuditReason(approverId, buildPunishmentDetailJa(state)),
    ctx,
  );
  const channel = interaction.channel as TextChannel;
  if (result.ok) {
    const duration = action === "timeout" ? `（${durationLabelFromSeconds(state.duration_seconds)}）` : "";
    try {
      await channel.send({
        content: `# <@${state.target_id}> を **${actionLabelJa(action)}${duration}** で処刑しました`,
        allowedMentions: { users: [state.target_id] },
      });
    } catch (err) {
      ctx.log.warn({ err, flowId: current.id, phase: state.phase, guildId: current.guildId }, "execution: result message failed");
    }
  } else {
    try {
      await channel.send({ content: `処刑の実行に失敗しました: ${result.message}` });
    } catch (err) {
      ctx.log.warn({ err, flowId: current.id, phase: state.phase, guildId: current.guildId }, "execution: error message failed");
    }
  }
  return { ok: result.ok };
}

export async function handleExecutionFlowButton(
  interaction: ButtonInteraction,
  ctx: BotContext,
): Promise<boolean> {
  if (interaction.customId.startsWith(EXEC_VOTE_PREFIX)) {
    return executionOrchestrator.handleVote(interaction, ctx);
  }
  if (interaction.customId.startsWith(EXEC_APPROVAL_PREFIX)) {
    return executionOrchestrator.handleApproval(interaction, ctx);
  }
  return false;
}
