CREATE TABLE modmail_intakes (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  dm_sent_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);

CREATE INDEX idx_modmail_intakes_user_status ON modmail_intakes (user_id, status);
