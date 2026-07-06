import type { BotContext } from "../../bot/context.js";
import { sqliteTimestamp } from "../../core/db/sqliteTimestamp.js";

export async function getAiR18Enabled(ctx: BotContext, guildId: string, userId: string): Promise<boolean> {
  const row = await ctx.db
    .selectFrom("ai_r18_user_settings")
    .select("enabled")
    .where("guild_id", "=", guildId)
    .where("user_id", "=", userId)
    .executeTakeFirst();
  return row?.enabled === 1;
}

export async function setAiR18Enabled(
  ctx: BotContext,
  guildId: string,
  userId: string,
  enabled: boolean,
): Promise<void> {
  const now = sqliteTimestamp();
  await ctx.db
    .insertInto("ai_r18_user_settings")
    .values({
      guild_id: guildId,
      user_id: userId,
      enabled: enabled ? 1 : 0,
      updated_at: now,
    })
    .onConflict((oc) =>
      oc.columns(["guild_id", "user_id"]).doUpdateSet({
        enabled: enabled ? 1 : 0,
        updated_at: now,
      }),
    )
    .execute();
}
