import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { APPEAL_START_PREFIX } from "./appealConstants.js";

export function buildAppealStartRows(ctxId: string): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${APPEAL_START_PREFIX}${ctxId}`)
        .setLabel("異議申し立て")
        .setStyle(ButtonStyle.Primary),
    ),
  ];
}
