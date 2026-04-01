CREATE TABLE IF NOT EXISTS senryu_records (
  id TEXT PRIMARY KEY NOT NULL,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  kamigo TEXT NOT NULL,
  nakashichi TEXT NOT NULL,
  shimogo TEXT NOT NULL,
  formatted TEXT NOT NULL,
  source_content TEXT NOT NULL,
  spoiler INTEGER NOT NULL,
  detected_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_senryu_records_guild_id ON senryu_records (guild_id);
CREATE INDEX IF NOT EXISTS idx_senryu_records_message_id ON senryu_records (message_id);
CREATE INDEX IF NOT EXISTS idx_senryu_records_author_id ON senryu_records (author_id);
CREATE INDEX IF NOT EXISTS idx_senryu_records_detected_at ON senryu_records (detected_at);
