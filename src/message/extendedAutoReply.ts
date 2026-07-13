import type { Message } from "discord.js";
import type { BotContext } from "../bot/context.js";
import { getGuildSettingsData } from "../core/guildSettings.js";
import { looksLikePrefixCommandLine } from "./commandLike.js";

export async function handleExtendedAutoReplies(message: Message, ctx: BotContext): Promise<boolean> {
  if (!message.guild || message.author.bot) return false;
  if (message.guild.id !== ctx.config.GUILD_ID) return false;
  if (looksLikePrefixCommandLine(message.content)) return false;
  const s = await getGuildSettingsData(ctx.db, message.guild.id);
  if (s.auto_reply_excluded_channel_ids?.includes(message.channelId)) return false;

    // 冷笑・「ばっちい」・Discord メッセージリンク展開は `features/utilities`（DiscordBOTv2 Utilities.js 互換）に移行済み

    // 川柳検出は `features/senryu` に集約


  return false;
}
