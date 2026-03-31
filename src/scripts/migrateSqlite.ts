import "dotenv/config";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { z } from "zod";
import { createSqliteDatabase } from "../core/db/sqlite.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

const envSchema = z.object({
  DATABASE_PATH: z.string().min(1),
});

const MIGRATIONS: { version: number; up: string; down: string }[] = [
  {
    version: 1,
    up: join(root, "migrations/sqlite/001_initial.up.sql"),
    down: join(root, "migrations/sqlite/001_initial.down.sql"),
  },
];

function getUserVersion(db: Database.Database): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  return row.user_version;
}

function setUserVersion(db: Database.Database, v: number): void {
  db.pragma(`user_version = ${v}`);
}

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
      let v = getUserVersion(db);
      for (const m of MIGRATIONS) {
        if (v < m.version) {
          const sql = readFileSync(m.up, "utf8");
          db.exec(sql);
          setUserVersion(db, m.version);
          v = m.version;
          console.log(`Applied migration ${m.version}`);
        }
      }
      if (v === 0 && MIGRATIONS.length === 0) {
        console.log("No migrations defined.");
      } else {
        console.log(`Done. user_version=${getUserVersion(db)}`);
      }
    } else if (cmd === "down") {
      let v = getUserVersion(db);
      for (let i = MIGRATIONS.length - 1; i >= 0; i--) {
        const m = MIGRATIONS[i]!;
        if (v >= m.version) {
          const sql = readFileSync(m.down, "utf8");
          db.exec(sql);
          setUserVersion(db, m.version - 1);
          v = m.version - 1;
          console.log(`Reverted migration ${m.version}`);
        }
      }
      console.log(`Done. user_version=${getUserVersion(db)}`);
    } else {
      console.error("Usage: tsx src/scripts/migrateSqlite.ts [up|down]");
      process.exit(1);
    }
  } finally {
    db.close();
  }
}

main();
