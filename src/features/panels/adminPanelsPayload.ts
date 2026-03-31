import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type Message,
  type MessageCreateOptions,
} from "discord.js";
import { PANEL_BUTTON_ID } from "../messageLog/messageLogsView.js";

export function messageLogPanelMessageMatches(message: Message, botUserId: string): boolean {
  if (message.author?.id !== botUserId) return false;
  for (const row of message.components) {
    if (!("components" in row) || !row.components) continue;
    for (const c of row.components) {
      if ("customId" in c && c.customId === PANEL_BUTTON_ID) return true;
    }
  }
  return false;
}

export function buildMessageLogPanelPayload(): MessageCreateOptions {
  const embed = new EmbedBuilder()
    .setTitle("メッセージログ")
    .setDescription("ボタンから全文検索（FTS）を開きます。管理者・ログ閲覧権限が必要です。")
    .setColor(0x3498db);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(PANEL_BUTTON_ID).setLabel("ログを検索").setStyle(ButtonStyle.Primary),
  );
  return { embeds: [embed], components: [row] };
}
