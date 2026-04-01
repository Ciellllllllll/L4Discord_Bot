import type { Message } from "discord.js";
import type { BotContext } from "../bot/context.js";
import { getGuildSettingsData } from "../core/guildSettings.js";
import { looksLikePrefixCommandLine } from "./commandLike.js";

function roughSenryuLines(text: string): boolean {
  const lines = text
    .trim()
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length !== 3) return false;
  const counts = lines.map((l) => [...l.replace(/\s/g, "")].length);
  return counts[0] === 5 && counts[1] === 7 && counts[2] === 5;
}

export async function handleExtendedAutoReplies(message: Message, ctx: BotContext): Promise<boolean> {
  if (!message.guild || message.author.bot) return false;
  if (message.guild.id !== ctx.config.GUILD_ID) return false;
  if (looksLikePrefixCommandLine(message.content)) return false;
  const s = await getGuildSettingsData(ctx.db, message.guild.id);
  if (s.auto_reply_excluded_channel_ids?.includes(message.channelId)) return false;

  /** 冷笑・「ばっちい」・Discord メッセージリンク展開は `features/utilities`（DiscordBOTv2 Utilities.js 互換）に移行済み */

  if (roughSenryuLines(message.content)) {
    await message.reply("川柳が検出されました").catch(() => undefined);
    return true;
  }

  return false;
}
