import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
} from "discord.js";

export const VC_OPEN_MODAL_ID = "open_vc_modal";
export const VC_GENRE_SELECT_ID = "vc_genre_select";
export const VC_RENAME_BUTTON_ID = "open_vc_rename";
export const VC_RENAME_GENRE_SELECT_PREFIX = "vc_rename_genre_select:";
export const VC_NAME_MODAL_PREFIX = "vc_name_modal:";
export const VC_RENAME_MODAL_PREFIX = "vc_rename_modal:";

const VC_GENRE_OPTIONS = [
  { label: "雑談", description: "雑談VC", value: "雑談" },
  { label: "ゲーム", description: "ゲーム用VC", value: "ゲーム" },
  { label: "作業", description: "作業や勉強向けVC", value: "作業" },
] as const;

export function buildVcCreatorMainEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("VC作成")
    .setDescription(
      "ジャンルと名前を選んでVCを作成できます。\n接続中の一時VCは「VC名変更」ボタンから名前を変えられます。\nVCは全員が退出した後に自動で削除されます。",
    )
    .setColor(0x9b59b6);
}

export function buildVcCreatorMainRows(): ActionRowBuilder<ButtonBuilder>[] {
  const createButton = new ButtonBuilder()
    .setCustomId(VC_OPEN_MODAL_ID)
    .setLabel("VC作成")
    .setStyle(ButtonStyle.Success);
  const renameButton = new ButtonBuilder()
    .setCustomId(VC_RENAME_BUTTON_ID)
    .setLabel("VC名変更")
    .setStyle(ButtonStyle.Primary);
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(createButton, renameButton)];
}

export function buildVcCreatorGenreRows(customId = VC_GENRE_SELECT_ID): ActionRowBuilder<StringSelectMenuBuilder>[] {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder("VCのジャンルを選んでください")
    .addOptions(...VC_GENRE_OPTIONS);
  return [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)];
}

export function buildVcRenameGenreRows(channelId: string): ActionRowBuilder<StringSelectMenuBuilder>[] {
  return buildVcCreatorGenreRows(`${VC_RENAME_GENRE_SELECT_PREFIX}${channelId}`);
}

export function parseVcRenameGenreSelectId(customId: string): string | null {
  if (!customId.startsWith(VC_RENAME_GENRE_SELECT_PREFIX)) return null;
  const channelId = customId.slice(VC_RENAME_GENRE_SELECT_PREFIX.length).trim();
  return /^\d+$/.test(channelId) ? channelId : null;
}

export function buildVcRenameModalCustomId(channelId: string, genre: string): string {
  return `${VC_RENAME_MODAL_PREFIX}${channelId}:${genre}`;
}

export function parseVcRenameModalCustomId(customId: string): { channelId: string; genre: string } | null {
  if (!customId.startsWith(VC_RENAME_MODAL_PREFIX)) return null;
  const body = customId.slice(VC_RENAME_MODAL_PREFIX.length);
  const sep = body.indexOf(":");
  if (sep <= 0) return null;
  const channelId = body.slice(0, sep).trim();
  const genre = body.slice(sep + 1).trim();
  if (!/^\d+$/.test(channelId) || !genre) return null;
  return { channelId, genre };
}

