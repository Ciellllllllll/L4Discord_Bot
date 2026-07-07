import { MessageFlags, type ChatInputCommandInteraction, type GuildMember } from "discord.js";
import type { BotContext } from "../../bot/context.js";
import { isAdmin } from "../../core/permission.js";
import {
  canPromptAnonymousSurvey,
  createAnonymousSurveySession,
} from "./surveyService.js";
import { storeSlashCommand } from "./surveyCommandState.js";
import { buildAnonymousSurveyMessage } from "./surveyUi.js";

export async function maybePromptAnonymousSurvey(
  interaction: ChatInputCommandInteraction,
  ctx: BotContext,
  member: GuildMember | null,
): Promise<boolean> {
  if (ctx.config.DB_DRIVER !== "postgres") return false;
  if (!interaction.inGuild() || !interaction.guildId) return false;
  if (member && isAdmin(member, ctx.config)) return false;
  if (!(await canPromptAnonymousSurvey(ctx.db, interaction.guildId, interaction.user.id))) return false;

  const sessionId = await createAnonymousSurveySession(
    ctx.db,
    interaction.guildId,
    interaction.user.id,
    storeSlashCommand(interaction),
  );
  await interaction.reply({
    ...buildAnonymousSurveyMessage(sessionId),
    flags: MessageFlags.Ephemeral,
  });
  return true;
}
