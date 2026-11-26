import { randomUUID } from "node:crypto";
import { MessageFlags, type ButtonInteraction, type ChatInputCommandInteraction, type GuildMember, type TextChannel } from "discord.js";
import { nowIso } from "../../core/db/nowIso.js";
import { isAdmin } from "../../core/permission.js";
import { EXECUTION_FLOW_KIND, EXEC_APPROVAL_PREFIX, EXEC_VOTE_PREFIX } from "./executionConstants.js";
import type { ExecutionFlowState } from "./executionFlow.types.js";
import { memberHasRoleId, type ExecutionFlowDeps } from "./executionFlowCore.js";
import {
  beginInitialPrecheck,
  releaseExecutionTarget,
  retainExecutionTarget,
  scheduleAdminWait,
  executionOrchestrator,
} from "./executionFlow.js";

// 処刑フローの入口。

export async function startExecutionFlow(
  interaction: ChatInputCommandInteraction,
  ctx: ExecutionFlowDeps,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const guild = interaction.guild;
  if (!guild) {
    await interaction.editReply({ content: "サーバー内でのみ実行できます。" });
    return;
  }

  const execCh = ctx.config.EXEC_CHANNEL_ID?.trim();
  if (execCh && interaction.channelId !== execCh) {
    await interaction.editReply({ content: "このコマンドは指定チャンネルでのみ使用できます。" });
    return;
  }

  const targetUser = interaction.options.getUser("target", true);

  let targetMember: GuildMember;
  try {
    targetMember = await guild.members.fetch(targetUser.id);
  } catch {
    await interaction.editReply({ content: "対象メンバーを取得できませんでした。" });
    return;
  }

  if (isAdmin(targetMember, ctx.config)) {
    const ch = interaction.channel;
    if (ch?.isTextBased() && !ch.isDMBased()) {
      await (ch as TextChannel).send({
        content: `<@${interaction.user.id}> が <@${targetUser.id}> に対し、処刑しようとしました`,
        allowedMentions: { users: [interaction.user.id, targetUser.id] },
      });
    }
    await interaction.editReply({ content: "記録しました。" });
    return;
  }

  const channel = interaction.channel;
  if (!channel || !channel.isTextBased() || channel.isDMBased()) {
    await interaction.editReply({ content: "このチャンネルでは実行できません。" });
    return;
  }
  const textChannel = channel as TextChannel;

  const flowId = randomUUID();
  if (!retainExecutionTarget(flowId, guild.id, targetUser.id)) {
    await interaction.editReply({ content: "この対象では既に処刑フローが進行中です。" });
    return;
  }
  const executorRole = ctx.config.EXECUTOR_ROLE_ID?.trim();
  const needsPrecheck = Boolean(executorRole && !memberHasRoleId(targetMember, executorRole));

  const baseState: ExecutionFlowState = {
    phase: needsPrecheck ? "precheck_pending" : "poll1_pending",
    invoker_id: interaction.user.id,
    target_id: targetUser.id,
    channel_id: textChannel.id,
    precheck_message_id: null,
    precheck_publish_reserved: false,
    poll1_message_id: null,
    poll2_message_id: null,
    votes_poll1: {},
    votes_poll2: {},
    poll1_deadline_ms: 0,
    poll2_deadline_ms: null,
    admin_message_id: null,
    resolved_action: null,
    duration_seconds: null,
    admin_button_fired: false,
  };

  try {
    await ctx.db
      .insertInto("polls")
      .values({
        id: flowId,
        guild_id: guild.id,
        channel_id: textChannel.id,
        message_id: null,
        kind: EXECUTION_FLOW_KIND,
        status: "open",
        state: JSON.stringify(baseState) as unknown as Record<string, unknown>,
        ends_at: null,
        created_at: nowIso() as unknown as Date,
        updated_at: nowIso() as unknown as Date,
        state_revision: 0,
      })
      .execute();
  } catch (err) {
    releaseExecutionTarget(flowId);
    ctx.log.error({ err, flowId, phase: baseState.phase, guildId: guild.id }, "execution: create flow failed");
    await interaction.editReply({ content: "フローの開始に失敗しました。" });
    return;
  }

  if (needsPrecheck) {
    const published = await beginInitialPrecheck(ctx, flowId, guild.id, baseState, textChannel);
    if (!published) {
      releaseExecutionTarget(flowId);
      await interaction.editReply({ content: "事前承認メッセージを投稿できなかったため、フローを開始できませんでした。" });
      return;
    }
    scheduleAdminWait(ctx, flowId, "precheck_pending");
    await interaction.editReply({ content: "管理者の事前承認を待っています。" });
    return;
  }

  try {
    const started = await executionOrchestrator.beginPoll1(ctx, flowId, baseState, guild.id);
    if (!started) {
      await interaction.editReply({ content: "投票チャンネルを取得できなかったため、フローを開始できませんでした。" });
      return;
    }
  } catch (err) {
    releaseExecutionTarget(flowId);
    await ctx.db.deleteFrom("polls").where("id", "=", flowId).execute().catch(() => undefined);
    ctx.log.error({ err, flowId, phase: baseState.phase, guildId: guild.id }, "execution: begin failed");
    await interaction.editReply({ content: "フローの開始に失敗しました。" });
    return;
  }
  await interaction.editReply({ content: "処刑投票を開始しました。" });
}

export async function handleExecutionFlowButton(
  interaction: ButtonInteraction,
  ctx: ExecutionFlowDeps,
): Promise<boolean> {
  if (interaction.customId.startsWith(EXEC_VOTE_PREFIX)) {
    return executionOrchestrator.handleVote(interaction, ctx);
  }
  if (interaction.customId.startsWith(EXEC_APPROVAL_PREFIX)) {
    return executionOrchestrator.handleApproval(interaction, ctx);
  }
  return false;
}
