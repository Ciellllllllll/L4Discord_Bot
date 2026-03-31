import "dotenv/config";
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

  try {
    ensureTicketDatabaseSchema(ticketDb);
    if (cmd === "up") {
      const applied = applyPendingSqliteMigrations(db, {
        beforeApplyVersion(version, mainSqlite) {
          if (version === 10) {
            copyTicketDataFromMainToTicketDb(mainSqlite, ticketDb);
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
  }
}

main();
