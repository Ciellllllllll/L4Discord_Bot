import { randomUUID } from "node:crypto";
import { MessageFlags, type ButtonInteraction, type ChatInputCommandInteraction, type Guild, type GuildMember, type TextChannel } from "discord.js";
import { nowIso } from "../../core/db/nowIso.js";
import { TE_APPROVAL_PREFIX, TE_VOTE_PREFIX, TIMEOUT_EXTEND_FLOW_KIND } from "./timeoutExtendConstants.js";
import type { TimeoutExtendFlowState } from "./timeoutExtendFlow.types.js";
import {
  retainTimeoutExtendTarget,
  releaseTimeoutExtendTarget,
  type TimeoutExtendFlowDeps,
} from "./timeoutExtendFlowCore.js";
import { timeoutExtendOrchestrator } from "./timeoutExtendFlow.js";

// タイムアウト延長フローの入口。

async function resolveVoteTextChannel(
  ctx: TimeoutExtendFlowDeps,
  guild: Guild,
  interaction: ChatInputCommandInteraction,
): Promise<TextChannel | null> {
  const configured = ctx.config.TIMEOUT_EXTEND_VOTE_CHANNEL_ID?.trim();
  if (configured) {
    const ch = await guild.channels.fetch(configured).catch(() => null);
    if (ch?.isTextBased() && !ch.isDMBased()) return ch as TextChannel;
    return null;
  }
  const ch = interaction.channel;
  if (ch?.isTextBased() && !ch.isDMBased()) return ch as TextChannel;
  return null;
}

export async function startTimeoutExtendFlow(
  interaction: ChatInputCommandInteraction,
  ctx: TimeoutExtendFlowDeps,
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

  const until = targetMember.communicationDisabledUntil;
  if (!until || until.getTime() <= Date.now()) {
    await interaction.editReply({ content: "対象は現在有効なタイムアウト状態ではありません。" });
    return;
  }

  const voteChannel = await resolveVoteTextChannel(ctx, guild, interaction);
  if (!voteChannel) {
    await interaction.editReply({
      content: ctx.config.TIMEOUT_EXTEND_VOTE_CHANNEL_ID?.trim()
        ? "投票投稿先チャンネル（TIMEOUT_EXTEND_VOTE_CHANNEL_ID）を取得できませんでした。"
        : "このチャンネルでは実行できません。",
    });
    return;
  }

  const flowId = randomUUID();
  if (!retainTimeoutExtendTarget(flowId, guild.id, targetUser.id)) {
    await interaction.editReply({ content: "この対象では既にタイムアウト延長フローが進行中です。" });
    return;
  }

  const baseState: TimeoutExtendFlowState = {
    phase: "poll1_pending",
    invoker_id: interaction.user.id,
    target_id: targetUser.id,
    channel_id: voteChannel.id,
    poll1_message_id: null,
    poll1_publish_reserved: false,
    poll2_message_id: null,
    admin_message_id: null,
    votes_poll1: {},
    votes_poll2: {},
    poll1_deadline_ms: 0,
    poll2_deadline_ms: null,
    resolved_extend: null,
    duration_seconds: null,
    admin_button_fired: false,
  };

  try {
    await ctx.db
      .insertInto("polls")
      .values({
        id: flowId,
        guild_id: guild.id,
        channel_id: voteChannel.id,
        message_id: null,
        kind: TIMEOUT_EXTEND_FLOW_KIND,
        status: "open",
        state: JSON.stringify(baseState) as unknown as Record<string, unknown>,
        ends_at: null,
        created_at: nowIso() as unknown as Date,
        updated_at: nowIso() as unknown as Date,
        state_revision: 0,
      })
      .execute();
  } catch (err) {
    releaseTimeoutExtendTarget(flowId);
    ctx.log.error({ err, flowId, guildId: guild.id, phase: baseState.phase }, "timeoutExtend: create flow failed");
    await interaction.editReply({ content: "フローの開始に失敗しました。" });
    return;
  }

  try {
    const started = await timeoutExtendOrchestrator.beginPoll1(ctx, flowId, baseState, guild.id);
    if (!started) {
      releaseTimeoutExtendTarget(flowId);
      await interaction.editReply({ content: "投票チャンネルを取得できなかったため、フローを開始できませんでした。" });
      return;
    }
  } catch (err) {
    releaseTimeoutExtendTarget(flowId);
    await ctx.db.deleteFrom("polls").where("id", "=", flowId).execute().catch(() => undefined);
    ctx.log.error({ err, flowId, phase: baseState.phase, guildId: guild.id }, "timeoutExtend: begin failed");
    await interaction.editReply({ content: "フローの開始に失敗しました。" });
    return;
  }

  await interaction.editReply({
    content: `タイムアウト延長の投票を開始しました（投稿先: <#${voteChannel.id}>）。`,
  });
}

export async function handleTimeoutExtendFlowButton(interaction: ButtonInteraction, ctx: TimeoutExtendFlowDeps): Promise<boolean> {
  if (interaction.customId.startsWith(TE_VOTE_PREFIX)) {
    return timeoutExtendOrchestrator.handleVote(interaction, ctx);
  }
  if (interaction.customId.startsWith(TE_APPROVAL_PREFIX)) {
    return timeoutExtendOrchestrator.handleApproval(interaction, ctx);
  }
  return false;
}
