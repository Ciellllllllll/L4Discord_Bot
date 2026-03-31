import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type DatabaseLib from "better-sqlite3";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export const SQLITE_MIGRATIONS: { version: number; up: string; down: string }[] = [
  {
    version: 1,
    up: join(repoRoot, "migrations/sqlite/001_initial.up.sql"),
    down: join(repoRoot, "migrations/sqlite/001_initial.down.sql"),
  },
  {
    version: 2,
    up: join(repoRoot, "migrations/sqlite/002_message_vc.up.sql"),
    down: join(repoRoot, "migrations/sqlite/002_message_vc.down.sql"),
  },
  {
    version: 3,
    up: join(repoRoot, "migrations/sqlite/003_panels_domain.up.sql"),
    down: join(repoRoot, "migrations/sqlite/003_panels_domain.down.sql"),
  },
];

export function getSqliteUserVersion(db: DatabaseLib.Database): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  return row.user_version;
}

function setSqliteUserVersion(db: DatabaseLib.Database, v: number): void {
  db.pragma(`user_version = ${v}`);
}

/** Applies pending migrations in order. Returns applied version numbers. */
export function applyPendingSqliteMigrations(db: DatabaseLib.Database): number[] {
  const applied: number[] = [];
  let v = getSqliteUserVersion(db);
  for (const m of SQLITE_MIGRATIONS) {
    if (v < m.version) {
      db.exec(readFileSync(m.up, "utf8"));
      setSqliteUserVersion(db, m.version);
      v = m.version;
      applied.push(m.version);
    }
  }
  return applied;
}

/** Reverts migrations from current version down (same semantics as migrate script `down`). */
export function revertSqliteMigrations(db: DatabaseLib.Database): number[] {
  const reverted: number[] = [];
  let v = getSqliteUserVersion(db);
  for (let i = SQLITE_MIGRATIONS.length - 1; i >= 0; i--) {
    const m = SQLITE_MIGRATIONS[i]!;
    if (v >= m.version) {
      db.exec(readFileSync(m.down, "utf8"));
      setSqliteUserVersion(db, m.version - 1);
      v = m.version - 1;
      reverted.push(m.version);
    }
  }
  return reverted;
}
