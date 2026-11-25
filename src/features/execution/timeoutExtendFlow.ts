import { ComponentCardBuilder, componentCardsPayload } from "../../core/componentCard.js";
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
import { nowIso } from "../../core/db/nowIso.js";
import { isAdmin } from "../../core/permission.js";
import { clampTimeoutMs, discordVoteDeadlineEmbedLine } from "./executionConstants.js";
import {
  TE_APPROVAL_PREFIX,
  TE_POLL1_KEYS,
  TE_POLL1_LABEL,
  TE_POLL2_KEYS,
  TE_POLL2_LABEL,
  TE_POLL2_SECONDS,
  TE_VOTE_PREFIX,
  TIMEOUT_EXTEND_FLOW_KIND,
} from "./timeoutExtendConstants.js";
import type { TimeoutExtendFlowState } from "./timeoutExtendFlow.types.js";
import { parseTimeoutExtendFlowState } from "./timeoutExtendFlow.types.js";
import {
  FlowDeadlineTimers,
  type OpenPollFlow,
} from "./flowLifecycle.js";
import {
  adminWaitDeadlineMs,
  buildApprovedAuditReason,
  createFlowTargetTracker,
  deletePollFlowMessagesQuietly,
  disablePollMessage,
  editPollMessagesStopped,
  findOpenPollFlowById,
  formatDurationLabelJa,
  postPollAdminRequest,
  type OpenPollFlowRow,
} from "./pollFlowHelpers.js";
import { createTwoStagePollRuntime, parsePersistedFlowState, tallyChoices } from "./twoStagePollRuntime.js";

const timeoutExtendTimers = new FlowDeadlineTimers<ReturnType<typeof setTimeout>>({ setTimeout, clearTimeout });
const timeoutExtendTargetTracker = createFlowTargetTracker("timeout-extend");

type OpenTimeoutExtendFlowRow = OpenPollFlowRow;

function retainTimeoutExtendTarget(flowId: string, guildId: string, targetId: string): boolean {
  return timeoutExtendTargetTracker.retain(flowId, guildId, targetId);
}

function releaseTimeoutExtendTarget(flowId: string): void {
  timeoutExtendTargetTracker.release(flowId);
}

export async function shutdownTimeoutExtendFlowRuntime(): Promise<void> {
  await timeoutExtendOrchestrator.shutdown();
}

export async function findOpenTimeoutExtendFlowById(
  ctx: BotContext,
  flowId: string,
): Promise<{ row: OpenTimeoutExtendFlowRow; state: TimeoutExtendFlowState } | null> {
  return findOpenPollFlowById(ctx, flowId, TIMEOUT_EXTEND_FLOW_KIND, parseTimeoutExtendFlowState, "timeoutExtend");
}

export async function deleteTeFlowMessagesQuietly(
  ctx: BotContext,
  channel: TextChannel,
  messageIds: string[],
  logLabel: string,
): Promise<void> {
  await deletePollFlowMessagesQuietly(ctx, channel, messageIds, "timeoutExtend", logLabel);
}

const TIMEOUT_EXTEND_REASON_BASE = "/タイムアウト延長フロー";

function buildTimeoutExtendAuditReason(approverUserId: string, detailJa: string): string {
  return buildApprovedAuditReason(TIMEOUT_EXTEND_REASON_BASE, detailJa, approverUserId);
}

const teAdminWaitDeadlineMs = adminWaitDeadlineMs;
const durationLabelJa = formatDurationLabelJa;

function buildPoll1Embed(state: TimeoutExtendFlowState, poll1DeadlineMs: number, pollEnded = false): ComponentCardBuilder {
  const counts = tallyChoices(state.votes_poll1, [...TE_POLL1_KEYS]);
  const lines = TE_POLL1_KEYS.map((k) => `**${TE_POLL1_LABEL[k]}** — ${counts[k] ?? 0} 票`);
  return new ComponentCardBuilder()
    .setTitle("タイムアウト処理を選択")
    .setDescription(
      [`対象: <@${state.target_id}>`, "", ...lines, "", discordVoteDeadlineEmbedLine(poll1DeadlineMs, pollEnded)].join("\n"),
    )
    .setTimestamp(new Date());
}

function buildPoll2Embed(state: TimeoutExtendFlowState, poll2DeadlineMs: number, pollEnded = false): ComponentCardBuilder {
  const counts = tallyChoices(state.votes_poll2, [...TE_POLL2_KEYS]);
  const lines = TE_POLL2_KEYS.map((k) => `**${TE_POLL2_LABEL[k]}** — ${counts[k] ?? 0} 票`);
  return new ComponentCardBuilder()
    .setTitle("延長時間を選択")
    .setDescription(
      [`対象: <@${state.target_id}>`, "", ...lines, "", discordVoteDeadlineEmbedLine(poll2DeadlineMs, pollEnded)].join("\n"),
    )
    .setTimestamp(new Date());
}

function tePoll1Rows(flowId: string, disabled: boolean): ActionRowBuilder<ButtonBuilder>[] {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...TE_POLL1_KEYS.map((k) =>
      new ButtonBuilder()
        .setCustomId(`${TE_VOTE_PREFIX}${flowId}:${k}`)
        .setLabel(TE_POLL1_LABEL[k])
        .setStyle(ButtonStyle.Primary)
        .setDisabled(disabled),
    ),
  );
  return [row];
}

function tePoll2Rows(flowId: string, disabled: boolean): ActionRowBuilder<ButtonBuilder>[] {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...TE_POLL2_KEYS.map((k) =>
      new ButtonBuilder()
        .setCustomId(`${TE_VOTE_PREFIX}${flowId}:${k}`)
        .setLabel(TE_POLL2_LABEL[k])
        .setStyle(ButtonStyle.Primary)
        .setDisabled(disabled),
    ),
  );
  return [row];
}

function teApprovalRows(flowId: string, disabled: boolean): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${TE_APPROVAL_PREFIX}${flowId}:approve`)
        .setLabel("承認")
        .setStyle(ButtonStyle.Success)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId(`${TE_APPROVAL_PREFIX}${flowId}:deny`)
        .setLabel("非承認")
        .setStyle(ButtonStyle.Danger)
        .setDisabled(disabled),
    ),
  ];
}

async function editTeMessagesStopped(
  ctx: BotContext,
  channel: TextChannel,
  messages: Array<{ id: string | null | undefined; components: ActionRowBuilder<ButtonBuilder>[] }>,
  heading: string,
): Promise<void> {
  await editPollMessagesStopped(ctx, channel, messages, heading, "timeoutExtend");
}

export async function abortTeFlow(
  ctx: BotContext,
  flowId: string,
  state: TimeoutExtendFlowState,
  heading: string,
  guildId?: string,
  expected?: OpenTimeoutExtendFlowRow,
): Promise<boolean> {
  return timeoutExtendOrchestrator.abort(ctx, flowId, state, heading, guildId, expected ? {
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

export async function reconcileTimeoutExtendFlows(ctx: BotContext): Promise<void> {
  await timeoutExtendOrchestrator.reconcile(ctx);
}

async function postTeAdminRequest(ctx: BotContext, channel: TextChannel, flowId: string, body: string): Promise<Message | null> {
  return postPollAdminRequest(ctx, channel, flowId, body, teApprovalRows(flowId, false), "timeoutExtend");
}

async function disableTimeoutExtendPollMessage(
  channel: TextChannel,
  messageId: string | null,
  payload: ReturnType<typeof componentCardsPayload>,
): Promise<void> {
  await disablePollMessage(channel, messageId, payload);
}

export function beginTePoll1(ctx: BotContext, flowId: string, guildId: string, state: TimeoutExtendFlowState): Promise<boolean> {
  return timeoutExtendOrchestrator.beginPoll1(ctx, flowId, state, guildId);
}
export function transitionTePoll1ToNext(ctx: BotContext, flowId: string, guildId: string): Promise<void> {
  return timeoutExtendOrchestrator.transitionPoll1(ctx, flowId, guildId);
}

export function transitionTePoll2ToAdmin(ctx: BotContext, flowId: string, guildId: string): Promise<void> {
  return timeoutExtendOrchestrator.transitionPoll2(ctx, flowId, guildId);
}
const timeoutExtendOrchestrator = createTwoStagePollRuntime<BotContext, TimeoutExtendFlowState, (typeof TE_POLL1_KEYS)[number], (typeof TE_POLL2_KEYS)[number]>({
  namespace: "timeoutExtend",
  kind: TIMEOUT_EXTEND_FLOW_KIND,
  votePrefix: TE_VOTE_PREFIX,
  approvalPrefix: TE_APPROVAL_PREFIX,
  timers: timeoutExtendTimers,
  parse: (value) => parsePersistedFlowState(value, parseTimeoutExtendFlowState),
  targetId: (state) => state.target_id,
  retainTarget: retainTimeoutExtendTarget,
  releaseTarget: releaseTimeoutExtendTarget,
  releaseAllTargets: () => timeoutExtendTargetTracker.releaseAll(),
  isAdmin: (ctx, member) => isAdmin(member, ctx.config),
  approvalComponents: (flowId) => teApprovalRows(flowId, true),
  canExecuteFinal: (state) => state.resolved_extend === "extend" || state.resolved_extend === "release",
  executeFinal: executeApprovedTimeoutExtend,
  notifyDenied: notifyTimeoutExtendDenied,
  cleanupFinal: cleanupTimeoutExtendApproval,
  afterApproved: (ctx, current, approverId, result) => {
    ctx.log.info({
      flowId: current.id,
      approverId,
      resolved: current.state.resolved_extend,
      detailJa: buildResolvedDetailJa(current.state),
      ok: result.ok,
      phase: current.state.phase,
      guildId: current.guildId,
    }, "timeoutExtend: approved");
  },
  voteDurationMs: (ctx) => ctx.config.EXEC_VOTE_SECONDS * 1000,
  adminWaitMs: (ctx) => ctx.config.TIMEOUT_EXTEND_ADMIN_WAIT_SECONDS * 1000,
  toPoll1Pending: (state, deadline) => ({
    ...state, phase: "poll1_pending", poll1_message_id: null, poll1_publish_reserved: true,
    poll1_deadline_ms: deadline, votes_poll1: {},
  }),
  poll1Published: (state, messageId) => ({ ...state, poll1_message_id: messageId, poll1_publish_reserved: false }),
  resolvePoll1: (state, winner, poll2Deadline) => winner === "release"
    ? {
        destination: "admin", state: { ...state, phase: "admin_pending", resolved_extend: "release", duration_seconds: null, admin_message_id: null },
        adminText: `タイムアウト延長フロー — 最終承認: <@${state.target_id}> の **タイムアウト解除**`,
      }
    : { destination: "poll2", state: { ...state, phase: "poll2_pending", poll2_message_id: null, poll2_deadline_ms: poll2Deadline, votes_poll2: {}, resolved_extend: "extend" } },
  poll2Published: (state, messageId) => ({ ...state, poll2_message_id: messageId }),
  resolvePoll2: (state, winner) => {
    const durationSeconds = TE_POLL2_SECONDS[winner] ?? 3600;
    return {
      state: { ...state, phase: "admin_pending", resolved_extend: "extend", duration_seconds: durationSeconds, admin_message_id: null },
      adminText: `タイムアウト延長フロー — 最終承認: <@${state.target_id}> の **タイムアウト延長（${TE_POLL2_LABEL[winner] ?? winner}）**`,
    };
  },
  adminPublished: (state, messageId) => ({ ...state, admin_message_id: messageId }),
  publishPoll1: async (ctx, flowId, state) => {
    const channel = (await ctx.client.channels.fetch(state.channel_id).catch(() => null)) as TextChannel | null;
    if (!channel?.isTextBased()) {
      ctx.log.error({ flowId, phase: state.phase, guildId: timeoutExtendTargetTracker.get(flowId)?.guildId ?? "unknown" }, "timeoutExtend: vote channel unavailable");
      return { failureHeading: "タイムアウト延長フロー: 投票チャンネルを取得できませんでした" };
    }
    try {
      return await channel.send({ ...componentCardsPayload([buildPoll1Embed(state, state.poll1_deadline_ms)], tePoll1Rows(flowId, false)), allowedMentions: { users: [state.target_id] } });
    } catch (err) {
      ctx.log.error({ err, flowId, phase: state.phase }, "timeoutExtend: poll1 send failed");
      return null;
    }
  },
  publishPoll2: async (ctx, flowId, state) => {
    const channel = (await ctx.client.channels.fetch(state.channel_id).catch(() => null)) as TextChannel | null;
    if (!channel?.isTextBased()) {
      ctx.log.error({ flowId, phase: state.phase, guildId: timeoutExtendTargetTracker.get(flowId)?.guildId ?? "unknown" }, "timeoutExtend: vote channel unavailable");
      return { failureHeading: "タイムアウト延長フロー: 投票チャンネルを取得できませんでした" };
    }
    try {
      return await channel.send({ ...componentCardsPayload([buildPoll2Embed(state, state.poll2_deadline_ms!)], tePoll2Rows(flowId, false)), allowedMentions: { users: [state.target_id] } });
    } catch (err) {
      ctx.log.error({ err, flowId, phase: state.phase }, "timeoutExtend: poll2 send failed");
      return null;
    }
  },
  publishAdmin: async (ctx, flowId, state, text) => {
    const channel = (await ctx.client.channels.fetch(state.channel_id).catch(() => null)) as TextChannel | null;
    if (channel?.isTextBased()) return postTeAdminRequest(ctx, channel, flowId, text);
    ctx.log.error({ flowId, phase: state.phase, guildId: timeoutExtendTargetTracker.get(flowId)?.guildId ?? "unknown" }, "timeoutExtend: vote channel unavailable");
    return { failureHeading: "タイムアウト延長フロー: 投票チャンネルを取得できませんでした" };
  },
  disablePoll1: async (ctx, flowId, state) => {
    const channel = (await ctx.client.channels.fetch(state.channel_id).catch(() => null)) as TextChannel | null;
    if (channel?.isTextBased()) await disableTimeoutExtendPollMessage(channel, state.poll1_message_id, componentCardsPayload([buildPoll1Embed(state, state.poll1_deadline_ms, true)], tePoll1Rows(flowId, true)));
  },
  disablePoll2: async (ctx, flowId, state) => {
    const channel = (await ctx.client.channels.fetch(state.channel_id).catch(() => null)) as TextChannel | null;
    if (channel?.isTextBased()) await disableTimeoutExtendPollMessage(channel, state.poll2_message_id, componentCardsPayload([buildPoll2Embed(state, state.poll2_deadline_ms!, true)], tePoll2Rows(flowId, true)));
  },
  discardMessage: async (ctx, flowId, message, label) => {
    try { await message.delete(); } catch (err) { ctx.log.warn({ err, flowId, messageId: message.id, label }, "timeoutExtend: discard unpublished message failed"); }
  },
  stopMessages: async (ctx, flowId, state, heading) => {
    const channel = (await ctx.client.channels.fetch(state.channel_id).catch(() => null)) as TextChannel | null;
    if (!channel?.isTextBased()) return;
    await editTeMessagesStopped(ctx, channel, [
      { id: state.poll1_message_id, components: tePoll1Rows(flowId, true) },
      { id: state.poll2_message_id, components: tePoll2Rows(flowId, true) },
      { id: state.admin_message_id, components: teApprovalRows(flowId, true) },
    ], heading);
  },
  poll1Choices: TE_POLL1_KEYS,
  poll2Choices: TE_POLL2_KEYS,
  poll1Labels: TE_POLL1_LABEL,
  poll2Labels: TE_POLL2_LABEL,
  renderPoll1: (state, flowId) => componentCardsPayload([buildPoll1Embed(state, state.poll1_deadline_ms)], tePoll1Rows(flowId, false)),
  renderPoll2: (state, flowId) => componentCardsPayload([buildPoll2Embed(state, state.poll2_deadline_ms!)], tePoll2Rows(flowId, false)),
  adminPending: (state) => state.phase === "admin_pending",
  adminDeadline: (ctx, row) => teAdminWaitDeadlineMs(row.updated_at, ctx.config.TIMEOUT_EXTEND_ADMIN_WAIT_SECONDS),
  claimed: (state) => state.phase === "admin_pending" && state.admin_button_fired,
  unpublished: (state) => (state.phase === "poll1_pending" && !state.poll1_message_id)
    || (state.phase === "poll2_pending" && !state.poll2_message_id)
    || (state.phase === "admin_pending" && !state.admin_message_id),
  poll1Deadline: (state) => state.phase === "poll1_pending" ? state.poll1_deadline_ms : null,
  poll2Deadline: (state) => state.phase === "poll2_pending" ? state.poll2_deadline_ms : null,
  restoredDeadlineExpiredHeading: "タイムアウト延長フロー: 再起動後の復元時に期限切れを検出",
  adminTimeoutHeading: "タイムアウト延長フロー: 承認がタイムアウトしました",
  duplicateTargetHeading: "タイムアウト延長フロー: 同一対象の重複フローを中止しました",
  unpublishedHeading: "タイムアウト延長フロー: 再起動後に未公開の遷移を中止しました",
  poll1NoWinnerHeading: "タイムアウト延長フロー: 投票の最多票が確定しませんでした",
  poll2NoWinnerHeading: "タイムアウト延長フロー: 延長時間の最多票が確定しませんでした",
  poll1PublishFailureHeading: "タイムアウト延長フロー: 投票メッセージの送信に失敗しました",
  poll2PublishFailureHeading: "タイムアウト延長フロー: 延長時間投票の送信に失敗しました",
  adminPublishFailureHeading: "タイムアウト延長フロー: 最終承認メッセージの送信に失敗しました",
});

async function resolveVoteTextChannel(
  ctx: BotContext,
  guild: Guild,
  interaction: ChatInputCommandInteraction,
): Promise<TextChannel | null> {
  const configured = ctx.config.TIMEOUT_EXTEND_VOTE_CHANNEL_ID?.trim();
  if (configured) {
    const ch = await guild.channels.fetch(configured).catch(() => null);
    if (ch?.isTextBased() && !ch.isDMBased()) return ch as TextChannel;
    return null;
  }
  const ch = interaction.channel;
  if (ch?.isTextBased() && !ch.isDMBased()) return ch as TextChannel;
  return null;
}

async function applyTimeoutResolution(
  guild: Guild,
  targetId: string,
  resolved: "extend" | "release",
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
    if (resolved === "release") {
      await member.timeout(null, reason);
      return { ok: true };
    }
    const addSec = durationSeconds ?? 3600;
    const now = Date.now();
    const curUntil = member.communicationDisabledUntil?.getTime() ?? now;
    const base = Math.max(now, curUntil);
    const newUntil = base + addSec * 1000;
    let ms = newUntil - now;
    if (!Number.isFinite(ms) || ms <= 0) ms = 60_000;
    ms = clampTimeoutMs(ms);
    await member.timeout(ms, reason);
    return { ok: true };
  } catch (err) {
    ctx.log.warn({ err, targetId, resolved }, "timeoutExtend: apply failed");
    if (err instanceof DiscordAPIError) {
      return { ok: false, message: `Discord API: ${err.message}` };
    }
    return { ok: false, message: String(err) };
  }
}

export async function startTimeoutExtendFlow(
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

  const until = targetMember.communicationDisabledUntil;
  if (!until || until.getTime() <= Date.now()) {
    await interaction.editReply({ content: "対象は現在有効なタイムアウト状態ではありません。" });
    return;
  }

  const voteChannel = await resolveVoteTextChannel(ctx, guild, interaction);
  if (!voteChannel) {
    await interaction.editReply({
      content: ctx.config.TIMEOUT_EXTEND_VOTE_CHANNEL_ID?.trim()
        ? "投票投稿先チャンネル（TIMEOUT_EXTEND_VOTE_CHANNEL_ID）を取得できませんでした。"
        : "このチャンネルでは実行できません。",
    });
    return;
  }

  const flowId = randomUUID();
  if (!retainTimeoutExtendTarget(flowId, guild.id, targetUser.id)) {
    await interaction.editReply({ content: "この対象では既にタイムアウト延長フローが進行中です。" });
    return;
  }

  const baseState: TimeoutExtendFlowState = {
    phase: "poll1_pending",
    invoker_id: interaction.user.id,
    target_id: targetUser.id,
    channel_id: voteChannel.id,
    poll1_message_id: null,
    poll1_publish_reserved: false,
    poll2_message_id: null,
    admin_message_id: null,
    votes_poll1: {},
    votes_poll2: {},
    poll1_deadline_ms: 0,
    poll2_deadline_ms: null,
    resolved_extend: null,
    duration_seconds: null,
    admin_button_fired: false,
  };

  try {
    await ctx.db
      .insertInto("polls")
      .values({
        id: flowId,
        guild_id: guild.id,
        channel_id: voteChannel.id,
        message_id: null,
        kind: TIMEOUT_EXTEND_FLOW_KIND,
        status: "open",
        state: JSON.stringify(baseState) as unknown as Record<string, unknown>,
        ends_at: null,
        created_at: nowIso() as unknown as Date,
        updated_at: nowIso() as unknown as Date,
        state_revision: 0,
      })
      .execute();
  } catch (err) {
    releaseTimeoutExtendTarget(flowId);
    ctx.log.error({ err, flowId, guildId: guild.id, phase: baseState.phase }, "timeoutExtend: create flow failed");
    await interaction.editReply({ content: "フローの開始に失敗しました。" });
    return;
  }

  try {
    const started = await timeoutExtendOrchestrator.beginPoll1(ctx, flowId, baseState, guild.id);
    if (!started) {
      releaseTimeoutExtendTarget(flowId);
      await interaction.editReply({ content: "投票チャンネルを取得できなかったため、フローを開始できませんでした。" });
      return;
    }
  } catch (err) {
    releaseTimeoutExtendTarget(flowId);
    await ctx.db.deleteFrom("polls").where("id", "=", flowId).execute().catch(() => undefined);
    ctx.log.error({ err, flowId, phase: baseState.phase, guildId: guild.id }, "timeoutExtend: begin failed");
    await interaction.editReply({ content: "フローの開始に失敗しました。" });
    return;
  }

  await interaction.editReply({
    content: `タイムアウト延長の投票を開始しました（投稿先: <#${voteChannel.id}>）。`,
  });
}

function buildResolvedDetailJa(state: TimeoutExtendFlowState): string {
  const r = state.resolved_extend;
  if (r === "release") return "タイムアウト解除";
  const sec = state.duration_seconds;
  return sec == null ? "タイムアウト延長" : `タイムアウト延長（${durationLabelJa(sec)}）`;
}

async function notifyTimeoutExtendDenied(
  ctx: BotContext,
  interaction: ButtonInteraction,
  current: OpenPollFlow<TimeoutExtendFlowState>,
  approverId: string,
): Promise<void> {
  try {
    await (interaction.channel as TextChannel).send({ content: "タイムアウト延長フローが非承認されたため、中止します。" });
  } catch (err) {
    ctx.log.warn({ err, flowId: current.id, phase: current.state.phase, guildId: current.guildId }, "timeoutExtend: abort message failed");
  }
  ctx.log.info({ flowId: current.id, approverId, phase: current.state.phase, guildId: current.guildId }, "timeoutExtend: final deny");
}

async function cleanupTimeoutExtendApproval(
  ctx: BotContext,
  interaction: ButtonInteraction,
  state: TimeoutExtendFlowState,
  label: "approve" | "deny",
): Promise<void> {
  const ids = [state.poll1_message_id, state.poll2_message_id, state.admin_message_id]
    .filter((id): id is string => Boolean(id));
  await deleteTeFlowMessagesQuietly(ctx, interaction.channel as TextChannel, ids, label);
}

async function executeApprovedTimeoutExtend(
  ctx: BotContext,
  interaction: ButtonInteraction,
  current: OpenPollFlow<TimeoutExtendFlowState>,
  approverId: string,
): Promise<{ ok: boolean }> {
  const state = current.state;
  const resolved = state.resolved_extend;
  if ((resolved !== "extend" && resolved !== "release") || !interaction.guild) return { ok: false };
  const result = await applyTimeoutResolution(
    interaction.guild,
    state.target_id,
    resolved,
    state.duration_seconds,
    buildTimeoutExtendAuditReason(approverId, buildResolvedDetailJa(state)),
    ctx,
  );
  const channel = interaction.channel as TextChannel;
  if (result.ok) {
    const line = resolved === "release"
      ? `# <@${state.target_id}> のタイムアウトを **解除** しました`
      : `# <@${state.target_id}> のタイムアウトを **延長** しました（${durationLabelJa(state.duration_seconds)}）`;
    try {
      await channel.send({ content: line, allowedMentions: { users: [state.target_id] } });
    } catch (err) {
      ctx.log.warn({ err, flowId: current.id, phase: state.phase, guildId: current.guildId }, "timeoutExtend: result message failed");
    }
  } else {
    try {
      await channel.send({ content: `タイムアウト処理の実行に失敗しました: ${result.message}` });
    } catch (err) {
      ctx.log.warn({ err, flowId: current.id, phase: state.phase, guildId: current.guildId }, "timeoutExtend: error message failed");
    }
  }
  return { ok: result.ok };
}

export async function handleTimeoutExtendFlowButton(interaction: ButtonInteraction, ctx: BotContext): Promise<boolean> {
  if (interaction.customId.startsWith(TE_VOTE_PREFIX)) {
    return timeoutExtendOrchestrator.handleVote(interaction, ctx);
  }
  if (interaction.customId.startsWith(TE_APPROVAL_PREFIX)) {
    return timeoutExtendOrchestrator.handleApproval(interaction, ctx);
  }
  return false;
}
