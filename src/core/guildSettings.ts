import type { Kysely } from "kysely";
import type { Database } from "./db/types.js";

export type GuildSettingsData = {
  emoji_restricted_user_ids?: string[];
  appeal_instructions_url?: string;
  auto_reply_excluded_channel_ids?: string[];
  member_leave_channel_id?: string;
  cold_keywords?: string[];
  keyword_replies?: Record<string, string>;
  [key: string]: unknown;
};

export async function getGuildSettingsData(
  db: Kysely<Database>,
  guildId: string,
): Promise<GuildSettingsData> {
  const row = await db
    .selectFrom("guild_settings")
    .selectAll()
    .where("guild_id", "=", guildId)
    .executeTakeFirst();
  if (!row) return {};
  const d = row.data;
  const raw = typeof d === "string" ? (JSON.parse(d) as Record<string, unknown>) : (d as Record<string, unknown>);
  return raw as GuildSettingsData;
}

export async function upsertGuildSettingsData(
  db: Kysely<Database>,
  guildId: string,
  patch: Partial<GuildSettingsData>,
): Promise<void> {
  const existing = await getGuildSettingsData(db, guildId);
  const next = { ...existing, ...patch };
  await db
    .insertInto("guild_settings")
    .values({
      guild_id: guildId,
      data: JSON.stringify(next) as unknown as Record<string, unknown>,
      updated_at: new Date(),
    })
    .onConflict((oc) =>
      oc.column("guild_id").doUpdateSet({
        data: JSON.stringify(next) as unknown as Record<string, unknown>,
        updated_at: new Date(),
      }),
    )
    .execute();
}
