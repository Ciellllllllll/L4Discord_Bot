import type DatabaseLib from "better-sqlite3";

// /q 会話履歴専用 DB（既定: data/AI_History.db）

export function ensureAiHistorySchema(db: DatabaseLib.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_history (
      id TEXT PRIMARY KEY NOT NULL,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      meta TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_ai_history_guild_user ON ai_history(guild_id, user_id, created_at);");
  db.exec("CREATE INDEX IF NOT EXISTS idx_ai_history_guild_created ON ai_history(guild_id, created_at);");
}
