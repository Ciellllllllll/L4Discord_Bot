import { ComponentCardBuilder } from "../../core/componentCard.js";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type TextChannel } from "discord.js";
import {
  discordVoteDeadlineEmbedLine,
  EXEC_APPROVAL_PREFIX,
  EXEC_VOTE_PREFIX,
  POLL1_KEYS,
  POLL1_LABEL,
  POLL2_KEYS,
  POLL2_LABEL,
} from "./executionConstants.js";
import { tallyChoices } from "./twoStagePollTally.js";
import type { ExecutionAction, ExecutionFlowState } from "./executionFlow.types.js";
import { editPollMessagesStopped } from "./pollFlowHelpers.js";
import type { ExecutionFlowDeps } from "./executionFlowCore.js";

// 処刑フローの表示の組み立て。

export function choiceToAction1(c: string): ExecutionAction | null {
  if (c === "1") return "timeout";
  if (c === "2") return "kick";
  if (c === "3") return "ban";
  return null;
}

/** 処刑フロー第1投票（処刑内容）。`pollEnded` 後は `:R` を使わず増加表示を防ぐ */
export function buildPoll1Embed(state: ExecutionFlowState, poll1DeadlineMs: number, pollEnded = false): ComponentCardBuilder {
  const counts = tallyChoices(state.votes_poll1, POLL1_KEYS);
  const lines = POLL1_KEYS.map((k) => `**${k}.** ${POLL1_LABEL[k]} — ${counts[k] ?? 0} 票`);
  return new ComponentCardBuilder()
    .setTitle("処刑内容の投票")
    .setDescription(
      [
        `対象: <@${state.target_id}>`,
        "",
        "**投票先（ボタン 1〜3）**",
        ...lines,
        "",
        discordVoteDeadlineEmbedLine(poll1DeadlineMs, pollEnded),
      ].join("\n"),
    )
    .setTimestamp(new Date());
}

/** 処刑フロー第2投票（タイムアウト時間） */
export function buildPoll2Embed(state: ExecutionFlowState, poll2DeadlineMs: number, pollEnded = false): ComponentCardBuilder {
  const counts = tallyChoices(state.votes_poll2, POLL2_KEYS);
  const lines = POLL2_KEYS.map((k) => `**${k}.** ${POLL2_LABEL[k]} — ${counts[k] ?? 0} 票`);
  return new ComponentCardBuilder()
    .setTitle("タイムアウト時間の投票")
    .setDescription(
      [
        `対象: <@${state.target_id}>`,
        "",
        "**投票先（ボタン 1〜4）**",
        ...lines,
        "",
        discordVoteDeadlineEmbedLine(poll2DeadlineMs, pollEnded),
      ].join("\n"),
    )
    .setTimestamp(new Date());
}

export function poll1Rows(flowId: string, disabled: boolean): ActionRowBuilder<ButtonBuilder>[] {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...POLL1_KEYS.map((k) =>
      new ButtonBuilder()
        .setCustomId(`${EXEC_VOTE_PREFIX}${flowId}:${k}`)
        .setLabel(k)
        .setStyle(ButtonStyle.Primary)
        .setDisabled(disabled),
    ),
  );
  return [row];
}

export function poll2Rows(flowId: string, disabled: boolean): ActionRowBuilder<ButtonBuilder>[] {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...POLL2_KEYS.map((k) =>
      new ButtonBuilder()
        .setCustomId(`${EXEC_VOTE_PREFIX}${flowId}:${k}`)
        .setLabel(k)
        .setStyle(ButtonStyle.Primary)
        .setDisabled(disabled),
    ),
  );
  return [row];
}

export function approvalRows(flowId: string, disabled: boolean): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${EXEC_APPROVAL_PREFIX}${flowId}:approve`)
        .setLabel("承認")
        .setStyle(ButtonStyle.Success)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId(`${EXEC_APPROVAL_PREFIX}${flowId}:deny`)
        .setLabel("非承認")
        .setStyle(ButtonStyle.Danger)
        .setDisabled(disabled),
    ),
  ];
}

export async function editMessagesStopped(
  ctx: ExecutionFlowDeps,
  channel: TextChannel,
  messages: Array<{ id: string | null | undefined; components: ActionRowBuilder<ButtonBuilder>[] }>,
  heading: string,
): Promise<void> {
  await editPollMessagesStopped(ctx, channel, messages, heading, "execution");
}
