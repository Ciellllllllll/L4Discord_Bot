import type DatabaseLib from "better-sqlite3";

const ensuredDatabases = new WeakSet<DatabaseLib.Database>();

export function ensurePacchiSchema(db: DatabaseLib.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pacchi_settings (
      guild_id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 1,
      default_talk_enabled INTEGER NOT NULL DEFAULT 1,
      default_learn_enabled INTEGER NOT NULL DEFAULT 1,
      speak_rate TEXT NOT NULL DEFAULT 'normal',
      cooldown_seconds INTEGER NOT NULL DEFAULT 60,
      last_spoke_at TEXT,
      last_learned_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pacchi_channel_settings (
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      talk_enabled INTEGER NOT NULL DEFAULT 1,
      learn_enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (guild_id, channel_id)
    );

    CREATE TABLE IF NOT EXISTS pacchi_words (
      id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      word TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 1,
      last_seen_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (guild_id, word)
    );

    CREATE TABLE IF NOT EXISTS pacchi_phrases (
      id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      phrase TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 1,
      last_seen_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (guild_id, phrase)
    );

    CREATE TABLE IF NOT EXISTS pacchi_emojis (
      id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      emoji_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      display TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 1,
      last_seen_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (guild_id, emoji_key)
    );

    CREATE TABLE IF NOT EXISTS pacchi_sleep_logs (
      id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      sleep_at TEXT NOT NULL,
      wake_at TEXT,
      duration_seconds INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pacchi_daily_reports (
      id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      start_at TEXT NOT NULL,
      end_at TEXT,
      goal_text TEXT,
      progress_text TEXT,
      report_text TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pacchi_reply_logs (
      id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      trigger_type TEXT NOT NULL,
      reply_text TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pacchi_ng_words (
      id TEXT PRIMARY KEY,
      word TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );

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
  `);

  db.exec("CREATE INDEX IF NOT EXISTS idx_pacchi_words_guild_count ON pacchi_words(guild_id, count DESC);");
  db.exec("CREATE INDEX IF NOT EXISTS idx_pacchi_phrases_guild_count ON pacchi_phrases(guild_id, count DESC);");
  db.exec("CREATE INDEX IF NOT EXISTS idx_pacchi_emojis_guild_count ON pacchi_emojis(guild_id, count DESC);");
  db.exec("CREATE INDEX IF NOT EXISTS idx_pacchi_sleep_user_open ON pacchi_sleep_logs(guild_id, user_id, wake_at);");
  db.exec("CREATE INDEX IF NOT EXISTS idx_pacchi_daily_user_open ON pacchi_daily_reports(guild_id, user_id, end_at);");
  db.exec("CREATE INDEX IF NOT EXISTS idx_pacchi_reply_channel ON pacchi_reply_logs(guild_id, channel_id, created_at);");
  db.exec("CREATE INDEX IF NOT EXISTS idx_pacchi_lexicon_guild_count ON pacchi_lexicon(guild_id, count DESC);");
  db.exec("CREATE INDEX IF NOT EXISTS idx_pacchi_cooccurrences_guild_count ON pacchi_cooccurrences(guild_id, count DESC);");
  db.exec("CREATE INDEX IF NOT EXISTS idx_pacchi_sentence_patterns_guild_count ON pacchi_sentence_patterns(guild_id, count DESC);");
  db.exec("CREATE INDEX IF NOT EXISTS idx_pacchi_senryu_submissions_guild_created ON pacchi_senryu_submissions(guild_id, created_at DESC);");
}

export function ensurePacchiSchemaOnce(db: DatabaseLib.Database): void {
  if (ensuredDatabases.has(db)) return;
  ensurePacchiSchema(db);
  ensuredDatabases.add(db);
}
