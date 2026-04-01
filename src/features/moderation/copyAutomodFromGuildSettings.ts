import type { BotContext } from "../../bot/context.js";
import { getGuildSettingsData } from "../../core/guildSettings.js";
import { sqliteTimestamp } from "../../core/db/sqliteTimestamp.js";

/**
 * 旧 guild_settings.data.automod_settings から専用 DB へ 1 回だけ移行（行が無い場合のみ）。
 */
export async function copyAutomodFromGuildSettingsIfMissing(ctx: BotContext, guildId: string): Promise<void> {
  const existing = await ctx.automodDb
    .selectFrom("automod_guild_settings")
    .select("guild_id")
    .where("guild_id", "=", guildId)
    .executeTakeFirst();
  if (existing) return;

  const gs = await getGuildSettingsData(ctx.db, guildId);
  const raw = (gs as { automod_settings?: unknown }).automod_settings;
  if (raw === undefined || raw === null) return;
  if (typeof raw !== "object" || Array.isArray(raw)) return;

  await ctx.automodDb
    .insertInto("automod_guild_settings")
    .values({
      guild_id: guildId,
      data: JSON.stringify(raw) as unknown as Record<string, unknown>,
      updated_at: sqliteTimestamp() as unknown as Date,
    })
    .execute();
}
