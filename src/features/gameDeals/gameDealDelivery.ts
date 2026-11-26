import type { Client, SendableChannels } from "discord.js";
import type { CoreDeps } from "../../core/deps.js";
import type { GameDealFreeItem } from "./gameDealTypes.js";

export function chunkGameDealItems(items: GameDealFreeItem[], size = 10): GameDealFreeItem[][] {
  const chunks: GameDealFreeItem[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

export async function fetchGameDealTextChannel(client: Client, channelId: string): Promise<SendableChannels | null> {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased() || channel.isDMBased() || !channel.isSendable()) return null;
  return channel;
}

export function configuredGameDealChannelId(ctx: Pick<CoreDeps, "config">): string | null {
  return ctx.config.GAME_DEAL_CHANNEL_ID?.trim() || null;
}

export function configuredGameDealRoleId(ctx: Pick<CoreDeps, "config">): string | null {
  return ctx.config.GAME_DEAL_NOTIFY_ROLE_ID?.trim() || null;
}

export function gameDealRoleMention(ctx: Pick<CoreDeps, "config">): string | undefined {
  const roleId = configuredGameDealRoleId(ctx);
  return roleId ? `<@&${roleId}>` : undefined;
}

export function gameDealAllowedRoleMentions(ctx: Pick<CoreDeps, "config">): { roles?: string[]; parse: [] } {
  const roleId = configuredGameDealRoleId(ctx);
  return roleId ? { roles: [roleId], parse: [] } : { parse: [] };
}
