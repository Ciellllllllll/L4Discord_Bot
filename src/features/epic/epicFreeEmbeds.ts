import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";
import type { EpicFreeCandidate } from "./epicFreeTypes.js";

function priceText(value: number | null, currency: string | null): string {
  if (value === null) return "不明";
  if (value === 0) return "無料 / 0円";
  return `${value.toLocaleString("ja-JP")} ${currency ?? "JPY"}`;
}

function formatJst(value: string | null): string {
  if (!value) return "不明";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "不明";
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

export function buildEpicFreeEmbed(candidate: EpicFreeCandidate): EmbedBuilder {
  const note =
    candidate.detectedType === "upcoming_free_game"
      ? "Epic Games Storeで次回無料配布予定です。"
      : "Epic Games Storeで期間限定無料配布中です。期限内にライブラリへ追加すると入手できます。";
  const embed = new EmbedBuilder()
    .setTitle("Epic Games 無料配布")
    .setColor(candidate.detectedType === "current_free_game" ? 0x2ecc71 : 0x3498db)
    .setDescription(`**${candidate.title}**\n${note}`)
    .addFields(
      { name: "配布期間", value: `${formatJst(candidate.startDate)} ～ ${formatJst(candidate.endDate)}`, inline: false },
      { name: "通常価格", value: priceText(candidate.originalPrice, candidate.currencyCode), inline: true },
      { name: "現在価格", value: priceText(candidate.discountPrice, candidate.currencyCode), inline: true },
      { name: "ストアURL", value: candidate.url, inline: false },
    )
    .setTimestamp(new Date());
  if (candidate.imageUrl) embed.setImage(candidate.imageUrl);
  return embed;
}

export function buildEpicLinkButtons(candidate: EpicFreeCandidate): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setLabel("Epicで購入")
      .setStyle(ButtonStyle.Link)
      .setURL(candidate.url),
  );
}
