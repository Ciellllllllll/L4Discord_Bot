CREATE TABLE IF NOT EXISTS pacchi_lexicon (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  surface TEXT NOT NULL,
  base TEXT NOT NULL,
  reading TEXT NOT NULL,
  pos_json TEXT NOT NULL,
  is_proper_noun INTEGER NOT NULL DEFAULT 0,
  is_oov INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (guild_id, base, pos_json)
);

CREATE TABLE IF NOT EXISTS pacchi_cooccurrences (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  word_a TEXT NOT NULL,
  word_b TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (guild_id, word_a, word_b)
);

CREATE TABLE IF NOT EXISTS pacchi_user_dictionary_entries (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  surface TEXT NOT NULL,
  reading TEXT NOT NULL,
  reason TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (guild_id, surface, reading)
);

CREATE TABLE IF NOT EXISTS pacchi_sentence_patterns (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  surface_pattern TEXT NOT NULL,
  slots_json TEXT NOT NULL,
  ending TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  safe_level INTEGER NOT NULL DEFAULT 1,
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (guild_id, surface_pattern)
);

CREATE INDEX IF NOT EXISTS idx_pacchi_lexicon_guild_count ON pacchi_lexicon(guild_id, count DESC);
CREATE INDEX IF NOT EXISTS idx_pacchi_cooccurrences_guild_count ON pacchi_cooccurrences(guild_id, count DESC);
CREATE INDEX IF NOT EXISTS idx_pacchi_sentence_patterns_guild_count ON pacchi_sentence_patterns(guild_id, count DESC);

CREATE TABLE IF NOT EXISTS pacchi_senryu_submissions (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  kamigo TEXT NOT NULL,
  nakashichi TEXT NOT NULL,
  shimogo TEXT NOT NULL,
  formatted TEXT NOT NULL,
  source_content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (guild_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_pacchi_senryu_submissions_guild_created
  ON pacchi_senryu_submissions(guild_id, created_at DESC);
