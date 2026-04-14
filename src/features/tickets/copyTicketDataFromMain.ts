import type DatabaseLib from "better-sqlite3";
import { ensureTicketDatabaseSchema } from "./ticketDbSchema.js";

const TICKET_TABLES_IN_COPY_ORDER = [
  "tickets",
  "modmail_threads",
  "modmail_intakes",
  "modmail_replies",
  "modmail_events",
  "appeals",
] as const;

function tableExists(db: DatabaseLib.Database, name: string): boolean {
  const row = db
    .prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { x: number } | undefined;
  return Boolean(row);
}

function copyTable(main: DatabaseLib.Database, ticket: DatabaseLib.Database, table: string): void {
  if (!tableExists(main, table)) return;
  const cols = main.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.length === 0) return;
  const names = cols.map((c) => c.name);
  const placeholders = names.map(() => "?").join(", ");
  const insertSql = `INSERT OR REPLACE INTO ${table} (${names.join(", ")}) VALUES (${placeholders})`;
  const ins = ticket.prepare(insertSql);
  const rows = main.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
  for (const row of rows) {
    ins.run(...names.map((n) => row[n]));
  }
}

// modmail_events の AUTOINCREMENT をコピー後の最大 id に合わせる

function syncModmailEventsSequence(ticket: DatabaseLib.Database): void {
  if (!tableExists(ticket, "modmail_events")) return;
  const row = ticket.prepare("SELECT MAX(id) AS m FROM modmail_events").get() as { m: number | null };
  const maxId = row?.m;
  if (maxId == null || maxId < 1) return;
  try {
    ticket.prepare("DELETE FROM sqlite_sequence WHERE name = 'modmail_events'").run();
    ticket.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('modmail_events', ?)").run(maxId);
  } catch {}
}

// メイン DB にチケット系テーブルが残っている場合のみ、ticket.db へコピーする。
// マイグレーション 010 適用直前に呼ぶ（010 でメインから DROP される）。

export function copyTicketDataFromMainToTicketDb(
  mainSqlite: DatabaseLib.Database,
  ticketSqlite: DatabaseLib.Database,
): void {
  ensureTicketDatabaseSchema(ticketSqlite);
  for (const t of TICKET_TABLES_IN_COPY_ORDER) {
    copyTable(mainSqlite, ticketSqlite, t);
  }
  syncModmailEventsSequence(ticketSqlite);
}
