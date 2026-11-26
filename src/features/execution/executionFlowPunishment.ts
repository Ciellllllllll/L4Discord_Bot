import { DiscordAPIError, MessageFlags, type ButtonInteraction, type Guild, type GuildMember, type TextChannel } from "discord.js";
import { buildExecutionAuditReason, clampTimeoutMs } from "./executionConstants.js";
import type { ExecutionAction, ExecutionFlowState } from "./executionFlow.types.js";
import type { OpenPollFlow } from "./flowLifecycle.js";
import { formatDurationLabelJa } from "./pollFlowHelpers.js";
import { deleteFlowMessagesQuietly, executionTimers, timerKey, saveFullState, type ExecutionFlowDeps, type OpenExecutionFlowRow } from "./executionFlowCore.js";
import { approvalRows } from "./executionFlowRender.js";

// 処罰の実行と事前確認・承認。

function actionLabelJa(action: ExecutionAction): string {
  if (action === "timeout") return "タイムアウト";
  if (action === "kick") return "キック";
  return "BAN";
}

function buildPunishmentDetailJa(state: ExecutionFlowState): string {
  const act = state.resolved_action;
  if (!act) return "処罰";
  if (act === "timeout") {
    const sec = state.duration_seconds;
    if (sec == null) return "タイムアウト";
    return `タイムアウト（${formatDurationLabelJa(sec)}）`;
  }
  if (act === "kick") return "キック";
  return "BAN";
}

async function carryOutPunishment(
  guild: Guild,
  targetId: string,
  action: ExecutionAction,
  durationSeconds: number | null,
  reason: string,
  ctx: ExecutionFlowDeps,
): Promise<{ ok: true } | { ok: false; message: string }> {
  let member: GuildMember;
  try {
    member = await guild.members.fetch(targetId);
  } catch {
    return { ok: false, message: "対象メンバーが見つかりません（退出済みなど）。" };
  }

  try {
    if (action === "timeout") {
      const sec = durationSeconds ?? 60;
      const ms = clampTimeoutMs(sec * 1000);
      await member.timeout(ms, reason);
    } else if (action === "kick") {
      await member.kick(reason);
    } else {
      await member.ban({ reason, deleteMessageSeconds: 0 });
    }
    return { ok: true };
  } catch (err) {
    ctx.log.warn({ err, targetId, action }, "execution: punishment failed");
    if (err instanceof DiscordAPIError) {
      return { ok: false, message: `Discord API: ${err.message}` };
    }
    return { ok: false, message: String(err) };
  }
}

export async function handleExecutionPrecheckApproval(
  interaction: ButtonInteraction,
  ctx: ExecutionFlowDeps,
  current: OpenPollFlow<ExecutionFlowState>,
  action: "approve" | "deny",
  controls: { abort(heading: string): Promise<boolean>; beginPoll1(state: ExecutionFlowState): Promise<boolean> },
): Promise<boolean> {
  const state = current.state;
  if (state.phase !== "precheck_pending") return false;
  const row: OpenExecutionFlowRow = {
    id: current.id,
    guild_id: current.guildId,
    status: current.status,
    message_id: current.messageId,
    state: current.rawState,
    state_revision: current.stateRevision,
    updated_at: current.updatedAt,
  };
  if (action === "deny") {
    if (!await controls.abort("処刑フロー: 事前承認が拒否されました")) {
      await interaction.reply({ content: "状態の保存に失敗しました。再試行してください。", flags: MessageFlags.Ephemeral });
      return true;
    }
    await interaction.update({ components: approvalRows(current.id, true) }).catch(() => undefined);
    return true;
  }

  const next: ExecutionFlowState = { ...state, phase: "poll1_pending", precheck_message_id: state.precheck_message_id };
  try {
    if (!await saveFullState(ctx, current.id, next, null, row)) {
      await interaction.reply({ content: "このフローは既に処理されています。再試行してください。", flags: MessageFlags.Ephemeral });
      return true;
    }
  } catch (err) {
    ctx.log.error({ err, flowId: current.id, phase: state.phase, guildId: current.guildId }, "execution: precheck approval persistence failed");
    await interaction.reply({ content: "状態の保存に失敗しました。再試行してください。", flags: MessageFlags.Ephemeral });
    return true;
  }
  executionTimers.clear(timerKey("admin", current.id));
  await interaction.update({ components: approvalRows(current.id, true) }).catch(() => undefined);
  await controls.beginPoll1(next);
  return true;
}

export async function notifyExecutionDenied(
  ctx: ExecutionFlowDeps,
  interaction: ButtonInteraction,
  current: OpenPollFlow<ExecutionFlowState>,
  approverId: string,
): Promise<void> {
  try {
    await (interaction.channel as TextChannel).send({ content: "処刑が非承認されたため、中止します" });
  } catch (err) {
    ctx.log.warn({ err, flowId: current.id, phase: current.state.phase, guildId: current.guildId }, "execution: abort message failed");
  }
  ctx.log.info({ flowId: current.id, approverId, phase: current.state.phase, guildId: current.guildId }, "execution: final deny");
}

export async function cleanupExecutionApproval(
  ctx: ExecutionFlowDeps,
  interaction: ButtonInteraction,
  state: ExecutionFlowState,
  label: "approve" | "deny",
): Promise<void> {
  const ids = [state.precheck_message_id, state.poll1_message_id, state.poll2_message_id, state.admin_message_id]
    .filter((id): id is string => Boolean(id));
  await deleteFlowMessagesQuietly(ctx, interaction.channel as TextChannel, ids, label === "deny" ? "reject" : label);
}

export async function executeApprovedExecution(
  ctx: ExecutionFlowDeps,
  interaction: ButtonInteraction,
  current: OpenPollFlow<ExecutionFlowState>,
  approverId: string,
): Promise<{ ok: boolean }> {
  const state = current.state;
  const action = state.resolved_action;
  if (!action || !interaction.guild) return { ok: false };
  const result = await carryOutPunishment(
    interaction.guild,
    state.target_id,
    action,
    state.duration_seconds,
    buildExecutionAuditReason(approverId, buildPunishmentDetailJa(state)),
    ctx,
  );
  const channel = interaction.channel as TextChannel;
  if (result.ok) {
    const duration = action === "timeout" ? `（${formatDurationLabelJa(state.duration_seconds)}）` : "";
    try {
      await channel.send({
        content: `# <@${state.target_id}> を **${actionLabelJa(action)}${duration}** で処刑しました`,
        allowedMentions: { users: [state.target_id] },
      });
    } catch (err) {
      ctx.log.warn({ err, flowId: current.id, phase: state.phase, guildId: current.guildId }, "execution: result message failed");
    }
  } else {
    try {
      await channel.send({ content: `処刑の実行に失敗しました: ${result.message}` });
    } catch (err) {
      ctx.log.warn({ err, flowId: current.id, phase: state.phase, guildId: current.guildId }, "execution: error message failed");
    }
  }
  return { ok: result.ok };
}
