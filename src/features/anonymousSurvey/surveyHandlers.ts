import { MessageFlags, type ButtonInteraction } from "discord.js";
import type { BotContext } from "../../bot/context.js";
import { handleSlashCommand } from "../../commands/slashHandlers.js";
import {
  consumeAnonymousSurveySession,
  getAnonymousSurveySession,
  recordAnonymousSurveyAnswer,
  recordAnonymousSurveySkip,
} from "./surveyService.js";
import { createSurveyReplayInteraction } from "./surveyCommandState.js";
import {
  SURVEY_RATING_PREFIX,
  SURVEY_SKIP_PREFIX,
  SURVEY_SUBMIT_PREFIX,
  buildAnonymousSurveyCompletedMessage,
  buildAnonymousSurveyExpiredMessage,
  buildAnonymousSurveyMessage,
} from "./surveyUi.js";

const MODAL_SLASH_COMMANDS = new Set(["change_prompt", "create_prompt"]);
const SURVEY_ONLY_SLASH_COMMANDS = new Set(["survey"]);

function parseRatingId(customId: string): { sessionId: string; rating: number } | null {
  if (!customId.startsWith(SURVEY_RATING_PREFIX)) return null;
  const rest = customId.slice(SURVEY_RATING_PREFIX.length);
  const splitAt = rest.lastIndexOf(":");
  if (splitAt < 1) return null;
  const sessionId = rest.slice(0, splitAt);
  const rating = Number(rest.slice(splitAt + 1));
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return null;
  return { sessionId, rating };
}

function parseActionId(customId: string, prefix: string): string | null {
  if (!customId.startsWith(prefix)) return null;
  const sessionId = customId.slice(prefix.length).trim();
  return sessionId || null;
}

function parseSubmitId(customId: string): { sessionId: string; rating: number | null } | null {
  const sessionId = parseActionId(customId, SURVEY_SUBMIT_PREFIX);
  if (!sessionId) return null;
  const splitAt = sessionId.lastIndexOf(":");
  if (splitAt < 1) return { sessionId, rating: null };
  const rawRating = sessionId.slice(splitAt + 1);
  const rating = Number(rawRating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return { sessionId, rating: null };
  return { sessionId: sessionId.slice(0, splitAt), rating };
}

async function getOwnedSessionOrReply(
  interaction: ButtonInteraction,
  ctx: BotContext,
  sessionId: string,
) {
  const session = await getAnonymousSurveySession(ctx.db, sessionId);
  if (!session) {
    await interaction.reply({ ...buildAnonymousSurveyExpiredMessage(), flags: MessageFlags.Ephemeral });
    return null;
  }
  if (session.executorUserId && session.executorUserId !== interaction.user.id) {
    await interaction.reply({ content: "このアンケートは実行したユーザーのみ操作できます。", flags: MessageFlags.Ephemeral });
    return null;
  }
  return session;
}

export async function handleAnonymousSurveyButton(interaction: ButtonInteraction, ctx: BotContext): Promise<boolean> {
  const rating = parseRatingId(interaction.customId);
  if (rating) {
    const session = await getOwnedSessionOrReply(interaction, ctx, rating.sessionId);
    if (!session) return true;
    await interaction.update(buildAnonymousSurveyMessage(rating.sessionId, rating.rating));
    return true;
  }

  const submit = parseSubmitId(interaction.customId);
  if (submit) {
    if (!submit.rating) {
      await interaction.reply({ content: "満足度を選択してから送信してください。", flags: MessageFlags.Ephemeral });
      return true;
    }
    if (!(await getOwnedSessionOrReply(interaction, ctx, submit.sessionId))) return true;
    const session = await consumeAnonymousSurveySession(ctx.db, submit.sessionId, interaction.user.id);
    if (!session) {
      await interaction.reply({ ...buildAnonymousSurveyExpiredMessage(), flags: MessageFlags.Ephemeral });
      return true;
    }
    await recordAnonymousSurveyAnswer(ctx.db, session.guildId, interaction.user.id, submit.rating);
    if (SURVEY_ONLY_SLASH_COMMANDS.has(session.command.commandName)) {
      await interaction.update(buildAnonymousSurveyCompletedMessage("answer"));
      return true;
    }
    const preferFollowUp = !MODAL_SLASH_COMMANDS.has(session.command.commandName);
    if (preferFollowUp) await interaction.update(buildAnonymousSurveyCompletedMessage("answer"));
    await handleSlashCommand(createSurveyReplayInteraction(interaction, session.command, { preferFollowUp }), ctx, { skipSurvey: true });
    return true;
  }

  const skipSessionId = parseActionId(interaction.customId, SURVEY_SKIP_PREFIX);
  if (skipSessionId) {
    if (!(await getOwnedSessionOrReply(interaction, ctx, skipSessionId))) return true;
    const session = await consumeAnonymousSurveySession(ctx.db, skipSessionId, interaction.user.id);
    if (!session) {
      await interaction.reply({ ...buildAnonymousSurveyExpiredMessage(), flags: MessageFlags.Ephemeral });
      return true;
    }
    await recordAnonymousSurveySkip(ctx.db, session.guildId, interaction.user.id);
    if (SURVEY_ONLY_SLASH_COMMANDS.has(session.command.commandName)) {
      await interaction.update(buildAnonymousSurveyCompletedMessage("skip"));
      return true;
    }
    const preferFollowUp = !MODAL_SLASH_COMMANDS.has(session.command.commandName);
    if (preferFollowUp) await interaction.update(buildAnonymousSurveyCompletedMessage("skip"));
    await handleSlashCommand(createSurveyReplayInteraction(interaction, session.command, { preferFollowUp }), ctx, { skipSurvey: true });
    return true;
  }

  return false;
}
