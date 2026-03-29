import type { Kysely } from "kysely";
import type { Database } from "./db/types.js";

const DEFAULT_TTL_HOURS = 48;

export async function createSession(
  db: Kysely<Database>,
  input: {
    id: string;
    guildId: string;
    domain: string;
    action: string;
    payload: Record<string, unknown>;
    executorUserId?: string;
    ttlHours?: number;
  },
): Promise<void> {
  const hours = input.ttlHours ?? DEFAULT_TTL_HOURS;
  const expiresAt = new Date(Date.now() + hours * 3600_000);
  await db
    .insertInto("interaction_sessions")
    .values({
      id: input.id,
      guild_id: input.guildId,
      domain: input.domain,
      action: input.action,
      payload: input.payload,
      executor_user_id: input.executorUserId ?? null,
      expires_at: expiresAt,
      created_at: new Date(),
    })
    .execute();
}

export async function getSession(
  db: Kysely<Database>,
  id: string,
): Promise<{
  payload: Record<string, unknown>;
  guild_id: string;
  domain: string;
  action: string;
  executor_user_id: string | null;
} | null> {
  const row = await db
    .selectFrom("interaction_sessions")
    .selectAll()
    .where("id", "=", id)
    .where("expires_at", ">", new Date())
    .executeTakeFirst();
  if (!row) return null;
  return {
    payload: row.payload as Record<string, unknown>,
    guild_id: row.guild_id,
    domain: row.domain,
    action: row.action,
    executor_user_id: row.executor_user_id,
  };
}

export async function deleteSession(db: Kysely<Database>, id: string): Promise<void> {
  await db.deleteFrom("interaction_sessions").where("id", "=", id).execute();
}
