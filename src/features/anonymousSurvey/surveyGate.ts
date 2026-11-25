import { type ChatInputCommandInteraction, type GuildMember } from "discord.js";
import type { BotContext } from "../../bot/context.js";
import { isAdmin } from "../../core/permission.js";
import {
  canPromptAnonymousSurvey,
  createAnonymousSurveySession,
} from "./surveyService.js";
import { storeSlashCommand } from "./surveyCommandState.js";
import { buildAnonymousSurveyModal } from "./surveyUi.js";

type AnonymousSurveyPromptOptions = {
  ignoreAdmin?: boolean;
  ignoreCooldown?: boolean;
};

export async function promptAnonymousSurvey(
  interaction: ChatInputCommandInteraction,
  ctx: BotContext,
  member: GuildMember | null,
  options: AnonymousSurveyPromptOptions = {},
): Promise<boolean> {
  if (!interaction.inGuild() || !interaction.guildId) return false;
  if (!options.ignoreAdmin && member && isAdmin(member, ctx.config)) return false;
  if (
    !options.ignoreCooldown &&
    !(await canPromptAnonymousSurvey(ctx.db, interaction.guildId, interaction.user.id))
  ) {
    return false;
  }

  const sessionId = await createAnonymousSurveySession(
    ctx.db,
    interaction.guildId,
    interaction.user.id,
    storeSlashCommand(interaction),
  );
  await interaction.showModal(buildAnonymousSurveyModal(sessionId));
  return true;
}
