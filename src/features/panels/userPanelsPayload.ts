import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type Message,
  type MessageCreateOptions,
} from "discord.js";
import { buildContainerPanelPayload, messageComponentsHaveCustomId } from "./componentPanelPayload.js";

export const USER_PANEL_MODMAIL_BUTTON_ID = "panels:user:mm";
export const USER_PANEL_TICKET_BUTTON_ID = "panels:user:tk";

export function userContactPanelMessageMatches(message: Message, botUserId: string): boolean {
  if (message.author?.id !== botUserId) return false;
  return messageComponentsHaveCustomId(message.components, new Set([USER_PANEL_MODMAIL_BUTTON_ID]));
}

export function buildUserContactPanelPayload(): MessageCreateOptions {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(USER_PANEL_MODMAIL_BUTTON_ID)
      .setLabel("お問い合わせを始める")
      .setStyle(ButtonStyle.Primary),
  );
  return buildContainerPanelPayload(
    [
      "## サポート・お問い合わせ",
      "スタッフへ個別に相談したい内容を送信できます。",
      "ボタンを押すと、DMに入力案内が届きます。",
      "",
      "**受付内容**",
      "タイトル、詳細、添付ファイルを入力できます。",
      "",
      "**送信先**",
      "内容はスタッフ用スレッドに届きます。",
    ].join("\n"),
    [row],
  );
}
