import { ComponentCardBuilder } from "../../core/componentCard.js";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type TextChannel } from "discord.js";
import { discordVoteDeadlineEmbedLine } from "./executionConstants.js";
import {
  TE_APPROVAL_PREFIX,
  TE_VOTE_PREFIX,
  TE_POLL1_KEYS,
  TE_POLL1_LABEL,
  TE_POLL2_KEYS,
  TE_POLL2_LABEL,
} from "./timeoutExtendConstants.js";
import { tallyChoices } from "./twoStagePollTally.js";
import type { TimeoutExtendFlowState } from "./timeoutExtendFlow.types.js";
import { editPollMessagesStopped } from "./pollFlowHelpers.js";
import type { TimeoutExtendFlowDeps } from "./timeoutExtendFlowCore.js";

// タイムアウト延長フローの表示の組み立て。

export function buildPoll1Embed(state: TimeoutExtendFlowState, poll1DeadlineMs: number, pollEnded = false): ComponentCardBuilder {
  const counts = tallyChoices(state.votes_poll1, [...TE_POLL1_KEYS]);
  const lines = TE_POLL1_KEYS.map((k) => `**${TE_POLL1_LABEL[k]}** — ${counts[k] ?? 0} 票`);
  return new ComponentCardBuilder()
    .setTitle("タイムアウト処理を選択")
    .setDescription(
      [`対象: <@${state.target_id}>`, "", ...lines, "", discordVoteDeadlineEmbedLine(poll1DeadlineMs, pollEnded)].join("\n"),
    )
    .setTimestamp(new Date());
}

export function buildPoll2Embed(state: TimeoutExtendFlowState, poll2DeadlineMs: number, pollEnded = false): ComponentCardBuilder {
  const counts = tallyChoices(state.votes_poll2, [...TE_POLL2_KEYS]);
  const lines = TE_POLL2_KEYS.map((k) => `**${TE_POLL2_LABEL[k]}** — ${counts[k] ?? 0} 票`);
  return new ComponentCardBuilder()
    .setTitle("延長時間を選択")
    .setDescription(
      [`対象: <@${state.target_id}>`, "", ...lines, "", discordVoteDeadlineEmbedLine(poll2DeadlineMs, pollEnded)].join("\n"),
    )
    .setTimestamp(new Date());
}

export function tePoll1Rows(flowId: string, disabled: boolean): ActionRowBuilder<ButtonBuilder>[] {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...TE_POLL1_KEYS.map((k) =>
      new ButtonBuilder()
        .setCustomId(`${TE_VOTE_PREFIX}${flowId}:${k}`)
        .setLabel(TE_POLL1_LABEL[k])
        .setStyle(ButtonStyle.Primary)
        .setDisabled(disabled),
    ),
  );
  return [row];
}

export function tePoll2Rows(flowId: string, disabled: boolean): ActionRowBuilder<ButtonBuilder>[] {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...TE_POLL2_KEYS.map((k) =>
      new ButtonBuilder()
        .setCustomId(`${TE_VOTE_PREFIX}${flowId}:${k}`)
        .setLabel(TE_POLL2_LABEL[k])
        .setStyle(ButtonStyle.Primary)
        .setDisabled(disabled),
    ),
  );
  return [row];
}

export function teApprovalRows(flowId: string, disabled: boolean): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${TE_APPROVAL_PREFIX}${flowId}:approve`)
        .setLabel("承認")
        .setStyle(ButtonStyle.Success)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId(`${TE_APPROVAL_PREFIX}${flowId}:deny`)
        .setLabel("非承認")
        .setStyle(ButtonStyle.Danger)
        .setDisabled(disabled),
    ),
  ];
}

export async function editTeMessagesStopped(
  ctx: TimeoutExtendFlowDeps,
  channel: TextChannel,
  messages: Array<{ id: string | null | undefined; components: ActionRowBuilder<ButtonBuilder>[] }>,
  heading: string,
): Promise<void> {
  await editPollMessagesStopped(ctx, channel, messages, heading, "timeoutExtend");
}
