import type { Kysely } from "kysely";
import { nowIso } from "./db/nowIso.js";
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
  const expiresIso = expiresAt.toISOString();
  const createdIso = nowIso();
  await db
    .insertInto("interaction_sessions")
    .values({
      id: input.id,
      guild_id: input.guildId,
      domain: input.domain,
      action: input.action,
      payload: JSON.stringify(input.payload) as unknown as Record<string, unknown>,
      executor_user_id: input.executorUserId ?? null,
      expires_at: expiresIso as unknown as Date,
      created_at: createdIso as unknown as Date,
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
  const currentIso = nowIso();
  const row = await db
    .selectFrom("interaction_sessions")
    .selectAll()
    .where("id", "=", id)
    .where("expires_at", ">", currentIso as unknown as Date)
    .executeTakeFirst();
  if (!row) return null;
  const p = row.payload;
  const payload = typeof p === "string" ? (JSON.parse(p) as Record<string, unknown>) : (p as Record<string, unknown>);
  return {
    payload,
    guild_id: row.guild_id,
    domain: row.domain,
    action: row.action,
    executor_user_id: row.executor_user_id,
  };
}

export async function deleteSession(db: Kysely<Database>, id: string): Promise<void> {
  await db.deleteFrom("interaction_sessions").where("id", "=", id).execute();
}

export async function mergeSessionPayload(
  db: Kysely<Database>,
  id: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const cur = await getSession(db, id);
  if (!cur) return;
  const next = { ...cur.payload, ...patch };
  await db
    .updateTable("interaction_sessions")
    .set({
      payload: JSON.stringify(next) as unknown as Record<string, unknown>,
    })
    .where("id", "=", id)
    .execute();
}
