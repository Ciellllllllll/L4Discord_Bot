CREATE TABLE appeals (
  id TEXT PRIMARY KEY NOT NULL,
  code TEXT NOT NULL UNIQUE,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  punishment_type TEXT NOT NULL,
  punishment_reason TEXT,
  timeout_start INTEGER NOT NULL,
  timeout_end INTEGER NOT NULL,
  status TEXT NOT NULL,
  appeal_reason TEXT,
  detecter_incident_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  reviewer_id TEXT,
  review_note TEXT,
  review_message_id TEXT
);

CREATE INDEX idx_appeals_guild_user_created ON appeals (guild_id, user_id, created_at);
