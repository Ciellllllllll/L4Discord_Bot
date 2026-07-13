import "dotenv/config";
import { copyAiHistoryFromMainToDedicatedDb } from "../features/ai/copyAiHistoryFromMain.js";
import { copyRemindersFromMainToReminderDb } from "../features/reminders/copyRemindersFromMain.js";
import { ensureAiHistorySchema } from "../features/ai/aiHistorySchema.js";
import { copyTicketDataFromMainToTicketDb } from "../features/tickets/copyTicketDataFromMain.js";
import { ensureTicketDatabaseSchema } from "../features/tickets/ticketDbSchema.js";
import { loadConfig } from "../core/config.js";
import {
  SQLITE_MIGRATIONS,
  applyPendingSqliteMigrations,
  getSqliteUserVersion,
  revertSqliteMigrations,
} from "../core/db/sqliteMigrations.js";
import { createSqliteDatabase } from "../core/db/sqlite.js";

function main(): void {
  const config = loadConfig();
  const cmd = process.argv[2] ?? "up";
  const db = createSqliteDatabase(config.DATABASE_PATH);
  const ticketDb = createSqliteDatabase(config.TICKET_DATABASE_PATH);
  const aiHistoryDb = createSqliteDatabase(config.AI_HISTORY_DATABASE_PATH);

  try {
    ensureTicketDatabaseSchema(ticketDb);
    ensureAiHistorySchema(aiHistoryDb);
    if (cmd === "up") {
      const applied = applyPendingSqliteMigrations(db, {
        beforeApplyVersion(version, mainSqlite) {
          if (version === 10) {
            copyTicketDataFromMainToTicketDb(mainSqlite, ticketDb);
          }
          if (version === 11) {
            copyAiHistoryFromMainToDedicatedDb(mainSqlite, aiHistoryDb);
          }
          if (version === 12) {
            const rs = createSqliteDatabase(config.REMINDER_DATABASE_PATH);
            try {
              copyRemindersFromMainToReminderDb(mainSqlite, rs);
            } finally {
              rs.close();
            }
          }
        },
      });
      for (const version of applied) {
        console.log(`Applied migration ${version}`);
      }
      if (SQLITE_MIGRATIONS.length === 0) {
        console.log("No migrations defined.");
      }
      console.log(`Done. user_version=${getSqliteUserVersion(db)}`);
    } else if (cmd === "down") {
      const reverted = revertSqliteMigrations(db);
      for (const version of reverted) {
        console.log(`Reverted migration ${version}`);
      }
      console.log(`Done. user_version=${getSqliteUserVersion(db)}`);
    } else {
      console.error("Usage: tsx src/scripts/migrateSqlite.ts [up|down]");
      process.exit(1);
    }
  } finally {
    db.close();
    ticketDb.close();
    aiHistoryDb.close();
  }
}

main();
