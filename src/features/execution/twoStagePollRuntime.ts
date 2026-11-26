import { MessageFlags, type ButtonInteraction, type GuildMember, type TextChannel } from "discord.js";
import {
  type OpenPollFlow,
  PollFlowStateStore,
  claimPollAdminApproval,
  remainingDeadlineDelayMs,
  saveOpenPollState,
} from "./flowLifecycle.js";
import { nowIso } from "../../core/db/nowIso.js";
import type {
  FlowRuntimeRow,
  PublishedPollMessage,
  TwoStagePollContext,
  TwoStagePollRuntimeSpec,
  TwoStagePollState,
} from "./twoStagePollRuntime.types.js";
import {
  type TwoStageControls,
  abortExpected as abortExpectedImpl,
  abortOpen as abortOpenImpl,
  commitClaimedTerminal as commitClaimedTerminalImpl,
  discardAndAbortUnpublished as discardAndAbortUnpublishedImpl,
  findStoredOpen as findStoredOpenImpl,
  listOpenRows as listOpenRowsImpl,
  persistPublished as persistPublishedImpl,
  transitionPoll1Open as transitionPoll1OpenImpl,
  transitionPoll2Open as transitionPoll2OpenImpl,
} from "./twoStagePollPersistence.js";

/** 二段階投票の復元、期限タイマー、公開操作を一つのランタイムへ束ねる。 */
export function createTwoStagePollRuntime<
  Context extends TwoStagePollContext,
  State extends TwoStagePollState<Poll1Choice, Poll2Choice>,
  Poll1Choice extends string = string,
  Poll2Choice extends string = string,
>(spec: TwoStagePollRuntimeSpec<Context, State, Poll1Choice, Poll2Choice>) {
  const flowTaskQueues = new Map<string, Promise<void>>();
  const inFlightOperations = new Set<Promise<void>>();
  let closed = false;
  let shutdownPromise: Promise<void> | null = null;
  const timerKey = (phase: "poll1" | "poll2" | "admin" | "compensation", flowId: string): string => `${phase}:${flowId}`;
  const clearTimers = (flowId: string): void => {
    spec.timers.clear(timerKey("poll1", flowId));
    spec.timers.clear(timerKey("poll2", flowId));
    spec.timers.clear(timerKey("admin", flowId));
    spec.timers.clear(timerKey("compensation", flowId));
  };

  const enqueueFlowTask = (flowId: string, task: () => Promise<void>): Promise<void> => {
    const prior = flowTaskQueues.get(flowId) ?? Promise.resolve();
    const queued = prior.catch(() => undefined).then(task);
    flowTaskQueues.set(flowId, queued);
    void queued.finally(() => {
      if (flowTaskQueues.get(flowId) === queued) flowTaskQueues.delete(flowId);
    }).catch(() => undefined);
    return queued;
  };

  const runTransition = (flowId: string, transition: () => Promise<void>): void => {
    if (closed) return;
    void enqueueFlowTask(flowId, transition);
  };

  const runPublicOperation = <T>(fallback: T, operation: () => Promise<T>): Promise<T> => {
    if (closed) return Promise.resolve(fallback);
    const running = operation();
    const completion = running.then(() => undefined, () => undefined);
    inFlightOperations.add(completion);
    void completion.finally(() => inFlightOperations.delete(completion));
    return running;
  };

  const schedule = (
    ctx: Context,
    phase: "poll1" | "poll2",
    flowId: string,
    guildId: string,
    delayMs: number,
    transition: () => Promise<void>,
  ): void => {
    if (closed) return;
    spec.timers.schedule(timerKey(phase, flowId), delayMs, () => {
      runTransition(flowId, async () => {
        try {
          await transition();
        } catch (err) {
          ctx.log.error({ err, flowId, guildId, phase }, `${spec.namespace}: ${phase} finalize failed`);
        }
      });
    });
  };

  const schedulePoll1 = (ctx: Context, flowId: string, guildId: string, delayMs: number): void => {
    schedule(ctx, "poll1", flowId, guildId, delayMs, () => transitionPoll1Open(ctx, flowId, guildId));
  };

  const schedulePoll2 = (ctx: Context, flowId: string, guildId: string, delayMs: number): void => {
    schedule(ctx, "poll2", flowId, guildId, delayMs, () => transitionPoll2Open(ctx, flowId, guildId));
  };

  const scheduleAdmin = (ctx: Context, flowId: string, guildId: string, delayMs: number): void => {
    if (closed) return;
    spec.timers.schedule(timerKey("admin", flowId), delayMs, () => {
      runTransition(flowId, async () => {
        try {
          const found = await findStoredOpen(ctx, flowId);
          if (!found || !spec.adminPending(found.state) || spec.claimed(found.state)) return;
          ctx.log.warn({ flowId, guildId: found.guildId, phase: found.state.phase }, `${spec.namespace}: admin wait timeout`);
          await abortOpen(ctx, flowId, found.state, spec.adminTimeoutHeading, found.guildId);
        } catch (err) {
          ctx.log.error({ err, flowId, guildId, phase: "admin_pending" }, `${spec.namespace}: admin timeout handler failed`);
        }
      });
    });
  };


  // 状態保存・公開・状態遷移は twoStagePollPersistence.ts にある。spec と閉じ込めた状態を束ねた
  // controls を渡す委譲だけを残す。
  const discardAndAbortUnpublished = async (
    ctx: Context,
    flowId: string,
    message: PublishedPollMessage,
    label: string,
    heading: string,
    guildId: string,
    isSameReservation: (state: State) => boolean,
  ): Promise<void> => discardAndAbortUnpublishedImpl(spec, ctx, controls, flowId, message, label, heading, guildId, isSameReservation);
  const controls: TwoStageControls<Context, State> = {
    closed: () => closed,
    timerKey,
    clearTimers,
    runTransition,
    schedulePoll1,
    schedulePoll2,
    scheduleAdmin,
    discardAndAbortUnpublished,
  };
  const transitionPoll1Open = (ctx: Context, flowId: string, guildId: string): Promise<void> => transitionPoll1OpenImpl(spec, ctx, controls, flowId, guildId);
  const transitionPoll2Open = (ctx: Context, flowId: string, guildId: string): Promise<void> => transitionPoll2OpenImpl(spec, ctx, controls, flowId, guildId);
  // 状態保存まわりの委譲。
  const findStoredOpen = (ctx: Context, flowId: string): Promise<OpenPollFlow<State> | null> => findStoredOpenImpl(spec, ctx, flowId);
  const listOpenRows = (ctx: Context): Promise<FlowRuntimeRow[]> => listOpenRowsImpl(spec, ctx);
  const persistPublished = async (
    ctx: Context,
    flowId: string,
    messageId: string | null,
    isSameReservation: (state: State) => boolean,
    published: (state: State) => State,
  ): Promise<boolean> => persistPublishedImpl(spec, ctx, flowId, messageId, isSameReservation, published);
  const abortOpen = (
    ctx: Context,
    flowId: string,
    state: State,
    heading: string,
    guildId = "unknown",
    expected?: OpenPollFlow<State>,
  ): Promise<boolean> => abortOpenImpl(spec, ctx, clearTimers, flowId, state, heading, guildId, expected);
  const abortExpected = (
    ctx: Context,
    flowId: string,
    current: OpenPollFlow<State>,
    heading: string,
    guildId: string,
  ): Promise<boolean> => abortExpectedImpl(spec, ctx, clearTimers, flowId, current, heading, guildId);
  const commitClaimedTerminal = (
    ctx: Context,
    current: OpenPollFlow<State>,
    terminalPhase: "completed" | "cancelled",
  ): Promise<boolean> => commitClaimedTerminalImpl(spec, ctx, clearTimers, current, terminalPhase);


  const beginPoll1Open = async (ctx: Context, flowId: string, state: State, guildId = "unknown"): Promise<boolean> => {
    const voteMs = spec.voteDurationMs(ctx);
    const deadline = Date.now() + voteMs;
    const pending = spec.toPoll1Pending(state, deadline);
    const saved = await saveOpenPollState({
      store: new PollFlowStateStore(ctx.db), id: flowId, kind: spec.kind, parse: spec.parse,
      nextState: pending, messageId: null,
    });
    if (!saved) return false;

    const publication = await spec.publishPoll1(ctx, flowId, pending);
    const message = publication && "id" in publication ? publication : null;
    if (!message) {
      const current = await findStoredOpen(ctx, flowId);
      if (current?.state.phase === "poll1_pending") {
        const heading = publication && "failureHeading" in publication ? publication.failureHeading : spec.poll1PublishFailureHeading;
        await abortExpected(ctx, flowId, current, heading, current.guildId);
      }
      return false;
    }
    const sameReservation = (candidate: State) => candidate.phase === "poll1_pending"
      && candidate.poll1_message_id === null
      && candidate.poll1_deadline_ms === pending.poll1_deadline_ms;
    if (!await persistPublished(ctx, flowId, message.id, sameReservation, (current) => spec.poll1Published(current, message.id))) {
      await discardAndAbortUnpublished(ctx, flowId, message, "poll1 publication CAS lost", spec.poll1PublishFailureHeading, guildId, sameReservation);
      return false;
    }
    schedulePoll1(ctx, flowId, guildId, voteMs);
    return true;
  };

  const reconcileOpen = async (ctx: Context, now = Date.now()): Promise<void> => {
    const rows = await listOpenRows(ctx);
    spec.releaseAllTargets();
    for (const row of rows) {
      clearTimers(row.id);
      const state = spec.parse(row.state);
      if (!state) {
        ctx.log.warn({ flowId: row.id, guildId: row.guild_id, phase: "invalid" }, `${spec.namespace}: cancelling malformed open flow`);
        await ctx.db.updateTable("polls").set({
          status: "cancelled",
          updated_at: nowIso() as unknown as Date,
        }).where("id", "=", row.id).where("status", "=", "open").execute();
        continue;
      }
      if (state.phase === "completed" || state.phase === "cancelled") {
        spec.releaseTarget(row.id);
        await ctx.db.updateTable("polls").set({
          status: state.phase === "completed" ? "completed" : "cancelled",
          updated_at: nowIso() as unknown as Date,
        }).where("id", "=", row.id).where("status", "=", "open").execute();
        continue;
      }
      if (!spec.retainTarget(row.id, row.guild_id, spec.targetId(state))) {
        ctx.log.warn({ flowId: row.id, guildId: row.guild_id, phase: state.phase }, `${spec.namespace}: duplicate restored target lock`);
        await abortOpen(ctx, row.id, state, spec.duplicateTargetHeading, row.guild_id);
        continue;
      }
      if (spec.claimed(state)) {
        ctx.log.warn({ flowId: row.id, guildId: row.guild_id, phase: state.phase }, `${spec.namespace}: claimed flow requires manual recovery after restart`);
        continue;
      }
      if (spec.unpublished(state)) {
        ctx.log.warn({ flowId: row.id, guildId: row.guild_id, phase: state.phase }, `${spec.namespace}: cancelling unpublished transition after restart`);
        await abortOpen(ctx, row.id, state, spec.unpublishedHeading, row.guild_id);
        continue;
      }
      if (spec.adminPending(state)) {
        const delayMs = remainingDeadlineDelayMs(spec.adminDeadline(ctx, row, state), now);
        if (delayMs <= 0) await abortOpen(ctx, row.id, state, spec.restoredDeadlineExpiredHeading, row.guild_id);
        else scheduleAdmin(ctx, row.id, row.guild_id, delayMs);
        continue;
      }
      const poll1Deadline = spec.poll1Deadline(state);
      if (poll1Deadline !== null) {
        const delayMs = remainingDeadlineDelayMs(poll1Deadline, now);
        if (delayMs <= 0) await enqueueFlowTask(row.id, () => transitionPoll1Open(ctx, row.id, row.guild_id));
        else schedulePoll1(ctx, row.id, row.guild_id, delayMs);
        continue;
      }
      const poll2Deadline = spec.poll2Deadline(state);
      if (poll2Deadline !== null) {
        const delayMs = remainingDeadlineDelayMs(poll2Deadline, now);
        if (delayMs <= 0) await enqueueFlowTask(row.id, () => transitionPoll2Open(ctx, row.id, row.guild_id));
        else schedulePoll2(ctx, row.id, row.guild_id, delayMs);
      }
    }
  };

  const handleVoteOpen = async (interaction: ButtonInteraction, ctx: Context): Promise<boolean> => {
    if (!interaction.customId.startsWith(spec.votePrefix)) return false;
    const rest = interaction.customId.slice(spec.votePrefix.length);
    const separator = rest.lastIndexOf(":");
    if (separator <= 0) return false;
    const flowId = rest.slice(0, separator);
    const choice = rest.slice(separator + 1);

    if (interaction.user.bot) {
      await interaction.reply({ content: "BOT は投票できません。", flags: MessageFlags.Ephemeral });
      return true;
    }

    const found = await findStoredOpen(ctx, flowId);
    if (!found) {
      await interaction.reply({ content: "この投票は終了しているか、無効です。", flags: MessageFlags.Ephemeral });
      return true;
    }
    const state = found.state;
    if (interaction.channelId !== state.channel_id || interaction.guildId !== found.guildId) {
      await interaction.reply({ content: "このチャンネルでは投票できません。", flags: MessageFlags.Ephemeral });
      return true;
    }

    const phase = state.phase === "poll1_pending" ? "poll1" : state.phase === "poll2_pending" ? "poll2" : null;
    if (!phase) {
      await interaction.reply({ content: "この投票は終了しています。", flags: MessageFlags.Ephemeral });
      return true;
    }
    const choices = phase === "poll1" ? spec.poll1Choices : spec.poll2Choices;
    if (!choices.includes(choice as never)) {
      await interaction.reply({ content: "無効な選択です。", flags: MessageFlags.Ephemeral });
      return true;
    }
    const deadline = phase === "poll1" ? state.poll1_deadline_ms : state.poll2_deadline_ms;
    if (deadline == null || Date.now() > deadline) {
      await interaction.reply({ content: "締切を過ぎています。", flags: MessageFlags.Ephemeral });
      return true;
    }

    const userId = interaction.user.id;
    let previous: Poll1Choice | Poll2Choice | undefined;
    const next = await new PollFlowStateStore(ctx.db).mergeVoteWithRetry({
      id: flowId,
      kind: spec.kind,
      expectedPhase: `${phase}_pending`,
      parse: spec.parse,
      canMerge: (latest) => {
        const candidate = latest as typeof state;
        const latestDeadline = phase === "poll1" ? candidate.poll1_deadline_ms : candidate.poll2_deadline_ms;
        return latestDeadline != null && Date.now() <= latestDeadline;
      },
      merge: (latest) => {
        const candidate = latest;
        previous = phase === "poll1" ? candidate.votes_poll1[userId] : candidate.votes_poll2[userId];
        return {
          ...candidate,
          ...(phase === "poll1"
            ? { votes_poll1: { ...candidate.votes_poll1, [userId]: choice as Poll1Choice } }
            : { votes_poll2: { ...candidate.votes_poll2, [userId]: choice as Poll2Choice } }),
        } as State;
      },
      messageId: (latest) => phase === "poll1"
        ? (latest as typeof state).poll1_message_id
        : (latest as typeof state).poll2_message_id,
    });
    if (!next) {
      await interaction.reply({ content: "投票状態が更新されたため、もう一度投票してください。", flags: MessageFlags.Ephemeral });
      return true;
    }

    const label = phase === "poll1"
      ? spec.poll1Labels[choice as Poll1Choice]
      : spec.poll2Labels[choice as Poll2Choice];
    const text = previous === undefined
      ? "投票しました。"
      : previous === choice
        ? `既に投票先は ${label ?? choice} です。`
        : `投票先を ${label ?? choice} に変更しました。`;
    await interaction.reply({ content: text, flags: MessageFlags.Ephemeral });
    if (closed) return true;

    const render = phase === "poll1" ? spec.renderPoll1 : spec.renderPoll2;
    const channel = interaction.channel;
    if (render && channel?.isTextBased() && !channel.isDMBased()) {
      const task = enqueueFlowTask(flowId, async () => {
        const latest = await findStoredOpen(ctx, flowId);
        if (!latest || latest.state.phase !== `${phase}_pending`) return;
        const latestState = latest.state;
        const messageId = phase === "poll1" ? latestState.poll1_message_id : latestState.poll2_message_id;
        if (!messageId) return;
        const message = await (channel as TextChannel).messages.fetch(messageId);
        await message.edit(render(latest.state, flowId));
      });
      try {
        await task;
      } catch (err) {
        ctx.log.warn({ err, flowId, phase: state.phase, guildId: found.guildId }, `${spec.namespace}: ${phase} edit failed`);
      }
    }
    return true;
  };

  const handleVote = (interaction: ButtonInteraction, ctx: Context): Promise<boolean> =>
    runPublicOperation(false, () => handleVoteOpen(interaction, ctx));

  const handleApprovalOpen = async (interaction: ButtonInteraction, ctx: Context): Promise<boolean> => {
    if (!interaction.customId.startsWith(spec.approvalPrefix)) return false;
    const rest = interaction.customId.slice(spec.approvalPrefix.length);
    const separator = rest.lastIndexOf(":");
    if (separator <= 0) return false;
    const flowId = rest.slice(0, separator);
    const action = rest.slice(separator + 1);
    if (action !== "approve" && action !== "deny") return false;

    const current = await findStoredOpen(ctx, flowId);
    if (!current) {
      await interaction.reply({ content: "このフローは期限切れか、既に処理済みです。", flags: MessageFlags.Ephemeral });
      return true;
    }
    const guild = interaction.guild;
    if (!guild || interaction.channelId !== current.state.channel_id || interaction.guildId !== current.guildId) {
      await interaction.reply({ content: "このチャンネルでは操作できません。", flags: MessageFlags.Ephemeral });
      return true;
    }

    let operator: GuildMember;
    try {
      operator = await guild.members.fetch(interaction.user.id);
    } catch {
      await interaction.reply({ content: "メンバー情報を取得できませんでした。", flags: MessageFlags.Ephemeral });
      return true;
    }
    if (!spec.isAdmin(ctx, operator)) {
      await interaction.reply({ content: "管理者のみ操作できます。", flags: MessageFlags.Ephemeral });
      return true;
    }

    if (current.state.phase !== "admin_pending") {
      if (spec.handleOtherApproval && await spec.handleOtherApproval(interaction, ctx, current, action, {
        abort: (heading) => abortOpen(ctx, flowId, current.state, heading, current.guildId, current),
        beginPoll1: (state) => beginPoll1Open(ctx, flowId, state, current.guildId),
      })) return true;
      await interaction.reply({ content: "このフローはこの操作の段階ではありません。", flags: MessageFlags.Ephemeral });
      return true;
    }
    if (current.state.admin_button_fired) {
      await interaction.reply({ content: "すでに処理済みです。", flags: MessageFlags.Ephemeral });
      return true;
    }

    let claimed: boolean;
    try {
      claimed = await claimPollAdminApproval({
        store: new PollFlowStateStore(ctx.db),
        id: current.id,
        state: current.state,
        stateRevision: current.stateRevision,
        rawState: current.rawState,
      });
    } catch (err) {
      ctx.log.error({ err, flowId, phase: current.state.phase, guildId: current.guildId }, `${spec.namespace}: approval claim failed`);
      await interaction.reply({ content: "状態の保存に失敗しました。再試行してください。", flags: MessageFlags.Ephemeral });
      return true;
    }
    if (!claimed) {
      await interaction.reply({ content: "すでに処理済みです。", flags: MessageFlags.Ephemeral });
      return true;
    }

    const finish = async (terminalPhase: "completed" | "cancelled"): Promise<boolean> => {
      if (await commitClaimedTerminal(ctx, current, terminalPhase)) return true;
      await interaction.reply({ content: "状態の保存に失敗しました。再試行してください。", flags: MessageFlags.Ephemeral });
      return false;
    };
    if (action === "deny") {
      if (!await finish("cancelled")) return true;
      await interaction.update({ components: spec.approvalComponents(flowId) }).catch(() => undefined);
      await spec.notifyDenied(ctx, interaction, current, interaction.user.id);
      await spec.cleanupFinal(ctx, interaction, current.state, "deny");
      return true;
    }
    if (!spec.canExecuteFinal(current.state)) {
      if (await finish("cancelled")) {
        await interaction.update({ components: spec.approvalComponents(flowId) }).catch(() => undefined);
      }
      return true;
    }

    const result = await spec.executeFinal(ctx, interaction, current, interaction.user.id);
    if (!await finish(result.ok ? "completed" : "cancelled")) return true;
    await interaction.update({ components: spec.approvalComponents(flowId) }).catch(() => undefined);
    await spec.cleanupFinal(ctx, interaction, current.state, "approve");
    spec.afterApproved(ctx, current, interaction.user.id, result);
    return true;
  };

  return {
    shutdown(): Promise<void> {
      shutdownPromise ??= (async () => {
        closed = true;
        spec.timers.clearAll();
        await Promise.allSettled(inFlightOperations);
        await Promise.allSettled([...flowTaskQueues.values()]);
        spec.timers.clearAll();
        spec.releaseAllTargets();
      })();
      return shutdownPromise;
    },
    reconcile: (ctx: Context, now?: number) => runPublicOperation(undefined, () => reconcileOpen(ctx, now)),
    beginPoll1: (ctx: Context, flowId: string, state: State, guildId?: string) => runPublicOperation(false, () => beginPoll1Open(ctx, flowId, state, guildId)),
    transitionPoll1: (ctx: Context, flowId: string, guildId: string) => closed ? Promise.resolve() : enqueueFlowTask(flowId, () => transitionPoll1Open(ctx, flowId, guildId)),
    transitionPoll2: (ctx: Context, flowId: string, guildId: string) => closed ? Promise.resolve() : enqueueFlowTask(flowId, () => transitionPoll2Open(ctx, flowId, guildId)),
    abort: (ctx: Context, flowId: string, state: State, heading: string, guildId?: string, expected?: OpenPollFlow<State>) =>
      runPublicOperation(false, () => abortOpen(ctx, flowId, state, heading, guildId, expected)),
    handleVote,
    handleApproval: (interaction: ButtonInteraction, ctx: Context) => runPublicOperation(false, () => handleApprovalOpen(interaction, ctx)),
  };
}
