import type { Kysely } from "kysely";
import type { Database } from "../../core/db/types.js";
import type { FlowDeadlineTimers, OpenPollFlow } from "./flowLifecycle.js";
import type { ButtonInteraction, GuildMember, MessageEditOptions } from "discord.js";

// 二段階投票ランタイムで共有する型。

export type FlowRuntimeRow = {
  id: string;
  guild_id: string;
  state: unknown;
  updated_at: Date;
};

export type TwoStagePollState<Poll1Choice extends string, Poll2Choice extends string> = {
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

export type TwoStagePollContext = {
  db: Kysely<Database>;
  log: {
    warn(fields: Record<string, unknown>, message: string): void;
    error(fields: Record<string, unknown>, message: string): void;
  };
};

export type PublishedPollMessage = { id: string; delete(): Promise<unknown> };
export type PollPublication = PublishedPollMessage | { failureHeading: string } | null;
export type Poll1Resolution<State> =
  | { destination: "poll2"; state: State }
  | { destination: "admin"; state: State; adminText: string };
export type FinalApprovalResult = { ok: boolean };

export type TwoStagePollRuntimeSpec<
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
