import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  type MessageCreateOptions,
} from "discord.js";

export const VC_OPEN_MODAL_ID = "open_vc_modal";
export const VC_GENRE_SELECT_ID = "vc_genre_select";
export const VC_NAME_MODAL_PREFIX = "vc_name_modal:";

export function buildVcCreatorMainEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("VC作成")
    .setDescription(
      "ジャンルと名前を選んでVCを作成できます。\nVCは全員が退出した後に自動で削除されます。",
    )
    .setColor(0x9b59b6);
}

export function buildVcCreatorMainRows(): ActionRowBuilder<ButtonBuilder>[] {
  const button = new ButtonBuilder()
    .setCustomId(VC_OPEN_MODAL_ID)
    .setLabel("VC作成")
    .setStyle(ButtonStyle.Success);
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(button)];
}

export function buildVcCreatorGenreRows(): ActionRowBuilder<StringSelectMenuBuilder>[] {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(VC_GENRE_SELECT_ID)
    .setPlaceholder("VCのジャンルを選んでください")
    .addOptions(
      { label: "雑談", description: "雑談VC", value: "雑談" },
      { label: "ゲーム", description: "ゲーム用VC", value: "ゲーム" },
      { label: "作業", description: "作業や勉強向けVC", value: "作業" },
    );
  return [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)];
}

export function buildVcCreatorPanelPayload(): Pick<MessageCreateOptions, "embeds" | "components"> {
  return {
    embeds: [buildVcCreatorMainEmbed()],
    components: buildVcCreatorMainRows(),
  };
}
