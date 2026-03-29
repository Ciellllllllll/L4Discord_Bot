import type { Message } from "discord.js";
import type { BotContext } from "../bot/context.js";
import { getGuildSettingsData } from "../core/guildSettings.js";

const TWITTER_HOST = /https?:\/\/(www\.)?(twitter\.com|x\.com)\//i;

const userCooldownUntil = new Map<string, number>();
const channelCooldownUntil = new Map<string, number>();

function allowCooldown(userId: string, channelId: string): boolean {
  const now = Date.now();
  if ((channelCooldownUntil.get(channelId) ?? 0) > now) return false;
  const key = `${userId}:auto`;
  if ((userCooldownUntil.get(key) ?? 0) > now) return false;
  channelCooldownUntil.set(channelId, now + 1000);
  userCooldownUntil.set(key, now + 5000);
  return true;
}

function toVxTwitter(url: string): string {
  return url.replace(TWITTER_HOST, "https://vxtwitter.com/");
}

export async function handleAutoReply(message: Message, ctx: BotContext): Promise<boolean> {
  if (!message.guild || message.author.bot) return false;
  if (message.guild.id !== ctx.config.GUILD_ID) return false;
  const settings = await getGuildSettingsData(ctx.db, message.guild.id);
  if (settings.auto_reply_excluded_channel_ids?.includes(message.channelId)) return false;

  if (TWITTER_HOST.test(message.content)) {
    if (!allowCooldown(message.author.id, message.channelId)) return true;
    const match = message.content.match(/https?:\/\/[^\s]+/);
    if (match) {
      const vx = toVxTwitter(match[0]);
      await message.reply({ content: vx, allowedMentions: { parse: [] } }).catch(() => undefined);
    }
    return true;
  }

  return false;
}
