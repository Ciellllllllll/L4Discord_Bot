import type { CoreDeps } from "../../core/deps.js";
import type { TextChannel } from "discord.js";
import { FlowDeadlineTimers } from "./flowLifecycle.js";
import { createFlowTargetTracker, deletePollFlowMessagesQuietly, findOpenPollFlowById, formatDurationLabelJa, adminWaitDeadlineMs, buildApprovedAuditReason, type OpenPollFlowRow } from "./pollFlowHelpers.js";
import { TIMEOUT_EXTEND_FLOW_KIND } from "./timeoutExtendConstants.js";
import { parseTimeoutExtendFlowState, type TimeoutExtendFlowState } from "./timeoutExtendFlow.types.js";

// タイムアウト延長フローが使う依存。各分割ファイルで共有する。
export type TimeoutExtendFlowDeps = Pick<CoreDeps, "config" | "db" | "log" | "client">;

export const timeoutExtendTimers = new FlowDeadlineTimers<ReturnType<typeof setTimeout>>({ setTimeout, clearTimeout });

export const timeoutExtendTargetTracker = createFlowTargetTracker("timeout-extend");

export type OpenTimeoutExtendFlowRow = OpenPollFlowRow;

export function retainTimeoutExtendTarget(flowId: string, guildId: string, targetId: string): boolean {
  return timeoutExtendTargetTracker.retain(flowId, guildId, targetId);
}

export function releaseTimeoutExtendTarget(flowId: string): void {
  timeoutExtendTargetTracker.release(flowId);
}

export async function findOpenTimeoutExtendFlowById(
  ctx: TimeoutExtendFlowDeps,
  flowId: string,
): Promise<{ row: OpenTimeoutExtendFlowRow; state: TimeoutExtendFlowState } | null> {
  return findOpenPollFlowById(ctx, flowId, TIMEOUT_EXTEND_FLOW_KIND, parseTimeoutExtendFlowState, "timeoutExtend");
}

export async function deleteTeFlowMessagesQuietly(
  ctx: TimeoutExtendFlowDeps,
  channel: TextChannel,
  messageIds: string[],
  logLabel: string,
): Promise<void> {
  await deletePollFlowMessagesQuietly(ctx, channel, messageIds, "timeoutExtend", logLabel);
}

const TIMEOUT_EXTEND_REASON_BASE = "/タイムアウト延長フロー";

export function buildTimeoutExtendAuditReason(approverUserId: string, detailJa: string): string {
  return buildApprovedAuditReason(TIMEOUT_EXTEND_REASON_BASE, detailJa, approverUserId);
}

export const teAdminWaitDeadlineMs = adminWaitDeadlineMs;
export const durationLabelJa = formatDurationLabelJa;
