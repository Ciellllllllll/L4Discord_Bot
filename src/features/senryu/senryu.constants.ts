// Discord 除外: メンション・チャンネル・ロール・カスタム絵文字・URL

export const DISCORD_TOKEN_PATTERN =
  /<@!?\d+>|<#\d+>|<@&\d+>|<a?:\w+:\d+>|https?:\/\/\S+/;

export const SPOILER_PATTERN = /\|\|.+?\|\|/;

export const KATAKANA_ONLY_PATTERN = /^[ァ-ヾ]+$/;
