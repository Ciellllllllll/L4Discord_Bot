CREATE TABLE reaction_role_entries (
  id TEXT PRIMARY KEY NOT NULL,
  guild_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  roles_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (guild_id, entry_id)
);

CREATE INDEX idx_reaction_role_entries_guild ON reaction_role_entries(guild_id);
