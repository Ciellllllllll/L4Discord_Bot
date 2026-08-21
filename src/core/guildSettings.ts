import type { Kysely } from "kysely";
import { nowIso } from "./db/nowIso.js";
import type { Database } from "./db/types.js";

export type GuildSettingsData = {
  emoji_restricted_user_ids?: string[];
  ai_thinking_enabled?: boolean;
  ai_thinking_enabled_by_user?: Record<string, boolean>;
  appeal_instructions_url?: string;
  auto_reply_excluded_channel_ids?: string[];
  message_log_excluded_channel_ids?: string[];
  senryu_muted_channel_ids?: string[];
  member_leave_channel_id?: string;
  cold_keywords?: string[];
  keyword_replies?: Record<string, string>;
  gif_auto_reply?: {
    trigger_url: string;
    response_url: string;
  };
  panel_channels?: {
    admin_channel_id?: string;
    vc_channel_id?: string;
    modmail_channel_id?: string;
    /** @deprecated 代わりに vc_channel_id / modmail_channel_id を使用 */
    user_channel_id?: string;
  };
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
  const raw = parseSettingsObject(d);
  return raw as GuildSettingsData;
}

function parseSettingsObject(value: unknown): Record<string, unknown> {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      return {};
    }
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

export async function upsertGuildSettingsData(
  db: Kysely<Database>,
  guildId: string,
  patch: Partial<GuildSettingsData>,
): Promise<void> {
  const maxAttempts = 5;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const existing = await db
      .selectFrom("guild_settings")
      .select(["data", "revision"])
      .where("guild_id", "=", guildId)
      .executeTakeFirst();
    const next = { ...parseSettingsObject(existing?.data), ...patch };
    const now = nowIso() as unknown as Date;
    if (!existing) {
      const inserted = await db
        .insertInto("guild_settings")
        .values({
          guild_id: guildId,
          data: JSON.stringify(next) as unknown as Record<string, unknown>,
          updated_at: now,
          revision: 1,
        })
        .onConflict((oc) => oc.column("guild_id").doNothing())
        .executeTakeFirst();
      if (Number(inserted.numInsertedOrUpdatedRows ?? 0) === 1) return;
      continue;
    }
    const updated = await db
      .updateTable("guild_settings")
      .set({
        data: JSON.stringify(next) as unknown as Record<string, unknown>,
        updated_at: now,
        revision: existing.revision + 1,
      })
      .where("guild_id", "=", guildId)
      .where("revision", "=", existing.revision)
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows ?? 0) === 1) return;
  }
  throw new Error(`guild settings concurrent update retry exhausted for guild ${guildId}`);
}
