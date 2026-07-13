-- メイン DB に reminders を戻す（専用 DB の内容は自動では戻さない）
CREATE TABLE reminders (
  id TEXT PRIMARY KEY NOT NULL,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  body TEXT NOT NULL,
  fire_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_reminders_guild_fire ON reminders(guild_id, fire_at, status);
