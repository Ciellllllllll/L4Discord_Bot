import {
  type Message,
  type MessageReaction,
  type PartialMessageReaction,
  PermissionFlagsBits,
  type User,
} from "discord.js";
import type { BotContext } from "../../bot/context.js";
import { getGuildSettingsData } from "../../core/guildSettings.js";

const CUSTOM_EMOJI = /<a?:\w+:\d+>/;
const UNICODE_EMOJI = /\p{Extended_Pictographic}/u;

function messageContainsEmoji(content: string): boolean {
  return CUSTOM_EMOJI.test(content) || UNICODE_EMOJI.test(content);
}

async function isRestricted(ctx: BotContext, guildId: string, userId: string): Promise<boolean> {
  const s = await getGuildSettingsData(ctx.db, guildId);
  return Boolean(s.emoji_restricted_user_ids?.includes(userId));
}

function channelExcluded(settings: Awaited<ReturnType<typeof getGuildSettingsData>>, channelId: string): boolean {
  return Boolean(settings.auto_reply_excluded_channel_ids?.includes(channelId));
}

export async function handleEmojiGuardMessage(message: Message, ctx: BotContext): Promise<void> {
  if (!message.guildId || message.author.bot) return;
  if (!(await isRestricted(ctx, message.guildId, message.author.id))) return;
  const s = await getGuildSettingsData(ctx.db, message.guildId);
  if (channelExcluded(s, message.channelId)) return;
  if (!messageContainsEmoji(message.content)) return;
  const me = message.guild?.members.me;
  if (!me?.permissionsIn(message.channelId).has(PermissionFlagsBits.ManageMessages)) return;
  await message.delete().catch(() => undefined);
}

export async function handleEmojiGuardReaction(
  reaction: MessageReaction | PartialMessageReaction,
  user: User,
  ctx: BotContext,
): Promise<void> {
  if (user.bot) return;
  const full = reaction.partial ? await reaction.fetch().catch(() => null) : reaction;
  if (!full?.message.guildId) return;
  const guildId = full.message.guildId;
  if (!(await isRestricted(ctx, guildId, user.id))) return;
  const s = await getGuildSettingsData(ctx.db, guildId);
  if (channelExcluded(s, full.message.channelId)) return;
  const me = full.message.guild?.members.me;
  if (!me?.permissionsIn(full.message.channelId).has(PermissionFlagsBits.ManageMessages)) return;
  await full.users.remove(user.id).catch(() => undefined);
}
