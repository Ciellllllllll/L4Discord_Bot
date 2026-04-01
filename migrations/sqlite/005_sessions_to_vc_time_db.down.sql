CREATE TABLE sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  channel_id INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  duration_sec INTEGER
);

CREATE INDEX idx_sessions_open ON sessions(guild_id, user_id, ended_at);
CREATE INDEX idx_sessions_time ON sessions(started_at);
CREATE INDEX idx_sessions_channel ON sessions(channel_id);
