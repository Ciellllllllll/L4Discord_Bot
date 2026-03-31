import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type Message,
  type MessageCreateOptions,
} from "discord.js";

export const USER_PANEL_MODMAIL_BUTTON_ID = "panels:user:mm";
export const USER_PANEL_TICKET_BUTTON_ID = "panels:user:tk";

export function userContactPanelMessageMatches(message: Message, botUserId: string): boolean {
  if (message.author?.id !== botUserId) return false;
  let hasMm = false;
  let hasTk = false;
  for (const row of message.components) {
    if (!("components" in row) || !row.components) continue;
    for (const c of row.components) {
      if ("customId" in c && typeof c.customId === "string") {
        if (c.customId === USER_PANEL_MODMAIL_BUTTON_ID) hasMm = true;
        if (c.customId === USER_PANEL_TICKET_BUTTON_ID) hasTk = true;
      }
    }
  }
  return hasMm && hasTk;
}

export function buildUserContactPanelPayload(): MessageCreateOptions {
  const embed = new EmbedBuilder()
    .setTitle("サポート・お問い合わせ")
    .setDescription(
      "Modmail: DM に「チケットを作成」ボタンが届き、モーダルで受付します。チケット: このチャット内（非公開）だけで同じ受付ができます。",
    )
    .setColor(0x57f287);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(USER_PANEL_MODMAIL_BUTTON_ID)
      .setLabel("Modmailを始める")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(USER_PANEL_TICKET_BUTTON_ID)
      .setLabel("チケットを作る")
      .setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row] };
}
