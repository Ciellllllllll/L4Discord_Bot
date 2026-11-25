import { MessageFlags, type ButtonInteraction, type ModalSubmitInteraction } from "discord.js";
import type { BotContext } from "../../bot/context.js";
import { handleSlashCommand } from "../../commands/slashHandlers.js";
import {
  consumeAnonymousSurveySession,
  createAnonymousSurveySession,
  getAnonymousSurveySession,
  parseAnonymousSurveySubmission,
  recordAnonymousSurveyAnswer,
  recordAnonymousSurveySkip,
  type AnonymousSurveySessionAction,
} from "./surveyService.js";
import { createSurveyReplayInteraction } from "./surveyCommandState.js";
import { ephemeralComponentPayload } from "../../core/componentCard.js";
import {
  SURVEY_BUG_REPORT_FIELD_ID,
  SURVEY_CONTINUE_PREFIX,
  SURVEY_IMPROVEMENT_FIELD_ID,
  SURVEY_LEGACY_BUTTON_PREFIXES,
  SURVEY_MODAL_PREFIX,
  SURVEY_RATING_FIELD_ID,
  buildAnonymousSurveyCompletedMessage,
  buildAnonymousSurveyContinueMessage,
  buildAnonymousSurveyExpiredMessage,
} from "./surveyUi.js";

const MODAL_SLASH_COMMANDS = new Set(["change_prompt", "create_prompt"]);
const SURVEY_ONLY_SLASH_COMMANDS = new Set(["survey"]);

function parseActionId(customId: string, prefix: string): string | null {
  if (!customId.startsWith(prefix)) return null;
  const sessionId = customId.slice(prefix.length).trim();
  return sessionId || null;
}

async function getOwnedSessionOrReply(
  interaction: ButtonInteraction | ModalSubmitInteraction,
  ctx: BotContext,
  sessionId: string,
  action: AnonymousSurveySessionAction = "slashGate",
) {
  const session = await getAnonymousSurveySession(ctx.db, sessionId, action);
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

function readTextField(interaction: ModalSubmitInteraction, customId: string): string | null {
  try {
    return interaction.fields.getTextInputValue(customId);
  } catch {
    return null;
  }
}

function readStringSelectField(interaction: ModalSubmitInteraction, customId: string): readonly string[] {
  try {
    return interaction.fields.getStringSelectValues(customId);
  } catch {
    return [];
  }
}

export async function handleAnonymousSurveyModalSubmit(interaction: ModalSubmitInteraction, ctx: BotContext): Promise<boolean> {
  const sessionId = parseActionId(interaction.customId, SURVEY_MODAL_PREFIX);
  if (!sessionId) return false;
  if (!(await getOwnedSessionOrReply(interaction, ctx, sessionId))) return true;
  const session = await consumeAnonymousSurveySession(ctx.db, sessionId, interaction.user.id);
  if (!session) {
    await interaction.reply({ ...buildAnonymousSurveyExpiredMessage(), flags: MessageFlags.Ephemeral });
    return true;
  }

  const submission = parseAnonymousSurveySubmission(
    readStringSelectField(interaction, SURVEY_RATING_FIELD_ID),
    readTextField(interaction, SURVEY_IMPROVEMENT_FIELD_ID),
    readTextField(interaction, SURVEY_BUG_REPORT_FIELD_ID),
  );
  const recording = submission.kind === "answer"
    ? recordAnonymousSurveyAnswer(ctx.db, session.guildId, interaction.user.id, submission)
    : recordAnonymousSurveySkip(ctx.db, session.guildId, interaction.user.id);

  if (SURVEY_ONLY_SLASH_COMMANDS.has(session.command.commandName)) {
    await recording;
    await interaction.reply(ephemeralComponentPayload(buildAnonymousSurveyCompletedMessage(submission.kind)));
    return true;
  }
  if (MODAL_SLASH_COMMANDS.has(session.command.commandName)) {
    const [, continueSessionId] = await Promise.all([
      recording,
      createAnonymousSurveySession(ctx.db, session.guildId, interaction.user.id, session.command, "continueCommand"),
    ]);
    await interaction.reply(ephemeralComponentPayload(buildAnonymousSurveyContinueMessage(submission.kind, continueSessionId)));
    return true;
  }
  // 最初の応答は 3 秒以内に必要なため、回答の保存を待たずにコマンドを実行する
  const recorded = recording.catch((err: unknown) => {
    ctx.log.error({ err, guildId: session.guildId }, "failed to record anonymous survey submission");
  });
  try {
    await handleSlashCommand(createSurveyReplayInteraction(interaction, session.command), ctx, { skipSurvey: true });
  } finally {
    await recorded;
  }
  return true;
}

export async function handleAnonymousSurveyButton(interaction: ButtonInteraction, ctx: BotContext): Promise<boolean> {
  const continueSessionId = parseActionId(interaction.customId, SURVEY_CONTINUE_PREFIX);
  if (continueSessionId) {
    if (!(await getOwnedSessionOrReply(interaction, ctx, continueSessionId, "continueCommand"))) return true;
    const session = await consumeAnonymousSurveySession(ctx.db, continueSessionId, interaction.user.id, "continueCommand");
    if (!session) {
      await interaction.reply({ ...buildAnonymousSurveyExpiredMessage(), flags: MessageFlags.Ephemeral });
      return true;
    }
    await handleSlashCommand(createSurveyReplayInteraction(interaction, session.command), ctx, { skipSurvey: true });
    return true;
  }

  if (SURVEY_LEGACY_BUTTON_PREFIXES.some((prefix) => interaction.customId.startsWith(prefix))) {
    await interaction.reply({ ...buildAnonymousSurveyExpiredMessage(), flags: MessageFlags.Ephemeral });
    return true;
  }

  return false;
}
