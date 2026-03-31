import type { MessageReaction, PartialMessageReaction, User } from "discord.js";
import { sql } from "kysely";
import type { BotContext } from "../../bot/context.js";

export async function trackStampReaction(
  reaction: MessageReaction | PartialMessageReaction,
  user: User,
  ctx: BotContext,
): Promise<void> {
  if (user.bot || !reaction.message.guildId) return;
  const guildId = reaction.message.guildId;
  const full = reaction.partial ? await reaction.fetch().catch(() => null) : reaction;
  if (!full) return;
  const emoji = full.emoji;
  const emojiId = emoji.id ?? `u:${emoji.name ?? "?"}`;
  const emojiName = emoji.name ?? "?";

  await ctx.db
    .insertInto("stamp_usage")
    .values({
      guild_id: guildId,
      user_id: user.id,
      emoji_id: emojiId,
      emoji_name: emojiName.slice(0, 128),
      count: BigInt(1),
      updated_at: new Date(),
    })
    .onConflict((oc) =>
      oc.columns(["guild_id", "user_id", "emoji_id"]).doUpdateSet({
        count: sql`count + 1`,
        emoji_name: emojiName.slice(0, 128),
        updated_at: new Date(),
      }),
    )
    .execute();
}
