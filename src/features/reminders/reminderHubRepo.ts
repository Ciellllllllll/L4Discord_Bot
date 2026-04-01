import { randomUUID } from "node:crypto";
import type { BotContext } from "../../bot/context.js";
import { sqliteTimestamp } from "../../core/db/sqliteTimestamp.js";
import type { RemindersRow } from "../../core/db/types.js";
import { getReminderDb } from "./reminderDb.js";
import { normalizeEventType, type ReminderEvType, type ReminderStoredData } from "./reminderHubTypes.js";

function rdb(ctx: BotContext) {
  return getReminderDb(ctx);
}

const MANAGE_MAX_ITEMS = 25;

function rowData(row: RemindersRow): ReminderStoredData {
  const raw = row.data;
  let d: Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      d = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      d = {};
    }
  } else {
    d = (raw ?? {}) as Record<string, unknown>;
  }
  const ev = normalizeEventType(String(d.ev_type ?? "reminder"));
  const title = typeof d.title === "string" && d.title.trim() ? d.title.trim() : row.body.slice(0, 100);
  const rec = d.recurrence;
  let recurrence: { interval_sec: number } | null | undefined;
  if (rec && typeof rec === "object" && rec !== null && "interval_sec" in rec) {
    const sec = Number((rec as { interval_sec: unknown }).interval_sec);
    if (Number.isFinite(sec) && sec > 0) recurrence = { interval_sec: sec };
  }
  return { ev_type: ev, title, recurrence: recurrence ?? null };
}

function recurrenceJsonFromData(data: ReminderStoredData): string | null {
  const r = data.recurrence;
  if (r && Number(r.interval_sec) > 0) return JSON.stringify({ interval_sec: r.interval_sec });
  return null;
}

export type ReminderHubRowView = {
  id: string;
  ev_type: ReminderEvType;
  title: string;
  body: string;
  channel_id: string;
  author_id: string;
  fire_at: string;
  status: string;
  recurrence_json: string | null;
};

function toView(row: RemindersRow): ReminderHubRowView {
  const data = rowData(row);
  return {
    id: row.id,
    ev_type: data.ev_type,
    title: data.title,
    body: row.body,
    channel_id: row.channel_id,
    author_id: row.author_id,
    fire_at: row.fire_at,
    status: row.status,
    recurrence_json: recurrenceJsonFromData(data),
  };
}

export async function createReminderHubEntry(
  ctx: BotContext,
  input: {
    guildId: string;
    authorId: string;
    evType: ReminderEvType;
    title: string;
    body: string;
    channelId: string;
    fireAt: Date;
    recurrence: { interval_sec: number } | null;
  },
): Promise<string> {
  const id = randomUUID();
  const evType = normalizeEventType(input.evType);
  const data: ReminderStoredData = {
    ev_type: evType,
    title: input.title,
    recurrence: input.recurrence,
  };
  /** SQLite TEXT 列: better-sqlite3 はオブジェクトをバインドできないため JSON 文字列で保存 */
  const dataJson = JSON.stringify(data);
  await rdb(ctx)
    .insertInto("reminders")
    .values({
      id,
      guild_id: input.guildId,
      channel_id: input.channelId,
      author_id: input.authorId,
      body: input.body,
      fire_at: input.fireAt.toISOString(),
      status: "pending",
      data: dataJson as unknown as Record<string, unknown>,
      created_at: sqliteTimestamp() as unknown as Date,
    })
    .execute();
  return id;
}

export async function listActiveByType(
  ctx: BotContext,
  guildId: string,
  authorId: string,
  evType: ReminderEvType,
  limit = MANAGE_MAX_ITEMS,
): Promise<ReminderHubRowView[]> {
  const t = normalizeEventType(evType);
  const rows = await rdb(ctx)
    .selectFrom("reminders")
    .selectAll()
    .where("guild_id", "=", guildId)
    .where("author_id", "=", authorId)
    .where("status", "=", "pending")
    .orderBy("fire_at", "asc")
    .limit(200)
    .execute();
  const filtered = rows
    .filter((row) => rowData(row as RemindersRow).ev_type === t)
    .slice(0, limit);
  return filtered.map((row) => toView(row as RemindersRow));
}

export async function getActiveForAuthor(
  ctx: BotContext,
  guildId: string,
  authorId: string,
  id: string,
): Promise<ReminderHubRowView | null> {
  const row = await rdb(ctx)
    .selectFrom("reminders")
    .selectAll()
    .where("guild_id", "=", guildId)
    .where("author_id", "=", authorId)
    .where("id", "=", id)
    .where("status", "=", "pending")
    .executeTakeFirst();
  return row ? toView(row as RemindersRow) : null;
}

export async function getReminderRowForAuthor(
  ctx: BotContext,
  guildId: string,
  authorId: string,
  id: string,
): Promise<RemindersRow | null> {
  const row = await rdb(ctx)
    .selectFrom("reminders")
    .selectAll()
    .where("guild_id", "=", guildId)
    .where("author_id", "=", authorId)
    .where("id", "=", id)
    .where("status", "=", "pending")
    .executeTakeFirst();
  return row ? (row as RemindersRow) : null;
}

export async function updateReminderHubContent(
  ctx: BotContext,
  input: {
    guildId: string;
    authorId: string;
    id: string;
    title: string;
    body: string;
    fireAt: Date;
    recurrence: { interval_sec: number } | null;
  },
): Promise<number> {
  const cur = await rdb(ctx)
    .selectFrom("reminders")
    .selectAll()
    .where("guild_id", "=", input.guildId)
    .where("author_id", "=", input.authorId)
    .where("id", "=", input.id)
    .where("status", "=", "pending")
    .executeTakeFirst();
  if (!cur) return 0;
  const prev = rowData(cur as RemindersRow);
  const nextData: ReminderStoredData = {
    ev_type: prev.ev_type,
    title: input.title,
    recurrence: input.recurrence,
  };
  const nextDataJson = JSON.stringify(nextData);
  const result = await rdb(ctx)
    .updateTable("reminders")
    .set({
      body: input.body,
      fire_at: input.fireAt.toISOString(),
      data: nextDataJson as unknown as Record<string, unknown>,
    })
    .where("guild_id", "=", input.guildId)
    .where("author_id", "=", input.authorId)
    .where("id", "=", input.id)
    .where("status", "=", "pending")
    .executeTakeFirst();
  return Number(result.numUpdatedRows ?? 0);
}

export async function updateReminderHubChannel(
  ctx: BotContext,
  guildId: string,
  authorId: string,
  id: string,
  channelId: string,
): Promise<number> {
  const result = await rdb(ctx)
    .updateTable("reminders")
    .set({ channel_id: channelId })
    .where("guild_id", "=", guildId)
    .where("author_id", "=", authorId)
    .where("id", "=", id)
    .where("status", "=", "pending")
    .executeTakeFirst();
  return Number(result.numUpdatedRows ?? 0);
}

export async function cancelReminderForAuthor(
  ctx: BotContext,
  guildId: string,
  authorId: string,
  id: string,
): Promise<number> {
  const result = await rdb(ctx)
    .updateTable("reminders")
    .set({ status: "cancelled" })
    .where("guild_id", "=", guildId)
    .where("author_id", "=", authorId)
    .where("id", "=", id)
    .where("status", "=", "pending")
    .executeTakeFirst();
  return Number(result.numUpdatedRows ?? 0);
}

export async function fetchDuePending(ctx: BotContext, nowIsoStr: string, limit: number): Promise<RemindersRow[]> {
  const rows = await rdb(ctx)
    .selectFrom("reminders")
    .selectAll()
    .where("status", "=", "pending")
    .where("fire_at", "<=", nowIsoStr)
    .orderBy("fire_at", "asc")
    .limit(limit)
    .execute();
  return rows as RemindersRow[];
}

/** 即時投稿後の更新（繰り返しは基準を「今」に） */
export async function applyDispatchResult(
  ctx: BotContext,
  row: RemindersRow,
  forceNow: boolean,
): Promise<void> {
  const data = rowData(row);
  const recurrence = data.recurrence;
  if (recurrence && Number(recurrence.interval_sec) > 0) {
    const base = forceNow ? new Date() : new Date(row.fire_at);
    const baseTime = Number.isNaN(base.getTime()) ? Date.now() : base.getTime();
    const next = new Date(baseTime + Number(recurrence.interval_sec) * 1000);
    await rdb(ctx)
      .updateTable("reminders")
      .set({ fire_at: next.toISOString() })
      .where("id", "=", row.id)
      .execute();
  } else {
    await rdb(ctx).updateTable("reminders").set({ status: "fired" }).where("id", "=", row.id).execute();
  }
}

export function reminderRowStoredData(row: RemindersRow): ReminderStoredData {
  return rowData(row);
}

export { MANAGE_MAX_ITEMS };
