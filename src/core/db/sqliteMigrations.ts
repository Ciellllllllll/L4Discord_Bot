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
  {
    version: 4,
    up: join(repoRoot, "migrations/sqlite/004_message_logs_to_message_db.up.sql"),
    down: join(repoRoot, "migrations/sqlite/004_message_logs_to_message_db.down.sql"),
  },
  {
    version: 5,
    up: join(repoRoot, "migrations/sqlite/005_sessions_to_vc_time_db.up.sql"),
    down: join(repoRoot, "migrations/sqlite/005_sessions_to_vc_time_db.down.sql"),
  },
  {
    version: 6,
    up: join(repoRoot, "migrations/sqlite/006_reaction_role_entries.up.sql"),
    down: join(repoRoot, "migrations/sqlite/006_reaction_role_entries.down.sql"),
  },
  {
    version: 7,
    up: join(repoRoot, "migrations/sqlite/007_modmail_intakes.up.sql"),
    down: join(repoRoot, "migrations/sqlite/007_modmail_intakes.down.sql"),
  },
  {
    version: 8,
    up: join(repoRoot, "migrations/sqlite/008_appeals.up.sql"),
    down: join(repoRoot, "migrations/sqlite/008_appeals.down.sql"),
  },
  {
    version: 9,
    up: join(repoRoot, "migrations/sqlite/009_modmail_replies_events.up.sql"),
    down: join(repoRoot, "migrations/sqlite/009_modmail_replies_events.down.sql"),
  },
  {
    version: 10,
    up: join(repoRoot, "migrations/sqlite/010_ticket_tables_to_ticket_db.up.sql"),
    down: join(repoRoot, "migrations/sqlite/010_ticket_tables_to_ticket_db.down.sql"),
  },
  {
    version: 11,
    up: join(repoRoot, "migrations/sqlite/011_ai_history_to_own_db.up.sql"),
    down: join(repoRoot, "migrations/sqlite/011_ai_history_to_own_db.down.sql"),
  },
  {
    version: 12,
    up: join(repoRoot, "migrations/sqlite/012_reminder_to_own_db.up.sql"),
    down: join(repoRoot, "migrations/sqlite/012_reminder_to_own_db.down.sql"),
  },
  {
    version: 13,
    up: join(repoRoot, "migrations/sqlite/013_senryu.up.sql"),
    down: join(repoRoot, "migrations/sqlite/013_senryu.down.sql"),
  },
  {
    version: 14,
    up: join(repoRoot, "migrations/sqlite/014_vc_temp_tracked_channels.up.sql"),
    down: join(repoRoot, "migrations/sqlite/014_vc_temp_tracked_channels.down.sql"),
  },
  {
    version: 15,
    up: join(repoRoot, "migrations/sqlite/015_steam_free.up.sql"),
    down: join(repoRoot, "migrations/sqlite/015_steam_free.down.sql"),
  },
  // ticket.db 側の appeals / modmail_replies 列追加はメイン DB マイグレーションに含めない（ensureTicketDatabaseSchema で列追加）。
];

export function getSqliteUserVersion(db: DatabaseLib.Database): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  return row.user_version;
}

function setSqliteUserVersion(db: DatabaseLib.Database, v: number): void {
  db.pragma(`user_version = ${v}`);
}

export type SqliteMigrationHooks = {
    // 該当バージョンの up を実行する直前（例: v10 で ticket.db へデータコピー）

  beforeApplyVersion?: (version: number, mainDb: DatabaseLib.Database) => void;
};

// Applies pending migrations in order. Returns applied version numbers.

export function applyPendingSqliteMigrations(
  db: DatabaseLib.Database,
  hooks?: SqliteMigrationHooks,
): number[] {
  const applied: number[] = [];
  let v = getSqliteUserVersion(db);
  for (const m of SQLITE_MIGRATIONS) {
    if (v < m.version) {
      hooks?.beforeApplyVersion?.(m.version, db);
      db.exec(readFileSync(m.up, "utf8"));
      setSqliteUserVersion(db, m.version);
      v = m.version;
      applied.push(m.version);
    }
  }
  return applied;
}

// Reverts migrations from current version down (same semantics as migrate script `down`).

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
