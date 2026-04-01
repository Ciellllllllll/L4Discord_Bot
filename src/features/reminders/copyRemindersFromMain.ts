import type DatabaseLib from "better-sqlite3";
import { ensureReminderSchema } from "./reminderDbSchema.js";

function tableExists(db: DatabaseLib.Database, name: string): boolean {
  const row = db
    .prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { x: number } | undefined;
  return Boolean(row);
}

/**
 * メイン DB に reminders が残っている場合のみ、reminder.db へコピーする。
 * マイグレーション 012 適用直前に呼ぶ（012 でメインから DROP される）。
 */
export function copyRemindersFromMainToReminderDb(
  mainSqlite: DatabaseLib.Database,
  destSqlite: DatabaseLib.Database,
): void {
  ensureReminderSchema(destSqlite);
  const destCount = destSqlite.prepare("SELECT COUNT(*) AS c FROM reminders").get() as { c: number };
  if ((destCount?.c ?? 0) > 0) {
    return;
  }
  if (!tableExists(mainSqlite, "reminders")) {
    return;
  }
  const cols = mainSqlite.prepare("PRAGMA table_info(reminders)").all() as { name: string }[];
  if (cols.length === 0) {
    return;
  }
  const names = cols.map((c) => c.name);
  const placeholders = names.map(() => "?").join(", ");
  const insertSql = `INSERT OR REPLACE INTO reminders (${names.join(", ")}) VALUES (${placeholders})`;
  const ins = destSqlite.prepare(insertSql);
  const rows = mainSqlite.prepare("SELECT * FROM reminders").all() as Record<string, unknown>[];
  for (const row of rows) {
    ins.run(...names.map((n) => row[n]));
  }
}
