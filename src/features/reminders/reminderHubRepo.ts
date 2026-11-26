import { randomUUID } from "node:crypto";
import type { CoreDeps } from "../../core/deps.js";
import { nowIso } from "../../core/db/nowIso.js";
import type { RemindersRow } from "../../core/db/types.js";
import { getReminderDb } from "./reminderDb.js";
import { normalizeEventType, type ReminderEvType, type ReminderStoredData } from "./reminderHubTypes.js";

// ReminderHubRepo が使う依存。
type ReminderHubRepoDeps = Pick<CoreDeps, "config" | "db" | "log" | "client">;

function rdb(ctx: ReminderHubRepoDeps) {
  return getReminderDb(ctx);
}

const MANAGE_MAX_ITEMS = 25;

function getValidRecurrenceIntervalSec(recurrence: unknown): number | null {
  if (!recurrence || typeof recurrence !== "object" || !("interval_sec" in recurrence)) {
    return null;
  }
  const sec = Number((recurrence as { interval_sec: unknown }).interval_sec);
  return Number.isFinite(sec) && sec > 0 ? sec : null;
}

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
  const sec = getValidRecurrenceIntervalSec(d.recurrence);
  const recurrence = sec !== null ? { interval_sec: sec } : null;
  return { ev_type: ev, title, recurrence };
}

export function isRecurringReminder(row: RemindersRow): boolean {
  return getValidRecurrenceIntervalSec(rowData(row).recurrence) !== null;
}

function recurrenceJsonFromData(data: ReminderStoredData): string | null {
  const sec = getValidRecurrenceIntervalSec(data.recurrence);
  if (sec !== null) return JSON.stringify({ interval_sec: sec });
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
  ctx: ReminderHubRepoDeps,
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
    // PostgreSQLのjsonb列へ保存するJSON文字列

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
      created_at: nowIso() as unknown as Date,
    })
    .execute();
  return id;
}

export async function listActiveByType(
  ctx: ReminderHubRepoDeps,
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
  ctx: ReminderHubRepoDeps,
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

export async function getReminderRowById(
  ctx: ReminderHubRepoDeps,
  id: string,
): Promise<RemindersRow | null> {
  const row = await rdb(ctx)
    .selectFrom("reminders")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
  return row ? (row as RemindersRow) : null;
}

export async function getReminderRowForAuthor(
  ctx: ReminderHubRepoDeps,
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

export async function updateReminderHubChannel(
  ctx: ReminderHubRepoDeps,
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

export async function updateReminderHubContentAndChannel(
  ctx: ReminderHubRepoDeps,
  input: {
    guildId: string;
    authorId: string;
    id: string;
    title: string;
    body: string;
    fireAt: Date;
    recurrence: { interval_sec: number } | null;
    channelId: string;
  },
  db = rdb(ctx),
): Promise<number> {
  const cur = await db
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
  const result = await db
    .updateTable("reminders")
    .set({
      body: input.body,
      fire_at: input.fireAt.toISOString(),
      data: nextDataJson as unknown as Record<string, unknown>,
      channel_id: input.channelId,
    })
    .where("guild_id", "=", input.guildId)
    .where("author_id", "=", input.authorId)
    .where("id", "=", input.id)
    .where("status", "=", "pending")
    .executeTakeFirst();
  return Number(result.numUpdatedRows ?? 0);
}

export async function cancelReminderForAuthor(
  ctx: ReminderHubRepoDeps,
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

export async function fetchDuePending(
  ctx: ReminderHubRepoDeps,
  nowIsoStr: string,
  limit: number,
  excludeIds: readonly string[] = [],
): Promise<RemindersRow[]> {
  let query = rdb(ctx)
    .selectFrom("reminders")
    .selectAll()
    .where("status", "=", "pending")
    .where("fire_at", "<=", nowIsoStr);
  if (excludeIds.length > 0) {
    query = query.where("id", "not in", [...excludeIds]);
  }
  const rows = await query
    .orderBy("fire_at", "asc")
    .limit(limit)
    .execute();
  return rows as RemindersRow[];
}

// 即時投稿後の更新（繰り返しは基準を「今」に）

export function computeNextRecurringFireAt(
  fireAt: string,
  intervalSec: number,
  forceNow: boolean,
  nowMs = Date.now(),
): Date {
  const intervalMs = intervalSec * 1000;
  if (forceNow) {
    return new Date(nowMs + intervalMs);
  }
  const base = new Date(fireAt);
  const baseTime = Number.isNaN(base.getTime()) ? nowMs : base.getTime();
  if (baseTime + intervalMs > nowMs) {
    return new Date(baseTime + intervalMs);
  }
  const steps = Math.floor((nowMs - baseTime) / intervalMs) + 1;
  return new Date(baseTime + steps * intervalMs);
}

export function computeNextFireAtForRow(
  row: RemindersRow,
  forceNow: boolean,
  nowMs = Date.now(),
): string | null {
  if (!isRecurringReminder(row)) return null;
  const intervalSec = rowData(row).recurrence!.interval_sec;
  return computeNextRecurringFireAt(row.fire_at, intervalSec, forceNow, nowMs).toISOString();
}

export type ReminderDispatchUpdateResult = {
  updated: number;
  recurring: boolean;
  nextFireAt: string | null;
};

export async function applyDispatchResult(
  ctx: ReminderHubRepoDeps,
  row: RemindersRow,
  forceNow: boolean,
  db = rdb(ctx),
  fixedNextFireAt?: string | null,
): Promise<ReminderDispatchUpdateResult> {
  if (isRecurringReminder(row)) {
    const nextIso =
      typeof fixedNextFireAt === "string" && fixedNextFireAt.length > 0
        ? fixedNextFireAt
        : computeNextFireAtForRow(row, forceNow)!;
    const result = await db
      .updateTable("reminders")
      .set({ fire_at: nextIso })
      .where("id", "=", row.id)
      .where("status", "=", "pending")
      .where("fire_at", "=", row.fire_at)
      .executeTakeFirst();
    return {
      updated: Number(result.numUpdatedRows ?? 0),
      recurring: true,
      nextFireAt: nextIso,
    };
  }
  const result = await db
    .updateTable("reminders")
    .set({ status: "fired" })
    .where("id", "=", row.id)
    .where("status", "=", "pending")
    .where("fire_at", "=", row.fire_at)
    .executeTakeFirst();
  return {
    updated: Number(result.numUpdatedRows ?? 0),
    recurring: false,
    nextFireAt: null,
  };
}

export async function cancelUndeliverableReminder(
  ctx: ReminderHubRepoDeps,
  row: RemindersRow,
  db = rdb(ctx),
): Promise<number> {
  const result = await db
    .updateTable("reminders")
    .set({ status: "cancelled" })
    .where("id", "=", row.id)
    .where("status", "=", "pending")
    .where("fire_at", "=", row.fire_at)
    .executeTakeFirst();
  return Number(result.numUpdatedRows ?? 0);
}

export function reminderRowStoredData(row: RemindersRow): ReminderStoredData {
  return rowData(row);
}

export { MANAGE_MAX_ITEMS };
