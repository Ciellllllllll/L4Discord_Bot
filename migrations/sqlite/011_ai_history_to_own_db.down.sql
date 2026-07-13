-- メイン DB に ai_history を戻す（専用 DB の内容は自動では戻さない）
CREATE TABLE ai_history (
  id TEXT PRIMARY KEY NOT NULL,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  meta TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_ai_history_guild_user ON ai_history(guild_id, user_id, created_at);
CREATE INDEX idx_ai_history_guild_created ON ai_history(guild_id, created_at);
