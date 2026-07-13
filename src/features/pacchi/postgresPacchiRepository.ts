import type { Pool, PoolClient } from "pg";
import { ulid } from "ulid";
import { RATE_CONFIG } from "./pacchi.reply.js";
import { ensurePostgresPacchiSchema } from "./pacchi.schema.js";
import type {
  PacchiChannelSettings,
  PacchiCooccurrenceExportEntry,
  PacchiEmojiRow,
  PacchiExportData,
  PacchiLearnedEmoji,
  PacchiLexiconExportEntry,
  PacchiLexiconInput,
  PacchiLexiconRow,
  PacchiMemoryStats,
  PacchiPhraseRow,
  PacchiRate,
  PacchiSentencePatternExportEntry,
  PacchiSenryuSubmissionInput,
  PacchiSentencePatternInput,
  PacchiSentencePatternRow,
  PacchiSettings,
  PacchiUserDictionaryExportEntry,
  PacchiWordRow,
} from "./pacchi.types.js";

type PgSettingsRow = {
  guild_id: string;
  enabled: boolean | number;
  default_talk_enabled: boolean | number;
  default_learn_enabled: boolean | number;
  speak_rate: PacchiRate;
  cooldown_seconds: number | string;
  last_spoke_at: string | null;
  last_learned_at: string | null;
};

type PgChannelRow = {
  guild_id: string;
  channel_id: string;
  talk_enabled: boolean | number;
  learn_enabled: boolean | number;
};

const bool = (value: unknown): boolean => value === true || value === 1 || value === "1" || value === "t";
const nowIso = (): string => new Date().toISOString();

function toSettings(row: PgSettingsRow): PacchiSettings {
  return {
    guildId: row.guild_id,
    enabled: bool(row.enabled),
    defaultTalkEnabled: bool(row.default_talk_enabled),
    defaultLearnEnabled: bool(row.default_learn_enabled),
    speakRate: row.speak_rate,
    cooldownSeconds: Number(row.cooldown_seconds),
    lastSpokeAt: row.last_spoke_at,
    lastLearnedAt: row.last_learned_at,
  };
}

function toChannel(row: PgChannelRow): PacchiChannelSettings {
  return {
    guildId: row.guild_id,
    channelId: row.channel_id,
    talkEnabled: bool(row.talk_enabled),
    learnEnabled: bool(row.learn_enabled),
  };
}

async function withTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export class PostgresPacchiRepository {
  constructor(private readonly pool: Pool) {}

  async ensureSchema(): Promise<void> {
    await ensurePostgresPacchiSchema(this.pool);
  }

  async getSettings(guildId: string): Promise<PacchiSettings> {
    const now = nowIso();
    const result = await this.pool.query<PgSettingsRow>(
      `INSERT INTO pacchi_settings (guild_id, enabled, default_talk_enabled, default_learn_enabled, speak_rate, cooldown_seconds, created_at, updated_at)
       VALUES ($1, true, true, true, 'normal', 60, $2, $2)
       ON CONFLICT (guild_id) DO NOTHING
       RETURNING *`,
      [guildId, now],
    );
    if (result.rows[0]) return toSettings(result.rows[0]);
    const existing = await this.pool.query<PgSettingsRow>("SELECT * FROM pacchi_settings WHERE guild_id = $1", [guildId]);
    return toSettings(existing.rows[0]!);
  }

  async setEnabled(guildId: string, enabled: boolean): Promise<void> {
    await this.getSettings(guildId);
    await this.pool.query("UPDATE pacchi_settings SET enabled = $1, updated_at = $2 WHERE guild_id = $3", [enabled, nowIso(), guildId]);
  }

  async setRate(guildId: string, rate: PacchiRate): Promise<void> {
    await this.getSettings(guildId);
    await this.pool.query("UPDATE pacchi_settings SET speak_rate = $1, cooldown_seconds = $2, updated_at = $3 WHERE guild_id = $4", [rate, RATE_CONFIG[rate].cooldownSeconds, nowIso(), guildId]);
  }

  async touchSpoke(guildId: string, at = nowIso()): Promise<void> {
    await this.getSettings(guildId);
    await this.pool.query("UPDATE pacchi_settings SET last_spoke_at = $1, updated_at = $1 WHERE guild_id = $2", [at, guildId]);
  }

  async touchLearned(guildId: string, at = nowIso()): Promise<void> {
    await this.getSettings(guildId);
    await this.pool.query("UPDATE pacchi_settings SET last_learned_at = $1, updated_at = $1 WHERE guild_id = $2", [at, guildId]);
  }

  async getChannelSettings(guildId: string, channelId: string): Promise<PacchiChannelSettings> {
    const settings = await this.getSettings(guildId);
    const result = await this.pool.query<PgChannelRow>("SELECT * FROM pacchi_channel_settings WHERE guild_id = $1 AND channel_id = $2", [guildId, channelId]);
    return result.rows[0] ? toChannel(result.rows[0]) : {
      guildId,
      channelId,
      talkEnabled: settings.defaultTalkEnabled,
      learnEnabled: settings.defaultLearnEnabled,
    };
  }

  async setChannelSettings(guildId: string, channelId: string, talkEnabled: boolean, learnEnabled: boolean): Promise<void> {
    const now = nowIso();
    await this.pool.query(
      `INSERT INTO pacchi_channel_settings (guild_id, channel_id, talk_enabled, learn_enabled, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $5)
       ON CONFLICT (guild_id, channel_id) DO UPDATE SET talk_enabled = excluded.talk_enabled, learn_enabled = excluded.learn_enabled, updated_at = excluded.updated_at`,
      [guildId, channelId, talkEnabled, learnEnabled, now],
    );
  }

  async learn(guildId: string, words: string[], phrase: string | null): Promise<void> {
    const now = nowIso();
    await this.getSettings(guildId);
    await withTransaction(this.pool, async (client) => {
      for (const word of words) {
        await client.query(
          `INSERT INTO pacchi_words (id, guild_id, word, count, last_seen_at, created_at) VALUES ($1, $2, $3, 1, $4, $4)
           ON CONFLICT (guild_id, word) DO UPDATE SET count = pacchi_words.count + 1, last_seen_at = excluded.last_seen_at`,
          [ulid(), guildId, word, now],
        );
      }
      if (phrase) {
        await client.query(
          `INSERT INTO pacchi_phrases (id, guild_id, phrase, count, last_seen_at, created_at) VALUES ($1, $2, $3, 1, $4, $4)
           ON CONFLICT (guild_id, phrase) DO UPDATE SET count = pacchi_phrases.count + 1, last_seen_at = excluded.last_seen_at`,
          [ulid(), guildId, phrase, now],
        );
      }
      await client.query("UPDATE pacchi_settings SET last_learned_at = $1, updated_at = $1 WHERE guild_id = $2", [now, guildId]);
    });
  }

  async learnEmojis(guildId: string, emojis: PacchiLearnedEmoji[]): Promise<void> {
    if (emojis.length === 0) return;
    const now = nowIso();
    await this.getSettings(guildId);
    await withTransaction(this.pool, async (client) => {
      for (const emoji of emojis) {
        await client.query(
          `INSERT INTO pacchi_emojis (id, guild_id, emoji_key, kind, display, count, last_seen_at, created_at) VALUES ($1, $2, $3, $4, $5, 1, $6, $6)
           ON CONFLICT (guild_id, emoji_key) DO UPDATE SET count = pacchi_emojis.count + 1, display = excluded.display, last_seen_at = excluded.last_seen_at`,
          [ulid(), guildId, emoji.key, emoji.kind, emoji.display, now],
        );
      }
      await client.query("UPDATE pacchi_settings SET last_learned_at = $1, updated_at = $1 WHERE guild_id = $2", [now, guildId]);
    });
  }

  async learnMorph(guildId: string, tokens: PacchiLexiconInput[]): Promise<void> {
    if (tokens.length === 0) return;
    const now = nowIso();
    await this.getSettings(guildId);
    await withTransaction(this.pool, async (client) => {
      const uniqueBases = [...new Set(tokens.map((token) => token.base).filter(Boolean))].sort();
      for (const token of tokens) {
        await client.query(
          `INSERT INTO pacchi_lexicon (id, guild_id, surface, base, reading, pos_json, is_proper_noun, is_oov, source, count, last_seen_at, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, $10, $10)
           ON CONFLICT (guild_id, base, pos_json) DO UPDATE SET surface = excluded.surface, reading = excluded.reading, is_proper_noun = excluded.is_proper_noun, is_oov = excluded.is_oov, source = excluded.source, count = pacchi_lexicon.count + 1, last_seen_at = excluded.last_seen_at`,
          [ulid(), guildId, token.surface, token.base, token.reading, JSON.stringify(token.pos), token.isProperNoun, token.isOov, token.source, now],
        );
        if (token.isProperNoun || token.isOov) {
          await client.query(
            `INSERT INTO pacchi_user_dictionary_entries (id, guild_id, surface, reading, reason, count, last_seen_at, created_at)
             VALUES ($1, $2, $3, $4, $5, 1, $6, $6)
             ON CONFLICT (guild_id, surface, reading) DO UPDATE SET reason = excluded.reason, count = pacchi_user_dictionary_entries.count + 1, last_seen_at = excluded.last_seen_at`,
            [ulid(), guildId, token.surface, token.reading, token.isProperNoun ? "proper_noun" : "oov", now],
          );
        }
      }
      for (let i = 0; i < uniqueBases.length; i += 1) {
        for (let j = i + 1; j < uniqueBases.length; j += 1) {
          const a = uniqueBases[i]!;
          const b = uniqueBases[j]!;
          await client.query(
            `INSERT INTO pacchi_cooccurrences (id, guild_id, word_a, word_b, count, last_seen_at, created_at) VALUES ($1, $2, $3, $4, 1, $5, $5)
             ON CONFLICT (guild_id, word_a, word_b) DO UPDATE SET count = pacchi_cooccurrences.count + 1, last_seen_at = excluded.last_seen_at`,
            [ulid(), guildId, a <= b ? a : b, a <= b ? b : a, now],
          );
        }
      }
      await client.query("UPDATE pacchi_settings SET last_learned_at = $1, updated_at = $1 WHERE guild_id = $2", [now, guildId]);
    });
  }

  async learnSentencePattern(guildId: string, pattern: PacchiSentencePatternInput): Promise<void> {
    const now = nowIso();
    await this.pool.query(
      `INSERT INTO pacchi_sentence_patterns (id, guild_id, surface_pattern, slots_json, ending, source_kind, count, safe_level, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8)
       ON CONFLICT (guild_id, surface_pattern) DO UPDATE SET count = pacchi_sentence_patterns.count + 1, safe_level = LEAST(pacchi_sentence_patterns.safe_level, excluded.safe_level)`,
      [ulid(), guildId, pattern.surfacePattern, JSON.stringify(pattern.slots), pattern.ending, pattern.sourceKind, pattern.safeLevel, now],
    );
  }

  async saveSenryuSubmission(input: PacchiSenryuSubmissionInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO pacchi_senryu_submissions (id, guild_id, channel_id, message_id, author_id, kamigo, nakashichi, shimogo, formatted, source_content, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (guild_id, message_id) DO NOTHING`,
      [ulid(), input.guildId, input.channelId, input.messageId, input.authorId, input.kamigo, input.nakashichi, input.shimogo, input.formatted, input.sourceContent, nowIso()],
    );
  }

  async topWords(guildId: string, limit: number): Promise<PacchiWordRow[]> {
    return (await this.pool.query<PacchiWordRow>("SELECT * FROM pacchi_words WHERE guild_id = $1 ORDER BY count DESC, last_seen_at DESC LIMIT $2", [guildId, limit])).rows;
  }

  async randomWords(guildId: string, limit: number): Promise<PacchiWordRow[]> {
    return (await this.pool.query<PacchiWordRow>("SELECT * FROM pacchi_words WHERE guild_id = $1 ORDER BY random() LIMIT $2", [guildId, limit])).rows;
  }

  async topLexiconByPos(guildId: string, pos: string, limit: number): Promise<PacchiLexiconRow[]> {
    return (await this.pool.query<PacchiLexiconRow>("SELECT * FROM pacchi_lexicon WHERE guild_id = $1 AND pos_json LIKE $2 ORDER BY count DESC, last_seen_at DESC, random() LIMIT $3", [guildId, `%${pos}%`, limit])).rows;
  }

  async relatedWords(guildId: string, word: string, limit: number): Promise<string[]> {
    const rows = (await this.pool.query<{ word: string }>(
      `SELECT word_b AS word FROM pacchi_cooccurrences WHERE guild_id = $1 AND word_a = $2
       UNION ALL SELECT word_a AS word FROM pacchi_cooccurrences WHERE guild_id = $1 AND word_b = $2 LIMIT $3`,
      [guildId, word, limit],
    )).rows;
    return rows.map((row) => row.word);
  }

  async randomSentencePattern(guildId: string): Promise<PacchiSentencePatternRow | null> {
    const rows = (await this.pool.query<PacchiSentencePatternRow>("SELECT * FROM pacchi_sentence_patterns WHERE guild_id = $1 AND safe_level <= 2 ORDER BY count DESC, random() LIMIT 20", [guildId])).rows;
    if (rows.length === 0) return null;
    const weighted = rows.flatMap((row) => Array.from({ length: Math.min(Number(row.count), 3) }, () => row));
    return weighted[Math.floor(Math.random() * weighted.length)] ?? rows[0] ?? null;
  }

  async topPhrases(guildId: string, limit: number): Promise<PacchiPhraseRow[]> {
    return (await this.pool.query<PacchiPhraseRow>("SELECT * FROM pacchi_phrases WHERE guild_id = $1 ORDER BY count DESC, last_seen_at DESC LIMIT $2", [guildId, limit])).rows;
  }

  async pickWord(guildId: string): Promise<string | null> {
    const rows = (await this.pool.query<PacchiWordRow>("SELECT * FROM pacchi_words WHERE guild_id = $1 ORDER BY count DESC, random() LIMIT 20", [guildId])).rows;
    if (rows.length === 0) return null;
    const weighted = rows.flatMap((row) => Array.from({ length: Math.min(Number(row.count), 5) }, () => row.word));
    return weighted[Math.floor(Math.random() * weighted.length)] ?? rows[0]!.word;
  }

  async pickEmoji(guildId: string): Promise<string | null> {
    const rows = (await this.pool.query<PacchiEmojiRow>("SELECT * FROM pacchi_emojis WHERE guild_id = $1 AND kind IN ('unicode', 'custom') ORDER BY count DESC, random() LIMIT 20", [guildId])).rows;
    if (rows.length === 0) return null;
    const weighted = rows.flatMap((row) => Array.from({ length: Math.min(Number(row.count), 5) }, () => row.display));
    return weighted[Math.floor(Math.random() * weighted.length)] ?? rows[0]!.display;
  }

  async stats(guildId: string): Promise<PacchiMemoryStats> {
    const row = (await this.pool.query<PacchiMemoryStats>(
      `SELECT
        (SELECT count(*) FROM pacchi_words WHERE guild_id = $1) AS "wordCount",
        (SELECT count(*) FROM pacchi_phrases WHERE guild_id = $1) AS "phraseCount",
        (SELECT count(*) FROM pacchi_emojis WHERE guild_id = $1) AS "emojiCount",
        (SELECT count(*) FROM pacchi_sleep_logs WHERE guild_id = $1 AND wake_at IS NOT NULL) AS "sleepLogCount",
        (SELECT count(*) FROM pacchi_daily_reports WHERE guild_id = $1 AND end_at IS NOT NULL) AS "dailyReportCount"`,
      [guildId],
    )).rows[0];
    return {
      wordCount: Number(row?.wordCount ?? 0),
      phraseCount: Number(row?.phraseCount ?? 0),
      emojiCount: Number(row?.emojiCount ?? 0),
      sleepLogCount: Number(row?.sleepLogCount ?? 0),
      dailyReportCount: Number(row?.dailyReportCount ?? 0),
    };
  }

  async forgetWord(guildId: string, word: string): Promise<number> {
    return (await this.pool.query("DELETE FROM pacchi_words WHERE guild_id = $1 AND word = $2", [guildId, word])).rowCount ?? 0;
  }

  async forgetPhrase(guildId: string, phrase: string): Promise<number> {
    return (await this.pool.query("DELETE FROM pacchi_phrases WHERE guild_id = $1 AND phrase = $2", [guildId, phrase])).rowCount ?? 0;
  }

  async forgetAll(guildId: string): Promise<number> {
    const stats = await this.stats(guildId);
    const replyLogs = (await this.pool.query<{ count: string }>("SELECT count(*) FROM pacchi_reply_logs WHERE guild_id = $1", [guildId])).rows[0];
    const before = stats.wordCount + stats.phraseCount + stats.emojiCount + Number(replyLogs?.count ?? 0);
    await withTransaction(this.pool, async (client) => {
      await client.query("DELETE FROM pacchi_words WHERE guild_id = $1", [guildId]);
      await client.query("DELETE FROM pacchi_phrases WHERE guild_id = $1", [guildId]);
      await client.query("DELETE FROM pacchi_emojis WHERE guild_id = $1", [guildId]);
      await client.query("DELETE FROM pacchi_reply_logs WHERE guild_id = $1", [guildId]);
    });
    return before;
  }

  async logReply(guildId: string, channelId: string, userId: string, triggerType: string, replyText: string): Promise<void> {
    await this.pool.query("INSERT INTO pacchi_reply_logs (id, guild_id, channel_id, user_id, trigger_type, reply_text, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)", [ulid(), guildId, channelId, userId, triggerType, replyText, nowIso()]);
  }

  async startSleep(guildId: string, userId: string): Promise<string> {
    const now = nowIso();
    const inserted = await this.pool.query<{ sleep_at: string }>(
      `INSERT INTO pacchi_sleep_logs (id, guild_id, user_id, sleep_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $4, $4)
       ON CONFLICT (guild_id, user_id) WHERE wake_at IS NULL DO NOTHING
       RETURNING sleep_at`,
      [ulid(), guildId, userId, now],
    );
    if (inserted.rows[0]) return inserted.rows[0].sleep_at;
    const current = (await this.pool.query<{ sleep_at: string }>("SELECT sleep_at FROM pacchi_sleep_logs WHERE guild_id = $1 AND user_id = $2 AND wake_at IS NULL ORDER BY sleep_at DESC LIMIT 1", [guildId, userId])).rows[0];
    return current?.sleep_at ?? now;
  }

  async endSleep(guildId: string, userId: string): Promise<{ sleepAt: string; wakeAt: string; durationSeconds: number } | null> {
    const row = (await this.pool.query<{ id: string; sleep_at: string }>("SELECT id, sleep_at FROM pacchi_sleep_logs WHERE guild_id = $1 AND user_id = $2 AND wake_at IS NULL ORDER BY sleep_at DESC LIMIT 1", [guildId, userId])).rows[0];
    if (!row) return null;
    const wakeAt = nowIso();
    const durationSeconds = Math.floor((Date.parse(wakeAt) - Date.parse(row.sleep_at)) / 1000);
    await this.pool.query("UPDATE pacchi_sleep_logs SET wake_at = $1, duration_seconds = $2, updated_at = $1 WHERE id = $3", [wakeAt, durationSeconds, row.id]);
    return { sleepAt: row.sleep_at, wakeAt, durationSeconds };
  }

  async latestSleep(guildId: string, userId: string): Promise<{ sleep_at: string; wake_at: string; duration_seconds: number } | null> {
    return (await this.pool.query<{ sleep_at: string; wake_at: string; duration_seconds: number }>("SELECT sleep_at, wake_at, duration_seconds FROM pacchi_sleep_logs WHERE guild_id = $1 AND user_id = $2 AND wake_at IS NOT NULL ORDER BY wake_at DESC LIMIT 1", [guildId, userId])).rows[0] ?? null;
  }

  async startReport(guildId: string, userId: string, channelId: string, goalText: string): Promise<boolean> {
    const now = nowIso();
    const inserted = await this.pool.query(
      `INSERT INTO pacchi_daily_reports (id, guild_id, user_id, channel_id, start_at, goal_text, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $5, $5)
       ON CONFLICT (guild_id, user_id) WHERE end_at IS NULL DO NOTHING`,
      [ulid(), guildId, userId, channelId, now, goalText],
    );
    return (inserted.rowCount ?? 0) > 0;
  }

  async endReport(guildId: string, userId: string, progressText: string): Promise<{ reportText: string; durationSeconds: number } | null> {
    const row = (await this.pool.query<{ id: string; start_at: string; goal_text: string | null }>("SELECT id, start_at, goal_text FROM pacchi_daily_reports WHERE guild_id = $1 AND user_id = $2 AND end_at IS NULL ORDER BY start_at DESC LIMIT 1", [guildId, userId])).rows[0];
    if (!row) return null;
    const endAt = nowIso();
    const durationSeconds = Math.floor((Date.parse(endAt) - Date.parse(row.start_at)) / 1000);
    const reportText = [
      "今日の日報",
      "",
      `作業時間: ${Math.floor(durationSeconds / 3600)}時間${Math.floor((durationSeconds % 3600) / 60)}分`,
      `目標: ${row.goal_text || "未設定"}`,
      `進捗: ${progressText || "未記入"}`,
      "ぱっちぃコメント: ぱっちぃは見ていた",
    ].join("\n");
    await this.pool.query("UPDATE pacchi_daily_reports SET end_at = $1, progress_text = $2, report_text = $3, updated_at = $1 WHERE id = $4", [endAt, progressText, reportText, row.id]);
    return { reportText, durationSeconds };
  }

  async latestReport(guildId: string, userId: string): Promise<{ start_at: string; end_at: string | null; goal_text: string | null } | null> {
    return (await this.pool.query<{ start_at: string; end_at: string | null; goal_text: string | null }>("SELECT start_at, end_at, goal_text FROM pacchi_daily_reports WHERE guild_id = $1 AND user_id = $2 ORDER BY start_at DESC LIMIT 1", [guildId, userId])).rows[0] ?? null;
  }

  async exportData(guildId: string): Promise<PacchiExportData> {
    const settings = await this.getSettings(guildId);
    const ngRows = (await this.pool.query<{ word: string }>("SELECT word FROM pacchi_ng_words ORDER BY word ASC")).rows;
    const words = await this.topWords(guildId, 500);
    const phrases = await this.topPhrases(guildId, 300);
    const emojis = (await this.pool.query<PacchiEmojiRow>("SELECT * FROM pacchi_emojis WHERE guild_id = $1 ORDER BY count DESC, last_seen_at DESC LIMIT 500", [guildId])).rows;
    const lexiconRows = (await this.pool.query<PacchiLexiconRow & { source: string }>("SELECT surface, base, reading, pos_json, is_proper_noun, is_oov, source, count FROM pacchi_lexicon WHERE guild_id = $1 ORDER BY count DESC, last_seen_at DESC LIMIT 1000", [guildId])).rows;
    const cooccurrenceRows = (await this.pool.query<{ word_a: string; word_b: string; count: number }>("SELECT word_a, word_b, count FROM pacchi_cooccurrences WHERE guild_id = $1 ORDER BY count DESC, last_seen_at DESC LIMIT 1000", [guildId])).rows;
    const userDictionaryRows = (await this.pool.query<PacchiUserDictionaryExportEntry>("SELECT surface, reading, reason, count FROM pacchi_user_dictionary_entries WHERE guild_id = $1 ORDER BY count DESC, last_seen_at DESC LIMIT 1000", [guildId])).rows;
    const patternRows = (await this.pool.query<{ surface_pattern: string; slots_json: string; ending: string; source_kind: string; count: number; safe_level: number }>("SELECT surface_pattern, slots_json, ending, source_kind, count, safe_level FROM pacchi_sentence_patterns WHERE guild_id = $1 ORDER BY count DESC, created_at DESC LIMIT 1000", [guildId])).rows;
    return {
      version: 1,
      exportedAt: nowIso(),
      words: words.map((row) => ({ word: row.word, count: Number(row.count) })),
      phrases: phrases.map((row) => ({ phrase: row.phrase, count: Number(row.count) })),
      emojis: emojis.map((row) => ({ key: row.emoji_key, kind: row.kind, display: row.display, count: Number(row.count) })),
      lexicon: lexiconRows.map((row) => ({ surface: row.surface, base: row.base, reading: row.reading, pos: JSON.parse(row.pos_json) as string[], isProperNoun: bool(row.is_proper_noun), isOov: bool(row.is_oov), source: row.source, count: Number(row.count) })),
      cooccurrences: cooccurrenceRows.map((row) => ({ wordA: row.word_a, wordB: row.word_b, count: Number(row.count) })),
      userDictionaryEntries: userDictionaryRows.map((row) => ({ ...row, count: Number(row.count) })),
      sentencePatterns: patternRows.map((row) => ({ surfacePattern: row.surface_pattern, slots: JSON.parse(row.slots_json) as string[], ending: row.ending, sourceKind: row.source_kind, safeLevel: Number(row.safe_level), count: Number(row.count) })),
      settings: { enabled: settings.enabled, defaultTalkEnabled: settings.defaultTalkEnabled, defaultLearnEnabled: settings.defaultLearnEnabled, speakRate: settings.speakRate, cooldownSeconds: settings.cooldownSeconds },
      ngWords: ngRows.map((row) => row.word),
    };
  }

  async importData(guildId: string, data: PacchiExportData): Promise<{ words: number; phrases: number; emojis: number; lexicon: number; cooccurrences: number; userDictionaryEntries: number; sentencePatterns: number }> {
    const now = nowIso();
    await withTransaction(this.pool, async (client) => {
      if (data.settings) {
        await client.query(
          `INSERT INTO pacchi_settings (guild_id, enabled, default_talk_enabled, default_learn_enabled, speak_rate, cooldown_seconds, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
           ON CONFLICT (guild_id) DO UPDATE SET enabled = excluded.enabled, default_talk_enabled = excluded.default_talk_enabled, default_learn_enabled = excluded.default_learn_enabled, speak_rate = excluded.speak_rate, cooldown_seconds = excluded.cooldown_seconds, updated_at = excluded.updated_at`,
          [guildId, data.settings.enabled, data.settings.defaultTalkEnabled, data.settings.defaultLearnEnabled, data.settings.speakRate, data.settings.cooldownSeconds, now],
        );
      } else {
        const existing = await client.query("SELECT 1 FROM pacchi_settings WHERE guild_id = $1", [guildId]);
        if ((existing.rowCount ?? 0) === 0) await client.query("INSERT INTO pacchi_settings (guild_id, created_at, updated_at) VALUES ($1, $2, $2)", [guildId, now]);
      }
      for (const word of data.words) await client.query("INSERT INTO pacchi_words (id, guild_id, word, count, last_seen_at, created_at) VALUES ($1, $2, $3, $4, $5, $5) ON CONFLICT (guild_id, word) DO UPDATE SET count = pacchi_words.count + excluded.count, last_seen_at = excluded.last_seen_at", [ulid(), guildId, word.word, Math.max(1, word.count), now]);
      for (const phrase of data.phrases) await client.query("INSERT INTO pacchi_phrases (id, guild_id, phrase, count, last_seen_at, created_at) VALUES ($1, $2, $3, $4, $5, $5) ON CONFLICT (guild_id, phrase) DO UPDATE SET count = pacchi_phrases.count + excluded.count, last_seen_at = excluded.last_seen_at", [ulid(), guildId, phrase.phrase, Math.max(1, phrase.count), now]);
      for (const emoji of data.emojis) await client.query("INSERT INTO pacchi_emojis (id, guild_id, emoji_key, kind, display, count, last_seen_at, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $7) ON CONFLICT (guild_id, emoji_key) DO UPDATE SET count = pacchi_emojis.count + excluded.count, display = excluded.display, last_seen_at = excluded.last_seen_at", [ulid(), guildId, emoji.key, emoji.kind, emoji.display, Math.max(1, emoji.count), now]);
      for (const token of (data.lexicon ?? []) as PacchiLexiconExportEntry[]) await client.query("INSERT INTO pacchi_lexicon (id, guild_id, surface, base, reading, pos_json, is_proper_noun, is_oov, source, count, last_seen_at, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11) ON CONFLICT (guild_id, base, pos_json) DO UPDATE SET surface = excluded.surface, reading = excluded.reading, is_proper_noun = excluded.is_proper_noun, is_oov = excluded.is_oov, source = excluded.source, count = pacchi_lexicon.count + excluded.count, last_seen_at = excluded.last_seen_at", [ulid(), guildId, token.surface, token.base, token.reading, JSON.stringify(token.pos), token.isProperNoun, token.isOov, token.source, Math.max(1, token.count), now]);
      for (const co of (data.cooccurrences ?? []) as PacchiCooccurrenceExportEntry[]) {
        const a = co.wordA <= co.wordB ? co.wordA : co.wordB;
        const b = co.wordA <= co.wordB ? co.wordB : co.wordA;
        await client.query("INSERT INTO pacchi_cooccurrences (id, guild_id, word_a, word_b, count, last_seen_at, created_at) VALUES ($1, $2, $3, $4, $5, $6, $6) ON CONFLICT (guild_id, word_a, word_b) DO UPDATE SET count = pacchi_cooccurrences.count + excluded.count, last_seen_at = excluded.last_seen_at", [ulid(), guildId, a, b, Math.max(1, co.count), now]);
      }
      for (const entry of (data.userDictionaryEntries ?? []) as PacchiUserDictionaryExportEntry[]) await client.query("INSERT INTO pacchi_user_dictionary_entries (id, guild_id, surface, reading, reason, count, last_seen_at, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $7) ON CONFLICT (guild_id, surface, reading) DO UPDATE SET reason = excluded.reason, count = pacchi_user_dictionary_entries.count + excluded.count, last_seen_at = excluded.last_seen_at", [ulid(), guildId, entry.surface, entry.reading, entry.reason, Math.max(1, entry.count), now]);
      for (const pattern of (data.sentencePatterns ?? []) as PacchiSentencePatternExportEntry[]) await client.query("INSERT INTO pacchi_sentence_patterns (id, guild_id, surface_pattern, slots_json, ending, source_kind, count, safe_level, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (guild_id, surface_pattern) DO UPDATE SET count = pacchi_sentence_patterns.count + excluded.count, safe_level = LEAST(pacchi_sentence_patterns.safe_level, excluded.safe_level)", [ulid(), guildId, pattern.surfacePattern, JSON.stringify(pattern.slots), pattern.ending, pattern.sourceKind, Math.max(1, pattern.count), pattern.safeLevel, now]);
      for (const word of data.ngWords) await client.query("INSERT INTO pacchi_ng_words (id, word, created_at) VALUES ($1, $2, $3) ON CONFLICT (word) DO NOTHING", [ulid(), word, now]);
    });
    return { words: data.words.length, phrases: data.phrases.length, emojis: data.emojis.length, lexicon: data.lexicon?.length ?? 0, cooccurrences: data.cooccurrences?.length ?? 0, userDictionaryEntries: data.userDictionaryEntries?.length ?? 0, sentencePatterns: data.sentencePatterns?.length ?? 0 };
  }
}

export type PostgresPacchiRepositoryLike = PostgresPacchiRepository;
