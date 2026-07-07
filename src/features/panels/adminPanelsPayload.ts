import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type Message,
  type MessageCreateOptions,
} from "discord.js";
import { PANEL_BUTTON_ID } from "../messageLog/messageLogsView.js";
import { buildContainerPanelPayload, messageComponentsHaveCustomId } from "./componentPanelPayload.js";

export function messageLogPanelMessageMatches(message: Message, botUserId: string): boolean {
  if (message.author?.id !== botUserId) return false;
  return messageComponentsHaveCustomId(message.components, new Set([PANEL_BUTTON_ID]));
}

export function buildMessageLogPanelPayload(): MessageCreateOptions {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(PANEL_BUTTON_ID).setLabel("ログを検索").setStyle(ButtonStyle.Primary),
  );
  return buildContainerPanelPayload(
    [
      "## メッセージログ",
      "削除・編集・添付を含むサーバーメッセージの記録を検索できます。",
      "",
      "**管理者向け**   条件検索   詳細確認   添付一覧",
      "必要なログだけを検索条件で絞り込みます。",
      "",
    ].join("\n"),
    [row],
  );
}
