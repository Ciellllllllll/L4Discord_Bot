import { migrateLegacyBooleanColumns, type LegacyBooleanColumn } from "../../core/db/legacyBooleanColumns.js";
import type { PgQueryable } from "../../core/db/postgres.js";

const PACCHI_POSTGRES_BOOLEAN_COLUMNS: readonly LegacyBooleanColumn[] = [
  { table: "pacchi_settings", column: "enabled", defaultValue: true },
  { table: "pacchi_settings", column: "default_talk_enabled", defaultValue: true },
  { table: "pacchi_settings", column: "default_learn_enabled", defaultValue: true },
  { table: "pacchi_channel_settings", column: "talk_enabled", defaultValue: true },
  { table: "pacchi_channel_settings", column: "learn_enabled", defaultValue: true },
];

/**
 * PostgreSQL runtime schema for Pacchi.  This deliberately lives beside the
 * Canonical PostgreSQL schema used by the asynchronous runtime repository.
 */
export async function ensurePostgresPacchiSchema(pool: PgQueryable): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pacchi_settings (
      guild_id text PRIMARY KEY,
      enabled boolean NOT NULL DEFAULT true,
      default_talk_enabled boolean NOT NULL DEFAULT true,
      default_learn_enabled boolean NOT NULL DEFAULT true,
      speak_rate text NOT NULL DEFAULT 'normal',
      cooldown_seconds integer NOT NULL DEFAULT 60,
      last_spoke_at text,
      last_learned_at text,
      created_at text NOT NULL,
      updated_at text NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pacchi_channel_settings (
      guild_id text NOT NULL,
      channel_id text NOT NULL,
      talk_enabled boolean NOT NULL DEFAULT true,
      learn_enabled boolean NOT NULL DEFAULT true,
      created_at text NOT NULL,
      updated_at text NOT NULL,
      PRIMARY KEY (guild_id, channel_id)
    );
    CREATE TABLE IF NOT EXISTS pacchi_words (
      id text PRIMARY KEY,
      guild_id text NOT NULL,
      word text NOT NULL,
      count integer NOT NULL DEFAULT 1,
      last_seen_at text NOT NULL,
      created_at text NOT NULL,
      UNIQUE (guild_id, word)
    );
    CREATE TABLE IF NOT EXISTS pacchi_phrases (
      id text PRIMARY KEY,
      guild_id text NOT NULL,
      phrase text NOT NULL,
      count integer NOT NULL DEFAULT 1,
      last_seen_at text NOT NULL,
      created_at text NOT NULL,
      UNIQUE (guild_id, phrase)
    );
    CREATE TABLE IF NOT EXISTS pacchi_emojis (
      id text PRIMARY KEY,
      guild_id text NOT NULL,
      emoji_key text NOT NULL,
      kind text NOT NULL,
      display text NOT NULL,
      count integer NOT NULL DEFAULT 1,
      last_seen_at text NOT NULL,
      created_at text NOT NULL,
      UNIQUE (guild_id, emoji_key)
    );
    CREATE TABLE IF NOT EXISTS pacchi_sleep_logs (
      id text PRIMARY KEY,
      guild_id text NOT NULL,
      user_id text NOT NULL,
      sleep_at text NOT NULL,
      wake_at text,
      duration_seconds integer,
      created_at text NOT NULL,
      updated_at text NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pacchi_daily_reports (
      id text PRIMARY KEY,
      guild_id text NOT NULL,
      user_id text NOT NULL,
      channel_id text NOT NULL,
      start_at text NOT NULL,
      end_at text,
      goal_text text,
      progress_text text,
      report_text text,
      created_at text NOT NULL,
      updated_at text NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pacchi_reply_logs (
      id text PRIMARY KEY,
      guild_id text NOT NULL,
      channel_id text NOT NULL,
      user_id text NOT NULL,
      trigger_type text NOT NULL,
      reply_text text NOT NULL,
      created_at text NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pacchi_ng_words (
      id text PRIMARY KEY,
      word text NOT NULL UNIQUE,
      created_at text NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pacchi_lexicon (
      id text PRIMARY KEY,
      guild_id text NOT NULL,
      surface text NOT NULL,
      base text NOT NULL,
      reading text NOT NULL,
      pos_json text NOT NULL,
      is_proper_noun boolean NOT NULL DEFAULT false,
      is_oov boolean NOT NULL DEFAULT false,
      source text NOT NULL,
      count integer NOT NULL DEFAULT 1,
      last_seen_at text NOT NULL,
      created_at text NOT NULL,
      UNIQUE (guild_id, base, pos_json)
    );
    CREATE TABLE IF NOT EXISTS pacchi_cooccurrences (
      id text PRIMARY KEY,
      guild_id text NOT NULL,
      word_a text NOT NULL,
      word_b text NOT NULL,
      count integer NOT NULL DEFAULT 1,
      last_seen_at text NOT NULL,
      created_at text NOT NULL,
      UNIQUE (guild_id, word_a, word_b)
    );
    CREATE TABLE IF NOT EXISTS pacchi_user_dictionary_entries (
      id text PRIMARY KEY,
      guild_id text NOT NULL,
      surface text NOT NULL,
      reading text NOT NULL,
      reason text NOT NULL,
      count integer NOT NULL DEFAULT 1,
      last_seen_at text NOT NULL,
      created_at text NOT NULL,
      UNIQUE (guild_id, surface, reading)
    );
    CREATE TABLE IF NOT EXISTS pacchi_sentence_patterns (
      id text PRIMARY KEY,
      guild_id text NOT NULL,
      surface_pattern text NOT NULL,
      slots_json text NOT NULL,
      ending text NOT NULL,
      source_kind text NOT NULL,
      count integer NOT NULL DEFAULT 1,
      safe_level integer NOT NULL DEFAULT 1,
      last_used_at text,
      created_at text NOT NULL,
      UNIQUE (guild_id, surface_pattern)
    );
    CREATE TABLE IF NOT EXISTS pacchi_senryu_submissions (
      id text PRIMARY KEY,
      guild_id text NOT NULL,
      channel_id text NOT NULL,
      message_id text NOT NULL,
      author_id text NOT NULL,
      kamigo text NOT NULL,
      nakashichi text NOT NULL,
      shimogo text NOT NULL,
      formatted text NOT NULL,
      source_content text NOT NULL,
      created_at text NOT NULL,
      UNIQUE (guild_id, message_id)
    );
    CREATE INDEX IF NOT EXISTS idx_pacchi_words_guild_count ON pacchi_words(guild_id, count DESC);
    CREATE INDEX IF NOT EXISTS idx_pacchi_phrases_guild_count ON pacchi_phrases(guild_id, count DESC);
    CREATE INDEX IF NOT EXISTS idx_pacchi_emojis_guild_count ON pacchi_emojis(guild_id, count DESC);
    CREATE INDEX IF NOT EXISTS idx_pacchi_sleep_user_open ON pacchi_sleep_logs(guild_id, user_id, wake_at);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_pacchi_sleep_open ON pacchi_sleep_logs(guild_id, user_id) WHERE wake_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_pacchi_daily_user_open ON pacchi_daily_reports(guild_id, user_id, end_at);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_pacchi_daily_report_open ON pacchi_daily_reports(guild_id, user_id) WHERE end_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_pacchi_reply_channel ON pacchi_reply_logs(guild_id, channel_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_pacchi_lexicon_guild_count ON pacchi_lexicon(guild_id, count DESC);
    CREATE INDEX IF NOT EXISTS idx_pacchi_cooccurrences_guild_count ON pacchi_cooccurrences(guild_id, count DESC);
    CREATE INDEX IF NOT EXISTS idx_pacchi_sentence_patterns_guild_count ON pacchi_sentence_patterns(guild_id, count DESC);
    CREATE INDEX IF NOT EXISTS idx_pacchi_senryu_submissions_guild_created ON pacchi_senryu_submissions(guild_id, created_at DESC);
  `);
}

/** Repairs old PostgreSQL copies that created Pacchi flags as bigint. */
export async function migratePostgresPacchiBooleanColumns(pool: PgQueryable): Promise<void> {
  await migrateLegacyBooleanColumns(pool, PACCHI_POSTGRES_BOOLEAN_COLUMNS);
}
