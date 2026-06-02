import type { Message } from "discord.js";
import type { BotContext } from "../../bot/context.js";
import { isAdmin } from "../../core/permission.js";
import { buildSteamFreeEmbed, buildSteamStatusEmbed, buildSteamSummaryText } from "./steamFreeEmbeds.js";
import { SteamFreeRepository } from "./steamFreeRepository.js";
import { scanSteamFreeNow } from "./steamFreeWatcher.js";

const SAFE_REPLY = { parse: [] } as const;

export function isSteamFreePrefixCommand(command: string): boolean {
  return ["steam_free_on", "steam_free_off", "steam_free_now", "steam_free_status"].includes(command);
}

export async function handleSteamFreePrefixMessage(
  message: Message,
  ctx: BotContext,
  command: string,
): Promise<boolean> {
  const repo = new SteamFreeRepository(ctx.sqlite);
  if (!message.guildId || !message.channelId) {
    await message.reply({ content: "ギルド内のチャンネルでのみ使用できます。", allowedMentions: SAFE_REPLY });
    return true;
  }

  if (command === "steam_free_on") {
    if (!message.member || !isAdmin(message.member, ctx.config)) {
      await message.reply({ content: "このコマンドは管理者のみ使用できます。", allowedMentions: SAFE_REPLY });
      return true;
    }
    const result = repo.enableNotifyChannel(message.guildId, message.channelId);
    if (result.alreadyEnabledInChannel) {
      await message.reply({ content: "既にこのチャンネルでSteam無料通知は有効です", allowedMentions: SAFE_REPLY });
      return true;
    }
    await message.reply({ content: "このチャンネルでSteam無料通知を有効化しました。現在の候補を確認します。", allowedMentions: SAFE_REPLY });
    const candidates = await scanSteamFreeNow(ctx);
    const shown = candidates.slice(0, 10);
    for (const candidate of shown) repo.upsertSeen(candidate, true);
    const channel = message.channel;
    if (shown.length === 0) {
      if (channel.isTextBased() && !channel.isDMBased() && channel.isSendable()) {
        await channel.send({ content: "現在検出できるSteam無料候補はありません", allowedMentions: SAFE_REPLY });
      }
      return true;
    }
    if (channel.isTextBased() && !channel.isDMBased() && channel.isSendable()) {
      await channel.send({
        content: buildSteamSummaryText(candidates.length, shown.length),
        embeds: shown.map(buildSteamFreeEmbed),
        allowedMentions: SAFE_REPLY,
      });
    }
    return true;
  }

  if (command === "steam_free_off") {
    if (!message.member || !isAdmin(message.member, ctx.config)) {
      await message.reply({ content: "このコマンドは管理者のみ使用できます。", allowedMentions: SAFE_REPLY });
      return true;
    }
    repo.disableNotifyChannel(message.guildId);
    await message.reply({ content: "このサーバーのSteam無料通知を無効化しました。", allowedMentions: SAFE_REPLY });
    return true;
  }

  if (command === "steam_free_now") {
    await message.reply({ content: "Steam無料候補を確認しています。", allowedMentions: SAFE_REPLY });
    const candidates = await scanSteamFreeNow(ctx);
    const shown = candidates.slice(0, 10);
    const channel = message.channel;
    if (shown.length === 0) {
      if (channel.isTextBased() && !channel.isDMBased() && channel.isSendable()) {
        await channel.send({ content: "現在検出できるSteam無料候補はありません", allowedMentions: SAFE_REPLY });
      }
      return true;
    }
    if (channel.isTextBased() && !channel.isDMBased() && channel.isSendable()) {
      await channel.send({
        content: buildSteamSummaryText(candidates.length, shown.length),
        embeds: shown.map(buildSteamFreeEmbed),
        allowedMentions: SAFE_REPLY,
      });
    }
    return true;
  }

  if (command === "steam_free_status") {
    const channel = repo.getNotifyChannel(message.guildId);
    const embed = buildSteamStatusEmbed({
      enabled: channel?.enabled === true,
      channelId: channel?.enabled ? channel.channelId : null,
      status: repo.getStatus(),
    });
    await message.reply({ embeds: [embed], allowedMentions: SAFE_REPLY });
    return true;
  }

  return false;
}
