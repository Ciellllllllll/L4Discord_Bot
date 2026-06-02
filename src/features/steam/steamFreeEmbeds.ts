import { EmbedBuilder } from "discord.js";
import type { SteamFreeCandidate, SteamWatcherStatus } from "./steamFreeTypes.js";

const TYPE_TEXT = {
  giveaway_or_100_percent_off: "無料配布または100%OFFの可能性があります。",
  free_weekend_or_limited_trial: "無料プレイ期間の可能性があります。購入無料とは限りません。",
  free_to_play: "基本無料または恒久無料の可能性があります。",
} as const;

function priceText(value: number | null): string {
  if (value === null) return "不明";
  if (value === 0) return "無料 / 0円";
  return `${value.toLocaleString("ja-JP")}円`;
}

function discountText(value: number | null): string {
  return value === null ? "不明" : `${value}%`;
}

export function buildSteamFreeEmbed(candidate: SteamFreeCandidate): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle("Steam無料情報")
    .setColor(candidate.detectedType === "giveaway_or_100_percent_off" ? 0x2ecc71 : 0x3498db)
    .setDescription(`**${candidate.name}**\n${TYPE_TEXT[candidate.detectedType]}`)
    .addFields(
      { name: "検出種別", value: candidate.detectedType, inline: false },
      { name: "通常価格", value: priceText(candidate.originalPrice), inline: true },
      { name: "現在価格", value: priceText(candidate.finalPrice), inline: true },
      { name: "割引率", value: discountText(candidate.discountPercent), inline: true },
      { name: "SteamストアURL", value: candidate.storeUrl, inline: false },
    )
    .setTimestamp(new Date());
  if (candidate.imageUrl) embed.setImage(candidate.imageUrl);
  return embed;
}

export function buildSteamStatusEmbed(input: {
  enabled: boolean;
  channelId: string | null;
  status: SteamWatcherStatus;
}): EmbedBuilder {
  const channel = input.channelId ? `<#${input.channelId}>` : "未設定";
  return new EmbedBuilder()
    .setTitle("Steam無料通知 状態")
    .setColor(input.enabled ? 0x2ecc71 : 0x95a5a6)
    .addFields(
      { name: "通知状態", value: input.enabled ? "有効" : "無効", inline: true },
      { name: "通知チャンネル", value: channel, inline: true },
      { name: "最終スキャン", value: input.status.lastScanAt ?? "未実行", inline: false },
      { name: "最終成功", value: input.status.lastSuccessAt ?? "未実行", inline: false },
      { name: "直近検出件数", value: String(input.status.lastDetectedCount), inline: true },
      { name: "直近エラー", value: input.status.lastError ?? "なし", inline: false },
    )
    .setTimestamp(new Date());
}

export function buildSteamSummaryText(total: number, shown: number): string | undefined {
  const rest = total - shown;
  if (rest <= 0) return undefined;
  return `ほか${rest}件のSteam無料候補があります。`;
}
