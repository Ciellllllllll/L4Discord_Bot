import { componentCardsPayload } from "../../core/componentCard.js";
import { isAdmin } from "../../core/permission.js";
import {
  type Message,
  type TextChannel,
} from "discord.js";
import {
  TE_APPROVAL_PREFIX,
  TE_VOTE_PREFIX,
  TE_POLL1_KEYS,
  TE_POLL1_LABEL,
  TE_POLL2_KEYS,
  TE_POLL2_LABEL,
  TE_POLL2_SECONDS,
  TIMEOUT_EXTEND_FLOW_KIND,
} from "./timeoutExtendConstants.js";
import { parseTimeoutExtendFlowState, type TimeoutExtendFlowState } from "./timeoutExtendFlow.types.js";
import {
  disablePollMessage,
  postPollAdminRequest,
} from "./pollFlowHelpers.js";
import { parsePersistedFlowState } from "./twoStagePollTally.js";
import { createTwoStagePollRuntime } from "./twoStagePollRuntime.js";
import {
  retainTimeoutExtendTarget,
  releaseTimeoutExtendTarget,
  timeoutExtendTargetTracker,
  timeoutExtendTimers,
  teAdminWaitDeadlineMs,
  type TimeoutExtendFlowDeps,
  type OpenTimeoutExtendFlowRow,
} from "./timeoutExtendFlowCore.js";
import {
  buildResolvedDetailJa,
  cleanupTimeoutExtendApproval,
  executeApprovedTimeoutExtend,
  notifyTimeoutExtendDenied,
} from "./timeoutExtendFlowPunishment.js";
import {
  buildPoll1Embed,
  buildPoll2Embed,
  editTeMessagesStopped,
  tePoll1Rows,
  tePoll2Rows,
  teApprovalRows,
} from "./timeoutExtendFlowRender.js";

// タイムアウト延長フローのランタイム組み立てと状態遷移。

export async function shutdownTimeoutExtendFlowRuntime(): Promise<void> {
  await timeoutExtendOrchestrator.shutdown();
}

export async function abortTeFlow(
  ctx: TimeoutExtendFlowDeps,
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

export async function reconcileTimeoutExtendFlows(ctx: TimeoutExtendFlowDeps): Promise<void> {
  await timeoutExtendOrchestrator.reconcile(ctx);
}

async function postTeAdminRequest(ctx: TimeoutExtendFlowDeps, channel: TextChannel, flowId: string, body: string): Promise<Message | null> {
  return postPollAdminRequest(ctx, channel, flowId, body, teApprovalRows(flowId, false), "timeoutExtend");
}

async function disableTimeoutExtendPollMessage(
  channel: TextChannel,
  messageId: string | null,
  payload: ReturnType<typeof componentCardsPayload>,
): Promise<void> {
  await disablePollMessage(channel, messageId, payload);
}

export function beginTePoll1(ctx: TimeoutExtendFlowDeps, flowId: string, guildId: string, state: TimeoutExtendFlowState): Promise<boolean> {
  return timeoutExtendOrchestrator.beginPoll1(ctx, flowId, state, guildId);
}
export function transitionTePoll1ToNext(ctx: TimeoutExtendFlowDeps, flowId: string, guildId: string): Promise<void> {
  return timeoutExtendOrchestrator.transitionPoll1(ctx, flowId, guildId);
}

export function transitionTePoll2ToAdmin(ctx: TimeoutExtendFlowDeps, flowId: string, guildId: string): Promise<void> {
  return timeoutExtendOrchestrator.transitionPoll2(ctx, flowId, guildId);
}
export const timeoutExtendOrchestrator = createTwoStagePollRuntime<TimeoutExtendFlowDeps, TimeoutExtendFlowState, (typeof TE_POLL1_KEYS)[number], (typeof TE_POLL2_KEYS)[number]>({
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
