import { ComponentCardBuilder } from "../panels/componentCard.js";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import type { EpicFreeCandidate } from "./epicFreeTypes.js";

export const EPIC_GAMES_STORE_LOGO_URL =
  "https://upload.wikimedia.org/wikipedia/commons/thumb/5/58/Epic_Games_Store_logo_2023_vertical_white.svg/330px-Epic_Games_Store_logo_2023_vertical_white.svg.png";

function priceText(value: number | null, currency: string | null): string {
  if (value === null) return "不明";
  if (value === 0) return "無料 / 0円";
  return `${value.toLocaleString("ja-JP")} ${currency ?? "JPY"}`;
}

function formatDiscordRelativeTime(value: string | null): string {
  if (!value) return "不明";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "不明";
  return `<t:${Math.floor(d.getTime() / 1000)}:R>`;
}

function buildEpicLauncherUrl(storeUrl: string): string {
  const url = new URL(storeUrl);
  url.hostname = "launcher.store.epicgames.com";
  return url.toString();
}

export function buildEpicFreeEmbed(candidate: EpicFreeCandidate): ComponentCardBuilder {
  const note =
    candidate.detectedType === "upcoming_free_game"
      ? "Epic Games Storeで次回無料配布予定です。"
      : "Epic Games Storeで期間限定無料配布中です。期限内にライブラリへ追加すると入手できます。";
  const embed = new ComponentCardBuilder()
    .setTitle("Epic Games 無料配布")
    .setThumbnail(EPIC_GAMES_STORE_LOGO_URL)
    .setColor(candidate.detectedType === "current_free_game" ? 0x2ecc71 : 0x3498db)
    .setDescription(`**${candidate.title}**\n${note}`)
    .addFields(
      { name: "配布終了", value: formatDiscordRelativeTime(candidate.endDate), inline: false },
      { name: "通常価格", value: priceText(candidate.originalPrice, candidate.currencyCode), inline: true },
      { name: "現在価格", value: priceText(candidate.discountPrice, candidate.currencyCode), inline: true },
    );
  if (candidate.imageUrl) embed.setImage(candidate.imageUrl);
  return embed.addActionRows(buildEpicLinkButtons(candidate));
}

export function buildEpicLinkButtons(candidate: EpicFreeCandidate): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setLabel("ブラウザで閲覧")
      .setStyle(ButtonStyle.Link)
      .setURL(candidate.url),
    new ButtonBuilder()
      .setLabel("Epic Launcherで開く")
      .setStyle(ButtonStyle.Link)
      .setURL(buildEpicLauncherUrl(candidate.url)),
  );
}
