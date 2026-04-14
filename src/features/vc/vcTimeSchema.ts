import type DatabaseLib from "better-sqlite3";

// vc_time.db: ensure_tables_and_indexes（Python）と同一の sessions + 索引

export function ensureVcTimeSchema(db: DatabaseLib.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      channel_id INTEGER NOT NULL,
      started_at TEXT NOT NULL,       -- ISO8601 UTC
      ended_at   TEXT,                -- ISO8601 UTC（NULL=接続中）
      duration_sec INTEGER            -- 切断時に確定（NULL可）
    );
  `);
  db.exec("DROP INDEX IF EXISTS idx_sessions_guild_user_open;");
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_sessions_open ON sessions(guild_id, user_id, ended_at);",
  );
  db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_time ON sessions(started_at);");
  db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_channel ON sessions(channel_id);");
}
