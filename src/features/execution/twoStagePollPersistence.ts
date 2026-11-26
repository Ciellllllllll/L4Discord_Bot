import {
  type OpenPollFlow,
  PollFlowStateStore,
  commitClaimedPollTerminal,
  persistTerminalState,
  saveOpenPollState,
} from "./flowLifecycle.js";
import type { FlowRuntimeRow, TwoStagePollRuntimeSpec, TwoStagePollState, TwoStagePollContext, PublishedPollMessage } from "./twoStagePollRuntime.types.js";
import { pickSingleWinner, tallyChoices } from "./twoStagePollTally.js";

// 二段階投票ランタイムの状態保存・公開まわり。
// 閉じ込めていた spec を引数で受け取る形にした。

export function findStoredOpen<
  Context extends TwoStagePollContext,
  State extends TwoStagePollState<Poll1Choice, Poll2Choice>,
  Poll1Choice extends string,
  Poll2Choice extends string,
>(spec: TwoStagePollRuntimeSpec<Context, State, Poll1Choice, Poll2Choice>, ctx: Context, flowId: string): Promise<OpenPollFlow<State> | null> {
  return new PollFlowStateStore(ctx.db).findOpen(flowId, spec.kind, spec.parse);
}

export async function listOpenRows<
  Context extends TwoStagePollContext,
  State extends TwoStagePollState<Poll1Choice, Poll2Choice>,
  Poll1Choice extends string,
  Poll2Choice extends string,
>(spec: TwoStagePollRuntimeSpec<Context, State, Poll1Choice, Poll2Choice>, ctx: Context): Promise<FlowRuntimeRow[]> {
  return ctx.db
    .selectFrom("polls")
    .select(["id", "guild_id", "state", "updated_at"])
    .where("kind", "=", spec.kind)
    .where("status", "=", "open")
    .execute();
}

export async function saveExpected<
  Context extends TwoStagePollContext,
  State extends TwoStagePollState<Poll1Choice, Poll2Choice>,
  Poll1Choice extends string,
  Poll2Choice extends string,
>(
  spec: TwoStagePollRuntimeSpec<Context, State, Poll1Choice, Poll2Choice>,
  ctx: Context,
  flowId: string,
  current: OpenPollFlow<State>,
  nextState: State,
  messageId: string | null,
): Promise<boolean> {
  return saveOpenPollState({
    store: new PollFlowStateStore(ctx.db),
    id: flowId,
    kind: spec.kind,
    parse: spec.parse,
    nextState,
    messageId,
    expected: { state: current.state, state_revision: current.stateRevision, rawState: current.rawState },
  });
}

export async function persistPublished<
  Context extends TwoStagePollContext,
  State extends TwoStagePollState<Poll1Choice, Poll2Choice>,
  Poll1Choice extends string,
  Poll2Choice extends string,
>(
  spec: TwoStagePollRuntimeSpec<Context, State, Poll1Choice, Poll2Choice>,
  ctx: Context,
  flowId: string,
  messageId: string | null,
  isSameReservation: (state: State) => boolean,
  published: (state: State) => State,
): Promise<boolean> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const current = await findStoredOpen(spec, ctx, flowId);
    if (!current || !isSameReservation(current.state)) return false;
    if (await saveExpected(spec, ctx, flowId, current, published(current.state), messageId)) return true;
  }
  return false;
}

export async function abortOpen<
  Context extends TwoStagePollContext,
  State extends TwoStagePollState<Poll1Choice, Poll2Choice>,
  Poll1Choice extends string,
  Poll2Choice extends string,
>(
  spec: TwoStagePollRuntimeSpec<Context, State, Poll1Choice, Poll2Choice>,
  ctx: Context,
  clearTimers: (flowId: string) => void,
  flowId: string,
  state: State,
  heading: string,
  guildId = "unknown",
  expected?: OpenPollFlow<State>,
): Promise<boolean> {
  let committedState: State | null = null;
  const result = await persistTerminalState(async () => {
    const current = await new PollFlowStateStore(ctx.db).cancelOpenFlow({
      id: flowId,
      kind: spec.kind,
      expectedPhase: state.phase,
      parse: spec.parse,
      ...(expected ? { expected: { state, stateRevision: expected.stateRevision, rawState: expected.rawState } } : {}),
      canCancel: (candidate) => candidate.admin_button_fired === false,
    });
    if (!current) throw new Error(`${spec.namespace} flow terminal CAS lost`);
    committedState = current;
  }, () => {
    clearTimers(flowId);
    spec.releaseTarget(flowId);
  });
  if (!result.ok) {
    ctx.log.error({ err: result.error, flowId, phase: state.phase, guildId }, `${spec.namespace}: terminal state persistence failed`);
    return false;
  }
  await spec.stopMessages(ctx, flowId, committedState ?? state, heading);
  return true;
}

export function abortExpected<
  Context extends TwoStagePollContext,
  State extends TwoStagePollState<Poll1Choice, Poll2Choice>,
  Poll1Choice extends string,
  Poll2Choice extends string,
>(
  spec: TwoStagePollRuntimeSpec<Context, State, Poll1Choice, Poll2Choice>,
  ctx: Context,
  clearTimers: (flowId: string) => void,
  flowId: string,
  current: OpenPollFlow<State>,
  heading: string,
  guildId: string,
): Promise<boolean> {
  return abortOpen(spec, ctx, clearTimers, flowId, current.state, heading, guildId, current);
}

export async function commitClaimedTerminal<
  Context extends TwoStagePollContext,
  State extends TwoStagePollState<Poll1Choice, Poll2Choice>,
  Poll1Choice extends string,
  Poll2Choice extends string,
>(
  spec: TwoStagePollRuntimeSpec<Context, State, Poll1Choice, Poll2Choice>,
  ctx: Context,
  clearTimers: (flowId: string) => void,
  current: OpenPollFlow<State>,
  terminalPhase: "completed" | "cancelled",
): Promise<boolean> {
  const result = await persistTerminalState(async () => {
    const committed = await commitClaimedPollTerminal({
      store: new PollFlowStateStore(ctx.db),
      id: current.id,
      state: current.state,
      stateRevision: current.stateRevision,
      terminalPhase,
    });
    if (!committed) throw new Error(`${spec.namespace} flow terminal CAS lost`);
  }, () => {
    clearTimers(current.id);
    spec.releaseTarget(current.id);
  });
  if (!result.ok) {
    ctx.log.error({
      err: result.error,
      flowId: current.id,
      phase: current.state.phase,
      guildId: current.guildId,
    }, `${spec.namespace}: terminal state persistence failed`);
  }
  return result.ok;
}

export async function retryAfterRevisionAdvance<
  Context extends TwoStagePollContext,
  State extends TwoStagePollState<Poll1Choice, Poll2Choice>,
  Poll1Choice extends string,
  Poll2Choice extends string,
>(
  spec: TwoStagePollRuntimeSpec<Context, State, Poll1Choice, Poll2Choice>,
  ctx: Context,
  flowId: string,
  current: OpenPollFlow<State>,
  retry: () => void,
): Promise<void> {
  const latest = await findStoredOpen(spec, ctx, flowId);
  if (latest?.state.phase === current.state.phase && latest.stateRevision > current.stateRevision) retry();
}
// 公開の撤回と状態遷移。ランタイムが閉じ込めていた状態は controls で受け渡す。
export type TwoStageControls<Context extends TwoStagePollContext, State extends TwoStagePollState<Poll1Choice, Poll2Choice>, Poll1Choice extends string = string, Poll2Choice extends string = string> = {
  closed(): boolean;
  timerKey(phase: "poll1" | "poll2" | "admin" | "compensation", flowId: string): string;
  clearTimers(flowId: string): void;
  runTransition(flowId: string, transition: () => Promise<void>): void;
  schedulePoll1(ctx: Context, flowId: string, guildId: string, delayMs: number): void;
  schedulePoll2(ctx: Context, flowId: string, guildId: string, delayMs: number): void;
  scheduleAdmin(ctx: Context, flowId: string, guildId: string, delayMs: number): void;
  discardAndAbortUnpublished(
    ctx: Context,
    flowId: string,
    message: PublishedPollMessage,
    label: string,
    heading: string,
    guildId: string,
    isSameReservation: (state: State) => boolean,
  ): Promise<void>;
};

export async function discardAndAbortUnpublished<Context extends TwoStagePollContext, State extends TwoStagePollState<Poll1Choice, Poll2Choice>, Poll1Choice extends string, Poll2Choice extends string>(
  spec: TwoStagePollRuntimeSpec<Context, State, Poll1Choice, Poll2Choice>,
  ctx: Context,
  controls: TwoStageControls<Context, State>,
  flowId: string,
  message: PublishedPollMessage,
  label: string,
  heading: string,
  guildId: string,
  isSameReservation: (state: State) => boolean,
): Promise<void> {
  await spec.discardMessage(ctx, flowId, message, label);
  const advancedReservation = async (current: OpenPollFlow<State>): Promise<OpenPollFlow<State> | null> => {
    const latest = await findStoredOpen(spec, ctx, flowId);
    return latest && isSameReservation(latest.state) && latest.stateRevision > current.stateRevision ? latest : null;
  };
  const compensate = async (current: OpenPollFlow<State>): Promise<void> => {
    if (await abortExpected(spec, ctx, controls.clearTimers, flowId, current, heading, guildId)) return;
    if (controls.closed()) return;
    const latest = await advancedReservation(current);
    if (!latest) return;
    spec.timers.schedule(controls.timerKey("compensation", flowId), 0, () => {
      controls.runTransition(flowId, async () => {
        try {
          await compensate(latest);
        } catch (err) {
          ctx.log.error({ err, flowId, guildId, phase: "compensation" }, `${spec.namespace}: unpublished compensation failed`);
        }
      });
    });
  };
  let current = await findStoredOpen(spec, ctx, flowId);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!current || !isSameReservation(current.state)) return;
    if (await abortExpected(spec, ctx, controls.clearTimers, flowId, current, heading, guildId)) return;
    current = await advancedReservation(current);
  }
  if (current) await compensate(current);
}

export async function transitionPoll1Open<Context extends TwoStagePollContext, State extends TwoStagePollState<Poll1Choice, Poll2Choice>, Poll1Choice extends string, Poll2Choice extends string>(spec: TwoStagePollRuntimeSpec<Context, State, Poll1Choice, Poll2Choice>, ctx: Context, controls: TwoStageControls<Context, State>, flowId: string, guildId: string): Promise<void> {
  const current = await findStoredOpen(spec, ctx, flowId);
  if (!current || current.state.phase !== "poll1_pending") return;
  const winner = pickSingleWinner(tallyChoices(current.state.votes_poll1, spec.poll1Choices), spec.poll1Choices);
  if (winner == null) {
    const aborted = await abortExpected(spec, ctx, controls.clearTimers, flowId, current, spec.poll1NoWinnerHeading, guildId);
    if (!aborted) await retryAfterRevisionAdvance(spec, ctx, flowId, current, () => controls.schedulePoll1(ctx, flowId, guildId, 0));
    return;
  }

  const voteMs = spec.voteDurationMs(ctx);
  const resolution = spec.resolvePoll1(current.state, winner, Date.now() + voteMs);
  if (!await saveExpected(spec, ctx, flowId, current, resolution.state, null)) {
    controls.schedulePoll1(ctx, flowId, guildId, 0);
    return;
  }
  await spec.disablePoll1(ctx, flowId, current.state);

  if (resolution.destination === "poll2") {
    const publication = await spec.publishPoll2(ctx, flowId, resolution.state);
    const message = publication && "id" in publication ? publication : null;
    if (!message) {
      const pending = await findStoredOpen(spec, ctx, flowId);
      if (pending?.state.phase === "poll2_pending") {
        const heading = publication && "failureHeading" in publication ? publication.failureHeading : spec.poll2PublishFailureHeading;
        await abortExpected(spec, ctx, controls.clearTimers, flowId, pending, heading, guildId);
      }
      return;
    }
    const sameReservation = (candidate: State) => candidate.phase === "poll2_pending"
      && candidate.poll2_message_id === null
      && candidate.poll2_deadline_ms === resolution.state.poll2_deadline_ms;
    if (!await persistPublished(spec, ctx, flowId, message.id, sameReservation, (current) => spec.poll2Published(current, message.id))) {
      await controls.discardAndAbortUnpublished(ctx, flowId, message, "poll2 publication CAS lost", spec.poll2PublishFailureHeading, guildId, sameReservation);
      return;
    }
    controls.schedulePoll2(ctx, flowId, guildId, voteMs);
    return;
  }

  const publication = await spec.publishAdmin(ctx, flowId, resolution.state, resolution.adminText);
  const message = publication && "id" in publication ? publication : null;
  if (!message) {
    const pending = await findStoredOpen(spec, ctx, flowId);
    if (pending?.state.phase === "admin_pending") {
      const heading = publication && "failureHeading" in publication ? publication.failureHeading : spec.adminPublishFailureHeading;
      await abortExpected(spec, ctx, controls.clearTimers, flowId, pending, heading, guildId);
    }
    return;
  }
  const sameReservation = (candidate: State) => candidate.phase === "admin_pending"
    && candidate.admin_message_id === null
    && candidate.admin_button_fired === false;
  if (!await persistPublished(spec, ctx, flowId, null, sameReservation, (current) => spec.adminPublished(current, message.id))) {
    await controls.discardAndAbortUnpublished(ctx, flowId, message, "admin publication CAS lost", spec.adminPublishFailureHeading, guildId, sameReservation);
    return;
  }
  controls.scheduleAdmin(ctx, flowId, guildId, spec.adminWaitMs(ctx));
}

export async function transitionPoll2Open<Context extends TwoStagePollContext, State extends TwoStagePollState<Poll1Choice, Poll2Choice>, Poll1Choice extends string, Poll2Choice extends string>(spec: TwoStagePollRuntimeSpec<Context, State, Poll1Choice, Poll2Choice>, ctx: Context, controls: TwoStageControls<Context, State>, flowId: string, guildId: string): Promise<void> {
  const current = await findStoredOpen(spec, ctx, flowId);
  if (!current || current.state.phase !== "poll2_pending") return;
  const winner = pickSingleWinner(tallyChoices(current.state.votes_poll2, spec.poll2Choices), spec.poll2Choices);
  if (winner == null) {
    const aborted = await abortExpected(spec, ctx, controls.clearTimers, flowId, current, spec.poll2NoWinnerHeading, guildId);
    if (!aborted) await retryAfterRevisionAdvance(spec, ctx, flowId, current, () => controls.schedulePoll2(ctx, flowId, guildId, 0));
    return;
  }

  const resolution = spec.resolvePoll2(current.state, winner);
  if (!await saveExpected(spec, ctx, flowId, current, resolution.state, null)) {
    controls.schedulePoll2(ctx, flowId, guildId, 0);
    return;
  }
  await spec.disablePoll2(ctx, flowId, current.state);
  const publication = await spec.publishAdmin(ctx, flowId, resolution.state, resolution.adminText);
  const message = publication && "id" in publication ? publication : null;
  if (!message) {
    const pending = await findStoredOpen(spec, ctx, flowId);
    if (pending?.state.phase === "admin_pending") {
      const heading = publication && "failureHeading" in publication ? publication.failureHeading : spec.adminPublishFailureHeading;
      await abortExpected(spec, ctx, controls.clearTimers, flowId, pending, heading, guildId);
    }
    return;
  }
  const sameReservation = (candidate: State) => candidate.phase === "admin_pending"
    && candidate.admin_message_id === null
    && candidate.admin_button_fired === false;
  if (!await persistPublished(spec, ctx, flowId, null, sameReservation, (current) => spec.adminPublished(current, message.id))) {
    await controls.discardAndAbortUnpublished(ctx, flowId, message, "admin publication CAS lost", spec.adminPublishFailureHeading, guildId, sameReservation);
    return;
  }
  controls.scheduleAdmin(ctx, flowId, guildId, spec.adminWaitMs(ctx));
}
