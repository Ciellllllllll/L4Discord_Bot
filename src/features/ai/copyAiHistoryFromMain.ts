import type DatabaseLib from "better-sqlite3";
import { ensureAiHistorySchema } from "./aiHistorySchema.js";

function tableExists(db: DatabaseLib.Database, name: string): boolean {
  const row = db
    .prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { x: number } | undefined;
  return Boolean(row);
}

/**
 * メイン DB に ai_history が残っている場合のみ、専用 DB へコピーする。
 * マイグレーション 011 適用直前に呼ぶ（011 でメインから DROP される）。
 */
export function copyAiHistoryFromMainToDedicatedDb(
  mainSqlite: DatabaseLib.Database,
  destSqlite: DatabaseLib.Database,
): void {
  ensureAiHistorySchema(destSqlite);
  const destCount = destSqlite.prepare("SELECT COUNT(*) AS c FROM ai_history").get() as { c: number };
  if ((destCount?.c ?? 0) > 0) {
    return;
  }
  if (!tableExists(mainSqlite, "ai_history")) {
    return;
  }
  const cols = mainSqlite.prepare("PRAGMA table_info(ai_history)").all() as { name: string }[];
  if (cols.length === 0) {
    return;
  }
  const names = cols.map((c) => c.name);
  const placeholders = names.map(() => "?").join(", ");
  const insertSql = `INSERT OR REPLACE INTO ai_history (${names.join(", ")}) VALUES (${placeholders})`;
  const ins = destSqlite.prepare(insertSql);
  const rows = mainSqlite.prepare("SELECT * FROM ai_history").all() as Record<string, unknown>[];
  for (const row of rows) {
    ins.run(...names.map((n) => row[n]));
  }
}
