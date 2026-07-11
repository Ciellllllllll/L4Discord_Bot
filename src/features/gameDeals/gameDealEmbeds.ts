import { ComponentCardBuilder } from "../panels/componentCard.js";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import type { GameDealSubscriptionHit, SteamFreeEvent } from "./gameDealTypes.js";

export const EPIC_GAMES_STORE_LOGO_URL =
  "https://upload.wikimedia.org/wikipedia/commons/thumb/5/58/Epic_Games_Store_logo_2023_vertical_white.svg/330px-Epic_Games_Store_logo_2023_vertical_white.svg.png";
export const STEAM_LOGO_URL =
  "https://upload.wikimedia.org/wikipedia/commons/thumb/8/83/Steam_icon_logo.svg/330px-Steam_icon_logo.svg.png";

function priceText(value: number | null): string {
  if (value === null) return "不明";
  if (value === 0) return "無料 / 0円";
  return `${value.toLocaleString("ja-JP")}円`;
}

function discountText(value: number | null): string {
  return value === null ? "不明" : `${value}%`;
}

export function buildSubscriptionDealEmbed(hit: GameDealSubscriptionHit): ComponentCardBuilder {
  const platform = hit.platform === "steam" ? "Steam" : "Epic Games";
  const embed = new ComponentCardBuilder()
    .setTitle(hit.platform === "steam" ? "Steam無料情報" : "Epic Games 無料配布")
    .setThumbnail(hit.platform === "steam" ? STEAM_LOGO_URL : EPIC_GAMES_STORE_LOGO_URL)
    .setDescription(`**${hit.title}**\n登録したゲームが割引されています!`)
    .addFields(
      { name: "ストア", value: platform, inline: true },
      { name: "通常価格", value: priceText(hit.originalPrice), inline: true },
      { name: "現在価格", value: priceText(hit.currentPrice), inline: true },
      { name: "割引率", value: discountText(hit.discountPercent), inline: true },
      { name: "ストアURL", value: hit.url, inline: false },
    );
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

function centsPriceText(value: number | null): string {
  if (value === null) return "不明";
  if (value === 0) return "無料 / 0円";
  return `${Math.round(value / 100).toLocaleString("ja-JP")}円`;
}

function steamEvidenceText(evidenceJson: string): string {
  try {
    const parsed = JSON.parse(evidenceJson) as Array<{ source?: unknown }>;
    const labels = parsed
      .map((item): string | null => {
        switch (item.source) {
          case "steam_appdetails":
            return "Steam appdetails";
          case "steam_search":
            return "Steam search";
          case "cheapshark":
            return "CheapShark補助";
          case "db_paid_history":
            return "DB paid history";
          default:
            return null;
        }
      })
      .filter((value): value is string => value !== null);
    return [...new Set(labels)].join(" / ") || "不明";
  } catch {
    return "不明";
  }
}

function discordRelativeUnix(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return `<t:${Math.floor(value)}:R>`;
}

export function buildSteamFreeEventEmbed(event: SteamFreeEvent): ComponentCardBuilder {
  const discount = event.discountPercent !== null && event.discountPercent >= 100 ? "100%" : event.discountPercent !== null ? `${event.discountPercent}%` : "Free to Keep";
  const freeUntil = discordRelativeUnix(event.freeUntilUnix);
  const embed = new ComponentCardBuilder()
    .setTitle("Steam 無料配布")
    .setThumbnail(STEAM_LOGO_URL)
    .setDescription(`**${event.title}**\n通常有料ゲームがSteamで無料配布または100%OFFになっています。`)
    .addFields(
      { name: "通常価格", value: centsPriceText(event.normalPriceCents), inline: true },
      { name: "現在価格", value: centsPriceText(event.currentPriceCents), inline: true },
      { name: "割引率", value: discount, inline: true },
      ...(freeUntil ? [{ name: "配布終了", value: freeUntil, inline: false }] : []),
      { name: "検証根拠", value: steamEvidenceText(event.evidenceJson), inline: false },
    );
  if (event.imageUrl) embed.setImage(event.imageUrl);
  return embed.addActionRows(buildSteamLinkButtons(event));
}

export function buildSteamLinkButtons(event: Pick<SteamFreeEvent, "appid" | "steamUrl">): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setLabel("ブラウザで閲覧")
      .setStyle(ButtonStyle.Link)
      .setURL(event.steamUrl),
    new ButtonBuilder()
      .setLabel("Steam Clientで開く")
      .setStyle(ButtonStyle.Link)
      .setURL(`https://s.team/a/${encodeURIComponent(event.appid)}`),
  );
}
