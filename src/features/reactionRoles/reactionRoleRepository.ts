import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { Database } from "../../core/db/types.js";
import { nowIso } from "../../core/db/nowIso.js";
import { rowToEntry, type ReactionRoleEntry } from "./reactionRoleModel.js";

// リアクションロールの DB 読み書き。

export async function loadEntriesForGuild(db: Kysely<Database>, guildId: string): Promise<ReactionRoleEntry[]> {
  const rows = await db
    .selectFrom("reaction_role_entries")
    .select(["entry_id", "channel_id", "message_id", "title", "description", "roles_json"])
    .where("guild_id", "=", guildId)
    .execute();
  return rows.map(rowToEntry);
}

export async function getEntryByEntryId(
  db: Kysely<Database>,
  guildId: string,
  entryId: string,
): Promise<ReactionRoleEntry | null> {
  const row = await db
    .selectFrom("reaction_role_entries")
    .select(["entry_id", "channel_id", "message_id", "title", "description", "roles_json"])
    .where("guild_id", "=", guildId)
    .where("entry_id", "=", entryId)
    .executeTakeFirst();
  return row ? rowToEntry(row) : null;
}

export async function insertEntry(
  db: Kysely<Database>,
  guildId: string,
  entry: ReactionRoleEntry,
): Promise<void> {
  await db
    .insertInto("reaction_role_entries")
    .values({
      id: randomUUID(),
      guild_id: guildId,
      entry_id: entry.entryId,
      channel_id: entry.channelId,
      message_id: entry.messageId,
      title: entry.title,
      description: entry.description,
      roles_json: JSON.stringify(entry.roles),
      created_at: nowIso() as unknown as Date,
    })
    .execute();
}

export async function updateEntryRow(
  db: Kysely<Database>,
  guildId: string,
  entry: ReactionRoleEntry,
): Promise<void> {
  await db
    .updateTable("reaction_role_entries")
    .set({
      channel_id: entry.channelId,
      message_id: entry.messageId,
      title: entry.title,
      description: entry.description,
      roles_json: JSON.stringify(entry.roles),
    })
    .where("guild_id", "=", guildId)
    .where("entry_id", "=", entry.entryId)
    .execute();
}

export async function deleteEntryRow(db: Kysely<Database>, guildId: string, entryId: string): Promise<void> {
  await db.deleteFrom("reaction_role_entries").where("guild_id", "=", guildId).where("entry_id", "=", entryId).execute();
}

export async function setEntryMessageId(
  db: Kysely<Database>,
  guildId: string,
  entryId: string,
  messageId: string,
  channelId: string,
): Promise<void> {
  await db
    .updateTable("reaction_role_entries")
    .set({ message_id: messageId, channel_id: channelId })
    .where("guild_id", "=", guildId)
    .where("entry_id", "=", entryId)
    .execute();
}
