import { EmbedBuilder } from "discord.js";
import type { LolWatcherApiAccount, LolWatcherCompletedGame, LolWatcherLiveGame } from "./lolWatcher.types.js";

function formatDuration(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safe / 60);
  const rest = safe % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

function formatStartTime(iso: string): string {
  const unix = Math.floor(Date.parse(iso) / 1000);
  return Number.isFinite(unix) ? `<t:${unix}:t>` : iso;
}

function applyOptionalMedia(embed: EmbedBuilder, detailUrl: string | null, championImageUrl: string | null): EmbedBuilder {
  if (detailUrl) embed.setURL(detailUrl);
  if (championImageUrl) embed.setThumbnail(championImageUrl);
  return embed;
}

export function buildLolWatcherStartEmbed(account: LolWatcherApiAccount, game: LolWatcherLiveGame): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(`🎮 ${account.displayName} の試合が開始`)
    .setColor(0x3498db)
    .addFields(
      { name: "ゲームモード", value: game.queueName, inline: true },
      { name: "チャンピオン", value: game.championName, inline: true },
      { name: "開始時刻", value: formatStartTime(game.startedAt), inline: true },
    )
    .setTimestamp(new Date());
  return applyOptionalMedia(embed, null, game.championImageUrl);
}

export function buildLolWatcherCompletedEmbed(
  account: LolWatcherApiAccount,
  game: LolWatcherCompletedGame,
): EmbedBuilder {
  const isWin = game.result === "win";
  const embed = new EmbedBuilder()
    .setTitle(`🏆 ${account.displayName} の試合が終了`)
    .setColor(isWin ? 0x2ecc71 : 0xe74c3c)
    .addFields(
      { name: "ゲームモード", value: game.queueName, inline: true },
      { name: "チャンピオン", value: game.championName, inline: true },
      { name: "\u200b", value: "\u200b", inline: true },
      { name: "KDA", value: `${game.kills}/${game.deaths}/${game.assists}`, inline: true },
      { name: "AIスコア", value: game.aiScore === null ? "N/A" : String(game.aiScore), inline: true },
    )
    .setFooter({
      text: `結果: ${isWin ? "勝利" : "敗北"} | 試合時間: ${formatDuration(game.durationSeconds)} | キル関与: ${game.killParticipationPercent}%`,
    })
    .setTimestamp(new Date(game.endedAt));
  return applyOptionalMedia(embed, game.detailUrl, game.championImageUrl);
}
