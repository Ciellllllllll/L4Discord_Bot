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
  `);

  db.exec("CREATE INDEX IF NOT EXISTS idx_pacchi_words_guild_count ON pacchi_words(guild_id, count DESC);");
  db.exec("CREATE INDEX IF NOT EXISTS idx_pacchi_phrases_guild_count ON pacchi_phrases(guild_id, count DESC);");
  db.exec("CREATE INDEX IF NOT EXISTS idx_pacchi_emojis_guild_count ON pacchi_emojis(guild_id, count DESC);");
  db.exec("CREATE INDEX IF NOT EXISTS idx_pacchi_sleep_user_open ON pacchi_sleep_logs(guild_id, user_id, wake_at);");
  db.exec("CREATE INDEX IF NOT EXISTS idx_pacchi_daily_user_open ON pacchi_daily_reports(guild_id, user_id, end_at);");
  db.exec("CREATE INDEX IF NOT EXISTS idx_pacchi_reply_channel ON pacchi_reply_logs(guild_id, channel_id, created_at);");
}

export function ensurePacchiSchemaOnce(db: DatabaseLib.Database): void {
  if (ensuredDatabases.has(db)) return;
  ensurePacchiSchema(db);
  ensuredDatabases.add(db);
}
