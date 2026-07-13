import type { Guild } from "discord.js";
import type { BotContext } from "../../bot/context.js";

export async function tryDeleteBotPanelMessage(
  ctx: BotContext,
  guild: Guild,
  channelId: string,
  messageId: string,
): Promise<void> {
  if (!messageId || !channelId) return;
  const ch = await guild.channels.fetch(channelId).catch(() => null);
  if (!ch?.isTextBased()) return;
  const msg = await ch.messages.fetch(messageId).catch(() => null);
  if (!msg || msg.author?.id !== ctx.client.user?.id) return;
  await msg.delete().catch(() => undefined);
}
