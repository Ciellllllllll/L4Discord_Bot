import { componentCardsPayload } from "../../core/componentCard.js";
import { isAdmin } from "../../core/permission.js";
import {
  type Message,
  type TextChannel,
} from "discord.js";
import {
  EXECUTION_FLOW_KIND,
  EXEC_APPROVAL_PREFIX,
  EXEC_VOTE_PREFIX,
  POLL1_KEYS,
  POLL1_LABEL,
  POLL2_CHOICE_TO_SECONDS,
  POLL2_KEYS,
  POLL2_LABEL,
} from "./executionConstants.js";
import { parseExecutionFlowState, type ExecutionFlowState } from "./executionFlow.types.js";
import {
  adminWaitDeadlineMs,
  createFlowTargetTracker,
  disablePollMessage,
  findOpenPollFlowById,
  postPollAdminRequest,
} from "./pollFlowHelpers.js";
import { parsePersistedFlowState } from "./twoStagePollTally.js";
import { createTwoStagePollRuntime } from "./twoStagePollRuntime.js";
import {
  executionTimers,
  saveFullState,
  timerKey,
  type ExecutionFlowDeps,
  type OpenExecutionFlowRow,
} from "./executionFlowCore.js";
import {
  approvalRows,
  buildPoll1Embed,
  buildPoll2Embed,
  choiceToAction1,
  editMessagesStopped,
  poll1Rows,
  poll2Rows,
} from "./executionFlowRender.js";
import {
  cleanupExecutionApproval,
  executeApprovedExecution,
  handleExecutionPrecheckApproval,
  notifyExecutionDenied,
} from "./executionFlowPunishment.js";

// 処刑フローのランタイム組み立てと状態遷移の入口。

const executionTargetTracker = createFlowTargetTracker("execution");

export function retainExecutionTarget(flowId: string, guildId: string, targetId: string): boolean {
  return executionTargetTracker.retain(flowId, guildId, targetId);
}

export function releaseExecutionTarget(flowId: string): void {
  executionTargetTracker.release(flowId);
}

export async function shutdownExecutionFlowRuntime(): Promise<void> {
  await executionOrchestrator.shutdown();
}

export async function findOpenExecutionFlowById(
  ctx: ExecutionFlowDeps,
  flowId: string,
): Promise<{ row: OpenExecutionFlowRow; state: ExecutionFlowState } | null> {
  return findOpenPollFlowById(ctx, flowId, EXECUTION_FLOW_KIND, parseExecutionFlowState, "execution");
}

export async function abortFlow(
  ctx: ExecutionFlowDeps,
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

export function scheduleAdminWait(
  ctx: ExecutionFlowDeps,
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

export async function reconcileExecutionFlows(ctx: ExecutionFlowDeps): Promise<void> {
  await executionOrchestrator.reconcile(ctx);
}

async function postPrecheckRequest(ctx: ExecutionFlowDeps, channel: TextChannel, flowId: string): Promise<Message | null> {
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

async function postAdminRequest(ctx: ExecutionFlowDeps, channel: TextChannel, flowId: string, body: string): Promise<Message | null> {
  return postPollAdminRequest(ctx, channel, flowId, body, approvalRows(flowId, false), "execution");
}

async function disableExecutionPollMessage(
  channel: TextChannel,
  messageId: string | null,
  payload: ReturnType<typeof componentCardsPayload>,
): Promise<void> {
  await disablePollMessage(channel, messageId, payload);
}

export function beginPoll1(ctx: ExecutionFlowDeps, flowId: string, state: ExecutionFlowState): Promise<boolean> {
  return executionOrchestrator.beginPoll1(ctx, flowId, state, executionTargetTracker.get(flowId)?.guildId);
}
/** 初回の事前承認投稿は、Discord APIの副作用より先にCAS予約を確定する。 */
export async function beginInitialPrecheck(
  ctx: ExecutionFlowDeps,
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

export function transitionPoll1ToNext(ctx: ExecutionFlowDeps, flowId: string): Promise<void> {
  return executionOrchestrator.transitionPoll1(ctx, flowId, executionTargetTracker.get(flowId)?.guildId ?? "unknown");
}

export function transitionPoll2ToAdmin(ctx: ExecutionFlowDeps, flowId: string): Promise<void> {
  return executionOrchestrator.transitionPoll2(ctx, flowId, executionTargetTracker.get(flowId)?.guildId ?? "unknown");
}
export const executionOrchestrator = createTwoStagePollRuntime<ExecutionFlowDeps, ExecutionFlowState, (typeof POLL1_KEYS)[number], (typeof POLL2_KEYS)[number]>({
  namespace: "execution",
  kind: EXECUTION_FLOW_KIND,
  votePrefix: EXEC_VOTE_PREFIX,
  approvalPrefix: EXEC_APPROVAL_PREFIX,
  timers: executionTimers,
  parse: (value) => parsePersistedFlowState(value, parseExecutionFlowState),
  targetId: (state) => state.target_id,
  retainTarget: retainExecutionTarget,
  releaseTarget: releaseExecutionTarget,
  releaseAllTargets: () => executionTargetTracker.releaseAll(),
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
      ctx.log.error({ flowId, phase: state.phase, guildId: executionTargetTracker.get(flowId)?.guildId ?? "unknown" }, "execution: vote channel unavailable");
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
      ctx.log.error({ flowId, phase: state.phase, guildId: executionTargetTracker.get(flowId)?.guildId ?? "unknown" }, "execution: vote channel unavailable");
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
    ctx.log.error({ flowId, phase: state.phase, guildId: executionTargetTracker.get(flowId)?.guildId ?? "unknown" }, "execution: vote channel unavailable");
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
