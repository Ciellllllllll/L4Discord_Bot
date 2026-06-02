import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";
import type { CheapSharkDeal } from "./cheapSharkTypes.js";
import type { GameDealStatus, GameDealSubscriptionHit } from "./gameDealTypes.js";

function priceText(value: number | null): string {
  if (value === null) return "不明";
  if (value === 0) return "無料 / 0円";
  return `${value.toLocaleString("ja-JP")}円`;
}

function discountText(value: number | null): string {
  return value === null ? "不明" : `${value}%`;
}

export function buildGameDealStatusEmbed(input: {
  enabled: boolean;
  channelId: string | null;
  status: GameDealStatus;
}): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("ゲーム無料お知らせ 状態")
    .setColor(input.enabled ? 0x2ecc71 : 0x95a5a6)
    .addFields(
      { name: "通知状態", value: input.enabled ? "有効" : "無効", inline: true },
      { name: "通知チャンネル", value: input.channelId ? `<#${input.channelId}>` : "未設定", inline: true },
      { name: "最終スキャン", value: input.status.lastScanAt ?? "未実行", inline: false },
      { name: "最終成功", value: input.status.lastSuccessAt ?? "未実行", inline: false },
      { name: "直近検出件数", value: String(input.status.lastDetectedCount), inline: true },
      { name: "直近エラー", value: input.status.lastError ?? "なし", inline: false },
      { name: "Steam検索状態", value: input.status.lastSteamSearchStatus ?? "未実行", inline: true },
      { name: "Steam検索クールダウン", value: input.status.steamSearchCooldownUntil ?? "なし", inline: false },
      { name: "Steam検索エラー", value: input.status.lastSteamSearchError ?? "なし", inline: false },
    )
    .setTimestamp(new Date());
}

export function buildGameDealSummaryText(total: number, shown: number): string | undefined {
  const rest = total - shown;
  return rest > 0 ? `ほか${rest}件のゲーム無料候補があります。` : undefined;
}

export function buildSubscriptionDealEmbed(hit: GameDealSubscriptionHit): EmbedBuilder {
  const platform = hit.platform === "steam" ? "Steam" : "Epic Games";
  const embed = new EmbedBuilder()
    .setTitle(hit.platform === "steam" ? "Steam無料情報" : "Epic Games 無料配布")
    .setColor(0xf1c40f)
    .setDescription(`**${hit.title}**\n登録したゲームが割引されています!`)
    .addFields(
      { name: "ストア", value: platform, inline: true },
      { name: "通常価格", value: priceText(hit.originalPrice), inline: true },
      { name: "現在価格", value: priceText(hit.currentPrice), inline: true },
      { name: "割引率", value: discountText(hit.discountPercent), inline: true },
      { name: "ストアURL", value: hit.url, inline: false },
    )
    .setTimestamp(new Date());
  if (hit.imageUrl) embed.setImage(hit.imageUrl);
  return embed;
}

export function buildSubscriptionButtons(notificationId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`gameDeals:purchase:${notificationId}`)
      .setLabel("購入しました!")
      .setStyle(ButtonStyle.Success),
  );
}

function usdPrice(value: number | null): string {
  if (value === null) return "不明";
  if (value === 0) return "$0.00";
  return `$${value.toFixed(2)}`;
}

export function buildCheapSharkSteamFreeEmbed(deal: CheapSharkDeal): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle("Steam 期間限定無料")
    .setColor(0x2ecc71)
    .setDescription(`**${deal.title}**\n通常有料ゲームがSteamで期間限定無料または100%OFFの可能性があります。`)
    .addFields(
      { name: "通常価格", value: usdPrice(deal.normalPrice), inline: true },
      { name: "現在価格", value: usdPrice(deal.salePrice), inline: true },
      { name: "割引率", value: `${deal.savings.toFixed(1)}%`, inline: true },
      { name: "Steam購入リンク", value: deal.steamUrl, inline: false },
    )
    .setTimestamp(new Date());
  if (deal.thumb) embed.setImage(deal.thumb);
  return embed;
}

export function buildCheapSharkSteamSaleEmbed(deal: CheapSharkDeal, previousSalePrice: number | null): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle("Steam セール通知")
    .setColor(0xf1c40f)
    .setDescription(`**${deal.title}**\n登録したSteamゲームが割引されています!`)
    .addFields(
      { name: "通常価格", value: usdPrice(deal.normalPrice), inline: true },
      { name: "セール価格", value: usdPrice(deal.salePrice), inline: true },
      { name: "割引率", value: `${deal.savings.toFixed(1)}%`, inline: true },
      { name: "前回価格", value: usdPrice(previousSalePrice), inline: true },
      { name: "Steam購入リンク", value: deal.steamUrl, inline: false },
    )
    .setTimestamp(new Date());
  if (deal.thumb) embed.setImage(deal.thumb);
  return embed;
}

export function buildCheapSharkLinkButtons(deal: CheapSharkDeal): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setLabel("Steamで購入")
      .setStyle(ButtonStyle.Link)
      .setURL(deal.steamUrl),
  );
}
