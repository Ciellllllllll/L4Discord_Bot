import type { Message } from "discord.js";
import type { BotContext } from "../../bot/context.js";

const ZIG_MESSAGE_LINK = "https://discord.com/channels/1358626083364143215/1397231823968272607/1443064873146646609";
const ZIG_REPLY = `zig←うおｗ\n${ZIG_MESSAGE_LINK}`;

export function isZigTrigger(content: string): boolean {
  const normalized = content.trim().toLowerCase();
  return normalized === "zig" || normalized === ".zig";
}

export async function handleZigAutoReply(message: Message, ctx: BotContext): Promise<boolean> {
  if (!message.guild || message.guild.id !== ctx.config.GUILD_ID) return false;
  if (message.author.bot || message.author.id === ctx.client.user?.id || message.webhookId || message.system) return false;
  if (!isZigTrigger(message.content)) return false;
  if (!message.channel.isTextBased() || message.channel.isDMBased()) return false;

  await message.channel.send({
    content: ZIG_REPLY,
    allowedMentions: { parse: [] },
  });
  return true;
}
