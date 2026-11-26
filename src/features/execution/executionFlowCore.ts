import type { CoreDeps } from "../../core/deps.js";
import type { GuildMember, TextChannel } from "discord.js";
import { FlowDeadlineTimers, PollFlowStateStore, saveOpenPollState } from "./flowLifecycle.js";
import { deletePollFlowMessagesQuietly, type OpenPollFlowRow } from "./pollFlowHelpers.js";
import { EXECUTION_FLOW_KIND } from "./executionConstants.js";
import { parseExecutionFlowState, type ExecutionFlowState } from "./executionFlow.types.js";
import { parsePersistedFlowState } from "./twoStagePollTally.js";

// 処刑フローが使う依存。各分割ファイルで共有する。
export type ExecutionFlowDeps = Pick<CoreDeps, "config" | "db" | "log" | "client">;

export const executionTimers = new FlowDeadlineTimers<ReturnType<typeof setTimeout>>({ setTimeout, clearTimeout });

export type OpenExecutionFlowRow = OpenPollFlowRow;

export function timerKey(phase: "poll1" | "poll2" | "admin", flowId: string): string {
  return `${phase}:${flowId}`;
}

export function memberHasRoleId(member: GuildMember, roleId: string): boolean {
  const id = roleId.trim();
  if (!id) return false;
  return member.roles.cache.has(id);
}

function parsePollRowState(row: { state: unknown }): ExecutionFlowState | null {
  return parsePersistedFlowState(row.state, parseExecutionFlowState);
}

export async function saveFullState(
  ctx: ExecutionFlowDeps,
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
  ctx: ExecutionFlowDeps,
  channel: TextChannel,
  messageIds: string[],
  logLabel: string,
): Promise<void> {
  await deletePollFlowMessagesQuietly(ctx, channel, messageIds, "execution", logLabel);
}
