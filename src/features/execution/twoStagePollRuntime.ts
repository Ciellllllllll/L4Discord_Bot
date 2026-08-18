import {
  type FlowDeadlineTimers,
  type OpenPollFlow,
  PollFlowStateStore,
  claimPollAdminApproval,
  commitClaimedPollTerminal,
  persistTerminalState,
  remainingDeadlineDelayMs,
  saveOpenPollState,
} from "./flowLifecycle.js";
import type { Kysely } from "kysely";
import type { Database } from "../../core/db/types.js";
import { sqliteTimestamp } from "../../core/db/sqliteTimestamp.js";
import { MessageFlags, type ButtonInteraction, type GuildMember, type MessageEditOptions, type TextChannel } from "discord.js";

type FlowRuntimeRow = {
  id: string;
  guild_id: string;
  state: unknown;
  updated_at: Date;
};

type TwoStagePollState<Poll1Choice extends string, Poll2Choice extends string> = {
  phase: string;
  target_id: string;
  channel_id: string;
  poll1_message_id: string | null;
  poll2_message_id: string | null;
  admin_message_id: string | null;
  poll1_deadline_ms: number;
  poll2_deadline_ms: number | null;
  votes_poll1: Record<string, Poll1Choice>;
  votes_poll2: Record<string, Poll2Choice>;
  admin_button_fired: boolean;
};

type TwoStagePollContext = {
  db: Kysely<Database>;
  log: {
    warn(fields: Record<string, unknown>, message: string): void;
    error(fields: Record<string, unknown>, message: string): void;
  };
};

type PublishedPollMessage = { id: string; delete(): Promise<unknown> };
type PollPublication = PublishedPollMessage | { failureHeading: string } | null;
type Poll1Resolution<State> =
  | { destination: "poll2"; state: State }
  | { destination: "admin"; state: State; adminText: string };
type FinalApprovalResult = { ok: boolean };

export function parsePersistedFlowState<T>(value: unknown, parse: (value: unknown) => T | null): T | null {
  let decoded = value;
  if (typeof decoded === "string") {
    try {
      decoded = JSON.parse(decoded);
    } catch {
      return null;
    }
  }
  return parse(decoded);
}

export function tallyChoices<T extends string>(votes: Readonly<Record<string, string>>, keys: readonly T[]): Record<T, number> {
  const counts = Object.fromEntries(keys.map((key) => [key, 0])) as Record<T, number>;
  for (const choice of Object.values(votes)) {
    if (Object.hasOwn(counts, choice)) counts[choice as T] += 1;
  }
  return counts;
}

export function pickSingleWinner<T extends string>(counts: Readonly<Record<T, number>>, keys: readonly T[]): T | null {
  let max = 0;
  let winner: T | null = null;
  let tied = false;
  for (const key of keys) {
    const count = counts[key] ?? 0;
    if (count > max) {
      max = count;
      winner = key;
      tied = false;
    } else if (count === max && count > 0) {
      tied = true;
    }
  }
  return max > 0 && !tied ? winner : null;
}

type TwoStagePollRuntimeSpec<
  Context extends TwoStagePollContext,
  State extends TwoStagePollState<Poll1Choice, Poll2Choice>,
  Poll1Choice extends string,
  Poll2Choice extends string,
> = {
  namespace: string;
  kind: string;
  votePrefix: string;
  approvalPrefix: string;
  timers: FlowDeadlineTimers<ReturnType<typeof setTimeout>>;
  parse(value: unknown): State | null;
  targetId(state: State): string;
  retainTarget(flowId: string, guildId: string, targetId: string): boolean;
  releaseTarget(flowId: string): void;
  releaseAllTargets(): void;
  isAdmin(ctx: Context, member: GuildMember): boolean;
  handleOtherApproval?(
    interaction: ButtonInteraction,
    ctx: Context,
    current: OpenPollFlow<State>,
    action: "approve" | "deny",
    controls: {
      abort(heading: string): Promise<boolean>;
      beginPoll1(state: State): Promise<boolean>;
    },
  ): Promise<boolean>;
  approvalComponents(flowId: string): MessageEditOptions["components"];
  canExecuteFinal(state: State): boolean;
  executeFinal(ctx: Context, interaction: ButtonInteraction, current: OpenPollFlow<State>, approverId: string): Promise<FinalApprovalResult>;
  notifyDenied(ctx: Context, interaction: ButtonInteraction, current: OpenPollFlow<State>, approverId: string): Promise<void>;
  cleanupFinal(ctx: Context, interaction: ButtonInteraction, state: State, label: "approve" | "deny"): Promise<void>;
  afterApproved(ctx: Context, current: OpenPollFlow<State>, approverId: string, result: FinalApprovalResult): void;
  voteDurationMs(ctx: Context): number;
  adminWaitMs(ctx: Context): number;
  toPoll1Pending(state: State, deadlineMs: number): State;
  poll1Published(state: State, messageId: string): State;
  resolvePoll1(state: State, winner: Poll1Choice, poll2DeadlineMs: number): Poll1Resolution<State>;
  poll2Published(state: State, messageId: string): State;
  resolvePoll2(state: State, winner: Poll2Choice): { state: State; adminText: string };
  adminPublished(state: State, messageId: string): State;
  publishPoll1(ctx: Context, flowId: string, state: State): Promise<PollPublication>;
  publishPoll2(ctx: Context, flowId: string, state: State): Promise<PollPublication>;
  publishAdmin(ctx: Context, flowId: string, state: State, text: string): Promise<PollPublication>;
  disablePoll1(ctx: Context, flowId: string, state: State): Promise<void>;
  disablePoll2(ctx: Context, flowId: string, state: State): Promise<void>;
  discardMessage(ctx: Context, flowId: string, message: PublishedPollMessage, label: string): Promise<void>;
  stopMessages(ctx: Context, flowId: string, state: State, heading: string): Promise<void>;
  poll1Choices: readonly Poll1Choice[];
  poll2Choices: readonly Poll2Choice[];
  poll1Labels: Readonly<Record<Poll1Choice, string>>;
  poll2Labels: Readonly<Record<Poll2Choice, string>>;
  renderPoll1(state: State, flowId: string): MessageEditOptions;
  renderPoll2(state: State, flowId: string): MessageEditOptions;
  adminPending(state: State): boolean;
  adminDeadline(ctx: Context, row: FlowRuntimeRow, state: State): number;
  claimed(state: State): boolean;
  unpublished(state: State): boolean;
  poll1Deadline(state: State): number | null;
  poll2Deadline(state: State): number | null;
  restoredDeadlineExpiredHeading: string;
  adminTimeoutHeading: string;
  duplicateTargetHeading: string;
  unpublishedHeading: string;
  poll1NoWinnerHeading: string;
  poll2NoWinnerHeading: string;
  poll1PublishFailureHeading: string;
  poll2PublishFailureHeading: string;
  adminPublishFailureHeading: string;
};

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

  const findStoredOpen = (ctx: Context, flowId: string): Promise<OpenPollFlow<State> | null> =>
    new PollFlowStateStore(ctx.db).findOpen(flowId, spec.kind, spec.parse);

  const listOpenRows = (ctx: Context): Promise<FlowRuntimeRow[]> => ctx.db
    .selectFrom("polls")
    .select(["id", "guild_id", "state", "updated_at"])
    .where("kind", "=", spec.kind)
    .where("status", "=", "open")
    .execute();

  const saveExpected = (
    ctx: Context,
    flowId: string,
    current: OpenPollFlow<State>,
    nextState: State,
    messageId: string | null,
  ): Promise<boolean> => saveOpenPollState({
    store: new PollFlowStateStore(ctx.db),
    id: flowId,
    kind: spec.kind,
    parse: spec.parse,
    nextState,
    messageId,
    expected: { state: current.state, state_revision: current.stateRevision, rawState: current.rawState },
  });

  const persistPublished = async (
    ctx: Context,
    flowId: string,
    messageId: string | null,
    isSameReservation: (state: State) => boolean,
    published: (state: State) => State,
  ): Promise<boolean> => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await findStoredOpen(ctx, flowId);
      if (!current || !isSameReservation(current.state)) return false;
      if (await saveExpected(ctx, flowId, current, published(current.state), messageId)) return true;
    }
    return false;
  };

  const discardAndAbortUnpublished = async (
    ctx: Context,
    flowId: string,
    message: PublishedPollMessage,
    label: string,
    heading: string,
    guildId: string,
    isSameReservation: (state: State) => boolean,
  ): Promise<void> => {
    await spec.discardMessage(ctx, flowId, message, label);
    const advancedReservation = async (current: OpenPollFlow<State>): Promise<OpenPollFlow<State> | null> => {
      const latest = await findStoredOpen(ctx, flowId);
      return latest && isSameReservation(latest.state) && latest.stateRevision > current.stateRevision ? latest : null;
    };
    const compensate = async (current: OpenPollFlow<State>): Promise<void> => {
      if (await abortExpected(ctx, flowId, current, heading, guildId)) return;
      if (closed) return;
      const latest = await advancedReservation(current);
      if (!latest) return;
      spec.timers.schedule(timerKey("compensation", flowId), 0, () => {
        runTransition(flowId, async () => {
          try {
            await compensate(latest);
          } catch (err) {
            ctx.log.error({ err, flowId, guildId, phase: "compensation" }, `${spec.namespace}: unpublished compensation failed`);
          }
        });
      });
    };
    let current = await findStoredOpen(ctx, flowId);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (!current || !isSameReservation(current.state)) return;
      if (await abortExpected(ctx, flowId, current, heading, guildId)) return;
      current = await advancedReservation(current);
    }
    if (current) await compensate(current);
  };

  const abortOpen = async (
    ctx: Context,
    flowId: string,
    state: State,
    heading: string,
    guildId = "unknown",
    expected?: OpenPollFlow<State>,
  ): Promise<boolean> => {
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
  };

  const abortExpected = (
    ctx: Context,
    flowId: string,
    current: OpenPollFlow<State>,
    heading: string,
    guildId: string,
  ): Promise<boolean> => abortOpen(ctx, flowId, current.state, heading, guildId, current);

  const commitClaimedTerminal = async (
    ctx: Context,
    current: OpenPollFlow<State>,
    terminalPhase: "completed" | "cancelled",
  ): Promise<boolean> => {
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
  };

  const retryAfterRevisionAdvance = async (
    ctx: Context,
    flowId: string,
    current: OpenPollFlow<State>,
    retry: () => void,
  ): Promise<void> => {
    const latest = await findStoredOpen(ctx, flowId);
    if (latest?.state.phase === current.state.phase && latest.stateRevision > current.stateRevision) retry();
  };

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

  const transitionPoll1Open = async (ctx: Context, flowId: string, guildId: string): Promise<void> => {
    const current = await findStoredOpen(ctx, flowId);
    if (!current || current.state.phase !== "poll1_pending") return;
    const winner = pickSingleWinner(tallyChoices(current.state.votes_poll1, spec.poll1Choices), spec.poll1Choices);
    if (winner == null) {
      const aborted = await abortExpected(ctx, flowId, current, spec.poll1NoWinnerHeading, guildId);
      if (!aborted) await retryAfterRevisionAdvance(ctx, flowId, current, () => schedulePoll1(ctx, flowId, guildId, 0));
      return;
    }

    const voteMs = spec.voteDurationMs(ctx);
    const resolution = spec.resolvePoll1(current.state, winner, Date.now() + voteMs);
    if (!await saveExpected(ctx, flowId, current, resolution.state, null)) {
      schedulePoll1(ctx, flowId, guildId, 0);
      return;
    }
    await spec.disablePoll1(ctx, flowId, current.state);

    if (resolution.destination === "poll2") {
      const publication = await spec.publishPoll2(ctx, flowId, resolution.state);
      const message = publication && "id" in publication ? publication : null;
      if (!message) {
        const pending = await findStoredOpen(ctx, flowId);
        if (pending?.state.phase === "poll2_pending") {
          const heading = publication && "failureHeading" in publication ? publication.failureHeading : spec.poll2PublishFailureHeading;
          await abortExpected(ctx, flowId, pending, heading, guildId);
        }
        return;
      }
      const sameReservation = (candidate: State) => candidate.phase === "poll2_pending"
        && candidate.poll2_message_id === null
        && candidate.poll2_deadline_ms === resolution.state.poll2_deadline_ms;
      if (!await persistPublished(ctx, flowId, message.id, sameReservation, (current) => spec.poll2Published(current, message.id))) {
        await discardAndAbortUnpublished(ctx, flowId, message, "poll2 publication CAS lost", spec.poll2PublishFailureHeading, guildId, sameReservation);
        return;
      }
      schedulePoll2(ctx, flowId, guildId, voteMs);
      return;
    }

    const publication = await spec.publishAdmin(ctx, flowId, resolution.state, resolution.adminText);
    const message = publication && "id" in publication ? publication : null;
    if (!message) {
      const pending = await findStoredOpen(ctx, flowId);
      if (pending?.state.phase === "admin_pending") {
        const heading = publication && "failureHeading" in publication ? publication.failureHeading : spec.adminPublishFailureHeading;
        await abortExpected(ctx, flowId, pending, heading, guildId);
      }
      return;
    }
    const sameReservation = (candidate: State) => candidate.phase === "admin_pending"
      && candidate.admin_message_id === null
      && candidate.admin_button_fired === false;
    if (!await persistPublished(ctx, flowId, null, sameReservation, (current) => spec.adminPublished(current, message.id))) {
      await discardAndAbortUnpublished(ctx, flowId, message, "admin publication CAS lost", spec.adminPublishFailureHeading, guildId, sameReservation);
      return;
    }
    scheduleAdmin(ctx, flowId, guildId, spec.adminWaitMs(ctx));
  };

  const transitionPoll2Open = async (ctx: Context, flowId: string, guildId: string): Promise<void> => {
    const current = await findStoredOpen(ctx, flowId);
    if (!current || current.state.phase !== "poll2_pending") return;
    const winner = pickSingleWinner(tallyChoices(current.state.votes_poll2, spec.poll2Choices), spec.poll2Choices);
    if (winner == null) {
      const aborted = await abortExpected(ctx, flowId, current, spec.poll2NoWinnerHeading, guildId);
      if (!aborted) await retryAfterRevisionAdvance(ctx, flowId, current, () => schedulePoll2(ctx, flowId, guildId, 0));
      return;
    }

    const resolution = spec.resolvePoll2(current.state, winner);
    if (!await saveExpected(ctx, flowId, current, resolution.state, null)) {
      schedulePoll2(ctx, flowId, guildId, 0);
      return;
    }
    await spec.disablePoll2(ctx, flowId, current.state);
    const publication = await spec.publishAdmin(ctx, flowId, resolution.state, resolution.adminText);
    const message = publication && "id" in publication ? publication : null;
    if (!message) {
      const pending = await findStoredOpen(ctx, flowId);
      if (pending?.state.phase === "admin_pending") {
        const heading = publication && "failureHeading" in publication ? publication.failureHeading : spec.adminPublishFailureHeading;
        await abortExpected(ctx, flowId, pending, heading, guildId);
      }
      return;
    }
    const sameReservation = (candidate: State) => candidate.phase === "admin_pending"
      && candidate.admin_message_id === null
      && candidate.admin_button_fired === false;
    if (!await persistPublished(ctx, flowId, null, sameReservation, (current) => spec.adminPublished(current, message.id))) {
      await discardAndAbortUnpublished(ctx, flowId, message, "admin publication CAS lost", spec.adminPublishFailureHeading, guildId, sameReservation);
      return;
    }
    scheduleAdmin(ctx, flowId, guildId, spec.adminWaitMs(ctx));
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
          updated_at: sqliteTimestamp() as unknown as Date,
        }).where("id", "=", row.id).where("status", "=", "open").execute();
        continue;
      }
      if (state.phase === "completed" || state.phase === "cancelled") {
        spec.releaseTarget(row.id);
        await ctx.db.updateTable("polls").set({
          status: state.phase === "completed" ? "completed" : "cancelled",
          updated_at: sqliteTimestamp() as unknown as Date,
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
