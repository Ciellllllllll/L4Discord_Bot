import type { MessageReaction, PartialMessageReaction, User } from "discord.js";
import type { BotContext } from "../../bot/context.js";

type EmojiRoleConfig = {
  emojiToRoleId?: Record<string, string>;
};

export async function handleReactionRoleAdd(
  reaction: MessageReaction | PartialMessageReaction,
  user: User,
  ctx: BotContext,
): Promise<void> {
  if (user.bot || !reaction.message.guildId) return;
  const full = reaction.partial ? await reaction.fetch().catch(() => null) : reaction;
  if (!full) return;
  const guildId = full.message.guildId;
  if (guildId !== ctx.config.GUILD_ID) return;
  const mid = full.message.id;
  const row = await ctx.db
    .selectFrom("reaction_role_messages")
    .selectAll()
    .where("guild_id", "=", guildId)
    .where("message_id", "=", mid)
    .executeTakeFirst();
  if (!row) return;
  const raw = row.config;
  const cfg = (typeof raw === "string" ? JSON.parse(raw) : raw) as EmojiRoleConfig;
  const map = cfg.emojiToRoleId ?? {};
  const emoji = full.emoji;
  const keyById = emoji.id ? `${emoji.id}` : "";
  const keyByName = emoji.name ? `name:${emoji.name}` : "";
  const roleId = map[keyById] ?? map[keyByName] ?? map[emoji.name ?? ""];
  if (!roleId) return;
  const guild = full.message.guild;
  if (!guild) return;
  const member = await guild.members.fetch(user.id).catch(() => null);
  if (!member) return;
  await member.roles.add(roleId).catch(() => undefined);
}
