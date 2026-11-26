import { DiscordAPIError, type ButtonInteraction, type Guild, type GuildMember, type TextChannel } from "discord.js";
import { clampTimeoutMs } from "./executionConstants.js";
import { buildTimeoutExtendAuditReason, durationLabelJa, deleteTeFlowMessagesQuietly, type TimeoutExtendFlowDeps } from "./timeoutExtendFlowCore.js";
import type { TimeoutExtendFlowState } from "./timeoutExtendFlow.types.js";
import type { OpenPollFlow } from "./flowLifecycle.js";

// タイムアウト延長の実行まわり。

async function applyTimeoutResolution(
  guild: Guild,
  targetId: string,
  resolved: "extend" | "release",
  durationSeconds: number | null,
  reason: string,
  ctx: TimeoutExtendFlowDeps,
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

export function buildResolvedDetailJa(state: TimeoutExtendFlowState): string {
  const r = state.resolved_extend;
  if (r === "release") return "タイムアウト解除";
  const sec = state.duration_seconds;
  return sec == null ? "タイムアウト延長" : `タイムアウト延長（${durationLabelJa(sec)}）`;
}

export async function notifyTimeoutExtendDenied(
  ctx: TimeoutExtendFlowDeps,
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

export async function cleanupTimeoutExtendApproval(
  ctx: TimeoutExtendFlowDeps,
  interaction: ButtonInteraction,
  state: TimeoutExtendFlowState,
  label: "approve" | "deny",
): Promise<void> {
  const ids = [state.poll1_message_id, state.poll2_message_id, state.admin_message_id]
    .filter((id): id is string => Boolean(id));
  await deleteTeFlowMessagesQuietly(ctx, interaction.channel as TextChannel, ids, label);
}

export async function executeApprovedTimeoutExtend(
  ctx: TimeoutExtendFlowDeps,
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
