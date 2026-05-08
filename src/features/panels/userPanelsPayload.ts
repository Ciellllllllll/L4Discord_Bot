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
  for (const row of message.components) {
    if (!("components" in row) || !row.components) continue;
    for (const c of row.components) {
      if ("customId" in c && typeof c.customId === "string") {
        if (c.customId === USER_PANEL_MODMAIL_BUTTON_ID) hasMm = true;
      }
    }
  }
  return hasMm;
}

export function buildUserContactPanelPayload(): MessageCreateOptions {
  const embed = new EmbedBuilder()
    .setTitle("サポート・お問い合わせ")
    .setDescription(
      "「Modmailを始める」で DM に案内が届きます。DM の「チケットを作成」からタイトル・詳細・添付を入力すると、スタッフ側にチケットが作成されます。",
    )
    .setColor(0x57f287);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(USER_PANEL_MODMAIL_BUTTON_ID)
      .setLabel("Modmailを始める")
      .setStyle(ButtonStyle.Primary),
  );
  return { embeds: [embed], components: [row] };
}
