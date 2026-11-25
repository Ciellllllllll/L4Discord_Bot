import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { nowIso } from "../../core/db/nowIso.js";
import type { TicketDatabase } from "../../core/db/types.js";

export type ModmailThreadRow = {
  id: string;
  guild_id: string;
  user_id: string;
  channel_id: string | null;
  thread_id: string | null;
  status: string;
  data: unknown;
  created_at: Date;
};

const INTAKE_PENDING = "PendingFirstMessage";
const INTAKE_CONSUMED = "Consumed";
const INTAKE_CANCELLED = "Cancelled";
export const MM_OPEN = "open";
export const MM_CLOSED = "closed";

function trimMax(text: string, n: number): string {
  const s = text.trim();
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

export function ticketDisplayCode(id: unknown): string {
  return String(id).replace(/-/g, "").slice(0, 8).toUpperCase();
}

export function parseModmailRowData(data: unknown): Record<string, unknown> {
  if (data && typeof data === "object" && !Array.isArray(data)) return data as Record<string, unknown>;
  if (typeof data === "string") {
    try {
      const p = JSON.parse(data) as unknown;
      if (p && typeof p === "object" && !Array.isArray(p)) return p as Record<string, unknown>;
    } catch {}
  }
  return {};
}

export async function upsertModmailIntakeRow(
  ticketDb: Kysely<TicketDatabase>,
  guildId: string,
  userId: string,
): Promise<void> {
  const ts = nowIso() as unknown as Date;
  await ticketDb
    .insertInto("modmail_intakes")
    .values({
      guild_id: guildId,
      user_id: userId,
      status: INTAKE_PENDING,
      requested_at: ts,
      dm_sent_at: ts,
      updated_at: ts,
    })
    .onConflict((oc) =>
      oc.columns(["guild_id", "user_id"]).doUpdateSet({
        status: INTAKE_PENDING,
        requested_at: ts,
        dm_sent_at: ts,
        updated_at: ts,
      }),
    )
    .execute();
}

export async function consumeModmailIntakeRow(
  ticketDb: Kysely<TicketDatabase>,
  guildId: string,
  userId: string,
): Promise<void> {
  const ts = nowIso() as unknown as Date;
  await ticketDb
    .updateTable("modmail_intakes")
    .set({ status: INTAKE_CONSUMED, updated_at: ts })
    .where("guild_id", "=", guildId)
    .where("user_id", "=", userId)
    .execute();
}

export async function cancelModmailIntakeRow(
  ticketDb: Kysely<TicketDatabase>,
  guildId: string,
  userId: string,
): Promise<boolean> {
  const ts = nowIso() as unknown as Date;
  const result = await ticketDb
    .updateTable("modmail_intakes")
    .set({ status: INTAKE_CANCELLED, updated_at: ts })
    .where("guild_id", "=", guildId)
    .where("user_id", "=", userId)
    .where("status", "=", INTAKE_PENDING)
    .executeTakeFirst();
  return Number(result.numUpdatedRows ?? 0) > 0;
}

export async function hasActiveIntakeByGuildUser(
  ticketDb: Kysely<TicketDatabase>,
  guildId: string,
  userId: string,
): Promise<boolean> {
  const row = await ticketDb
    .selectFrom("modmail_intakes")
    .select(["guild_id"])
    .where("guild_id", "=", guildId)
    .where("user_id", "=", userId)
    .where("status", "=", INTAKE_PENDING)
    .executeTakeFirst();
  return Boolean(row);
}

export async function findActiveIntakeByUser(
  ticketDb: Kysely<TicketDatabase>,
  userId: string,
): Promise<{ guild_id: string } | null> {
  const row = await ticketDb
    .selectFrom("modmail_intakes")
    .select(["guild_id"])
    .where("user_id", "=", userId)
    .where("status", "=", INTAKE_PENDING)
    .orderBy("updated_at", "desc")
    .executeTakeFirst();
  return row ?? null;
}

export async function findOpenModmailByThreadId(
  ticketDb: Kysely<TicketDatabase>,
  threadId: string,
): Promise<ModmailThreadRow | undefined> {
  const row = await ticketDb
    .selectFrom("modmail_threads")
    .selectAll()
    .where("thread_id", "=", threadId)
    .where("status", "=", MM_OPEN)
    .orderBy("created_at", "desc")
    .executeTakeFirst();
  return row as ModmailThreadRow | undefined;
}

export async function findOpenModmailByGuildUser(
  ticketDb: Kysely<TicketDatabase>,
  guildId: string,
  userId: string,
): Promise<ModmailThreadRow | undefined> {
  const row = await ticketDb
    .selectFrom("modmail_threads")
    .selectAll()
    .where("guild_id", "=", guildId)
    .where("user_id", "=", userId)
    .where("status", "=", MM_OPEN)
    .orderBy("created_at", "desc")
    .executeTakeFirst();
  return row as ModmailThreadRow | undefined;
}

export async function findAnyOpenModmailByUser(
  ticketDb: Kysely<TicketDatabase>,
  userId: string,
): Promise<ModmailThreadRow | undefined> {
  const row = await ticketDb
    .selectFrom("modmail_threads")
    .selectAll()
    .where("user_id", "=", userId)
    .where("status", "=", MM_OPEN)
    .orderBy("created_at", "desc")
    .executeTakeFirst();
  return row as ModmailThreadRow | undefined;
}

export async function insertModmailSkeleton(
  ticketDb: Kysely<TicketDatabase>,
  input: {
    guildId: string;
    userId: string;
    body: string;
    subject: string | null;
    firstDmMessageId: string | null;
    source: string;
  },
): Promise<string> {
  const id = randomUUID();
  const ts = nowIso() as unknown as Date;
  const data = {
    body: trimMax(input.body, 1000),
    subject: input.subject ? trimMax(input.subject, 120) : null,
    source: input.source,
    first_user_dm_message_id: input.firstDmMessageId,
  };
  await ticketDb
    .insertInto("modmail_threads")
    .values({
      id,
      guild_id: input.guildId,
      user_id: input.userId,
      channel_id: null,
      thread_id: null,
      status: MM_OPEN,
      data: JSON.stringify(data) as unknown as Record<string, unknown>,
      created_at: ts,
    })
    .execute();
  return id;
}

export async function deleteModmailRowById(ticketDb: Kysely<TicketDatabase>, id: string): Promise<void> {
  await ticketDb.deleteFrom("modmail_threads").where("id", "=", id).execute();
}

export async function updateModmailThreadMetaRow(
  ticketDb: Kysely<TicketDatabase>,
  id: string,
  parentChannelId: string,
  threadId: string,
  dataPatch: Record<string, unknown>,
): Promise<void> {
  const row = await ticketDb.selectFrom("modmail_threads").selectAll().where("id", "=", id).executeTakeFirst();
  if (!row) return;
  const merged = { ...parseModmailRowData(row.data), ...dataPatch };
  await ticketDb
    .updateTable("modmail_threads")
    .set({
      channel_id: parentChannelId,
      thread_id: threadId,
      data: JSON.stringify(merged) as unknown as Record<string, unknown>,
    })
    .where("id", "=", id)
    .execute();
}

export async function findModmailTicketRowById(
  ticketDb: Kysely<TicketDatabase>,
  id: string,
): Promise<ModmailThreadRow | undefined> {
  const row = await ticketDb.selectFrom("modmail_threads").selectAll().where("id", "=", id).executeTakeFirst();
  return row as ModmailThreadRow | undefined;
}

export async function closeModmailTicketRow(
  ticketDb: Kysely<TicketDatabase>,
  ticketId: string,
  closerId: string,
  reason: string,
): Promise<{ ok: boolean; closedAt?: string }> {
  const row = await findModmailTicketRowById(ticketDb, ticketId);
  if (!row || row.status !== MM_OPEN) return { ok: false };
  const merged = {
    ...parseModmailRowData(row.data),
    closed_at: nowIso(),
    close_reason: reason,
    closer_staff_id: closerId,
  };
  const result = await ticketDb
    .updateTable("modmail_threads")
    .set({
      status: MM_CLOSED,
      data: JSON.stringify(merged) as unknown as Record<string, unknown>,
    })
    .where("id", "=", ticketId)
    .where("status", "=", MM_OPEN)
    .executeTakeFirst();
  if (Number(result.numUpdatedRows ?? 0) === 0) return { ok: false };
  return { ok: true, closedAt: merged.closed_at as string };
}
