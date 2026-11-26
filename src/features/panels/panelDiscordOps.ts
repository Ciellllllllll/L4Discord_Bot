import type { Guild } from "discord.js";
import type { CoreDeps } from "../../core/deps.js";

// PanelDiscordOps が使う依存。
type PanelDiscordOpsDeps = Pick<CoreDeps, "client">;


export async function tryDeleteBotPanelMessage(
  ctx: PanelDiscordOpsDeps,
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
