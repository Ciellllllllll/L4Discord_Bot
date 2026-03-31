import "dotenv/config";
import { z } from "zod";
import {
  SQLITE_MIGRATIONS,
  applyPendingSqliteMigrations,
  getSqliteUserVersion,
  revertSqliteMigrations,
} from "../core/db/sqliteMigrations.js";
import { createSqliteDatabase } from "../core/db/sqlite.js";

const envSchema = z.object({
  DATABASE_PATH: z.string().min(1),
});

function main(): void {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error("Invalid env: set DATABASE_PATH to your .sqlite file path");
    process.exit(1);
  }
  const cmd = process.argv[2] ?? "up";
  const db = createSqliteDatabase(parsed.data.DATABASE_PATH);

  try {
    if (cmd === "up") {
      const applied = applyPendingSqliteMigrations(db);
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
  }
}

main();
