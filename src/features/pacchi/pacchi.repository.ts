import type DatabaseLib from "better-sqlite3";
import { ulid } from "ulid";
import type {
  PacchiChannelSettings,
  PacchiEmojiRow,
  PacchiExportData,
  PacchiLearnedEmoji,
  PacchiMemoryStats,
  PacchiPhraseRow,
  PacchiRate,
  PacchiSettings,
  PacchiWordRow,
} from "./pacchi.types.js";
import { RATE_CONFIG } from "./pacchi.reply.js";

type SettingsRow = {
  guild_id: string;
  enabled: number;
  default_talk_enabled: number;
  default_learn_enabled: number;
  speak_rate: PacchiRate;
  cooldown_seconds: number;
  last_spoke_at: string | null;
  last_learned_at: string | null;
};

type ChannelRow = {
  guild_id: string;
  channel_id: string;
  talk_enabled: number;
  learn_enabled: number;
};

function nowIso(): string {
  return new Date().toISOString();
}

function boolInt(value: boolean): number {
  return value ? 1 : 0;
}

function toSettings(row: SettingsRow): PacchiSettings {
  return {
    guildId: row.guild_id,
    enabled: row.enabled === 1,
    defaultTalkEnabled: row.default_talk_enabled === 1,
    defaultLearnEnabled: row.default_learn_enabled === 1,
    speakRate: row.speak_rate,
    cooldownSeconds: row.cooldown_seconds,
    lastSpokeAt: row.last_spoke_at,
    lastLearnedAt: row.last_learned_at,
  };
}

function toChannel(row: ChannelRow): PacchiChannelSettings {
  return {
    guildId: row.guild_id,
    channelId: row.channel_id,
    talkEnabled: row.talk_enabled === 1,
    learnEnabled: row.learn_enabled === 1,
  };
}

export function createPacchiRepository(sqlite: DatabaseLib.Database) {
  const getSettingsStmt = sqlite.prepare("SELECT * FROM pacchi_settings WHERE guild_id = ?");
  const insertSettingsStmt = sqlite.prepare(`
    INSERT INTO pacchi_settings (
      guild_id, enabled, default_talk_enabled, default_learn_enabled,
      speak_rate, cooldown_seconds, created_at, updated_at
    ) VALUES (?, 1, 1, 1, 'normal', 60, ?, ?)
  `);
  const setEnabledStmt = sqlite.prepare("UPDATE pacchi_settings SET enabled = ?, updated_at = ? WHERE guild_id = ?");
  const setRateStmt = sqlite.prepare(
    "UPDATE pacchi_settings SET speak_rate = ?, cooldown_seconds = ?, updated_at = ? WHERE guild_id = ?",
  );
  const touchSpokeStmt = sqlite.prepare("UPDATE pacchi_settings SET last_spoke_at = ?, updated_at = ? WHERE guild_id = ?");
  const touchLearnedStmt = sqlite.prepare("UPDATE pacchi_settings SET last_learned_at = ?, updated_at = ? WHERE guild_id = ?");

  const getChannelStmt = sqlite.prepare("SELECT * FROM pacchi_channel_settings WHERE guild_id = ? AND channel_id = ?");
  const upsertChannelStmt = sqlite.prepare(`
    INSERT INTO pacchi_channel_settings (
      guild_id, channel_id, talk_enabled, learn_enabled, created_at, updated_at
    ) VALUES (@guild_id, @channel_id, @talk_enabled, @learn_enabled, @now, @now)
    ON CONFLICT(guild_id, channel_id) DO UPDATE SET
      talk_enabled = excluded.talk_enabled,
      learn_enabled = excluded.learn_enabled,
      updated_at = excluded.updated_at
  `);
  const upsertWordStmt = sqlite.prepare(`
    INSERT INTO pacchi_words (id, guild_id, word, count, last_seen_at, created_at)
    VALUES (@id, @guild_id, @word, 1, @now, @now)
    ON CONFLICT(guild_id, word) DO UPDATE SET
      count = count + 1,
      last_seen_at = excluded.last_seen_at
  `);
  const upsertPhraseStmt = sqlite.prepare(`
    INSERT INTO pacchi_phrases (id, guild_id, phrase, count, last_seen_at, created_at)
    VALUES (@id, @guild_id, @phrase, 1, @now, @now)
    ON CONFLICT(guild_id, phrase) DO UPDATE SET
      count = count + 1,
      last_seen_at = excluded.last_seen_at
  `);
  const upsertEmojiStmt = sqlite.prepare(`
    INSERT INTO pacchi_emojis (id, guild_id, emoji_key, kind, display, count, last_seen_at, created_at)
    VALUES (@id, @guild_id, @emoji_key, @kind, @display, 1, @now, @now)
    ON CONFLICT(guild_id, emoji_key) DO UPDATE SET
      count = count + 1,
      display = excluded.display,
      last_seen_at = excluded.last_seen_at
  `);
  const topWordsStmt = sqlite.prepare(
    "SELECT * FROM pacchi_words WHERE guild_id = ? ORDER BY count DESC, last_seen_at DESC LIMIT ?",
  );
  const topPhrasesStmt = sqlite.prepare(
    "SELECT * FROM pacchi_phrases WHERE guild_id = ? ORDER BY count DESC, last_seen_at DESC LIMIT ?",
  );
  const randomWordStmt = sqlite.prepare(
    "SELECT * FROM pacchi_words WHERE guild_id = ? ORDER BY count DESC, random() LIMIT 20",
  );
  const randomEmojiStmt = sqlite.prepare(
    "SELECT * FROM pacchi_emojis WHERE guild_id = ? AND kind IN ('unicode', 'custom') ORDER BY count DESC, random() LIMIT 20",
  );
  const deleteWordStmt = sqlite.prepare("DELETE FROM pacchi_words WHERE guild_id = ? AND word = ?");
  const deletePhraseStmt = sqlite.prepare("DELETE FROM pacchi_phrases WHERE guild_id = ? AND phrase = ?");
  const clearWordsStmt = sqlite.prepare("DELETE FROM pacchi_words WHERE guild_id = ?");
  const clearPhrasesStmt = sqlite.prepare("DELETE FROM pacchi_phrases WHERE guild_id = ?");
  const clearEmojisStmt = sqlite.prepare("DELETE FROM pacchi_emojis WHERE guild_id = ?");
  const clearReplyLogsStmt = sqlite.prepare("DELETE FROM pacchi_reply_logs WHERE guild_id = ?");

  const openSleepStmt = sqlite.prepare(
    "SELECT * FROM pacchi_sleep_logs WHERE guild_id = ? AND user_id = ? AND wake_at IS NULL ORDER BY sleep_at DESC LIMIT 1",
  );
  const latestSleepStmt = sqlite.prepare(
    "SELECT * FROM pacchi_sleep_logs WHERE guild_id = ? AND user_id = ? AND wake_at IS NOT NULL ORDER BY wake_at DESC LIMIT 1",
  );
  const insertSleepStmt = sqlite.prepare(`
    INSERT INTO pacchi_sleep_logs (id, guild_id, user_id, sleep_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const closeSleepStmt = sqlite.prepare(
    "UPDATE pacchi_sleep_logs SET wake_at = ?, duration_seconds = ?, updated_at = ? WHERE id = ?",
  );

  const openReportStmt = sqlite.prepare(
    "SELECT * FROM pacchi_daily_reports WHERE guild_id = ? AND user_id = ? AND end_at IS NULL ORDER BY start_at DESC LIMIT 1",
  );
  const latestReportStmt = sqlite.prepare(
    "SELECT * FROM pacchi_daily_reports WHERE guild_id = ? AND user_id = ? ORDER BY start_at DESC LIMIT 1",
  );
  const insertReportStmt = sqlite.prepare(`
    INSERT INTO pacchi_daily_reports (
      id, guild_id, user_id, channel_id, start_at, goal_text, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const closeReportStmt = sqlite.prepare(
    "UPDATE pacchi_daily_reports SET end_at = ?, progress_text = ?, report_text = ?, updated_at = ? WHERE id = ?",
  );

  const insertReplyLogStmt = sqlite.prepare(`
    INSERT INTO pacchi_reply_logs (id, guild_id, channel_id, user_id, trigger_type, reply_text, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const statsStmt = sqlite.prepare(`
    SELECT
      (SELECT count(*) FROM pacchi_words WHERE guild_id = @guild_id) AS wordCount,
      (SELECT count(*) FROM pacchi_phrases WHERE guild_id = @guild_id) AS phraseCount,
      (SELECT count(*) FROM pacchi_emojis WHERE guild_id = @guild_id) AS emojiCount,
      (SELECT count(*) FROM pacchi_sleep_logs WHERE guild_id = @guild_id AND wake_at IS NOT NULL) AS sleepLogCount,
      (SELECT count(*) FROM pacchi_daily_reports WHERE guild_id = @guild_id AND end_at IS NOT NULL) AS dailyReportCount
  `);

  return {
    getSettings(guildId: string): PacchiSettings {
      const existing = getSettingsStmt.get(guildId) as SettingsRow | undefined;
      if (existing) return toSettings(existing);
      const now = nowIso();
      insertSettingsStmt.run(guildId, now, now);
      return toSettings(getSettingsStmt.get(guildId) as SettingsRow);
    },

    setEnabled(guildId: string, enabled: boolean): void {
      this.getSettings(guildId);
      setEnabledStmt.run(boolInt(enabled), nowIso(), guildId);
    },

    setRate(guildId: string, rate: PacchiRate): void {
      this.getSettings(guildId);
      setRateStmt.run(rate, RATE_CONFIG[rate].cooldownSeconds, nowIso(), guildId);
    },

    touchSpoke(guildId: string, at = nowIso()): void {
      this.getSettings(guildId);
      touchSpokeStmt.run(at, at, guildId);
    },

    touchLearned(guildId: string, at = nowIso()): void {
      this.getSettings(guildId);
      touchLearnedStmt.run(at, at, guildId);
    },

    getChannelSettings(guildId: string, channelId: string): PacchiChannelSettings {
      const settings = this.getSettings(guildId);
      const row = getChannelStmt.get(guildId, channelId) as ChannelRow | undefined;
      if (row) return toChannel(row);
      return {
        guildId,
        channelId,
        talkEnabled: settings.defaultTalkEnabled,
        learnEnabled: settings.defaultLearnEnabled,
      };
    },

    setChannelSettings(guildId: string, channelId: string, talkEnabled: boolean, learnEnabled: boolean): void {
      upsertChannelStmt.run({
        guild_id: guildId,
        channel_id: channelId,
        talk_enabled: boolInt(talkEnabled),
        learn_enabled: boolInt(learnEnabled),
        now: nowIso(),
      });
    },

    learn(guildId: string, words: string[], phrase: string | null): void {
      const now = nowIso();
      const tx = sqlite.transaction(() => {
        for (const word of words) {
          upsertWordStmt.run({ id: ulid(), guild_id: guildId, word, now });
        }
        if (phrase) {
          upsertPhraseStmt.run({ id: ulid(), guild_id: guildId, phrase, now });
        }
        touchLearnedStmt.run(now, now, guildId);
      });
      this.getSettings(guildId);
      tx();
    },

    learnEmojis(guildId: string, emojis: PacchiLearnedEmoji[]): void {
      if (emojis.length === 0) return;
      const now = nowIso();
      const tx = sqlite.transaction(() => {
        for (const emoji of emojis) {
          upsertEmojiStmt.run({
            id: ulid(),
            guild_id: guildId,
            emoji_key: emoji.key,
            kind: emoji.kind,
            display: emoji.display,
            now,
          });
        }
        touchLearnedStmt.run(now, now, guildId);
      });
      this.getSettings(guildId);
      tx();
    },

    topWords(guildId: string, limit: number): PacchiWordRow[] {
      return topWordsStmt.all(guildId, limit) as PacchiWordRow[];
    },

    topPhrases(guildId: string, limit: number): PacchiPhraseRow[] {
      return topPhrasesStmt.all(guildId, limit) as PacchiPhraseRow[];
    },

    pickWord(guildId: string): string | null {
      const rows = randomWordStmt.all(guildId) as PacchiWordRow[];
      if (rows.length === 0) return null;
      const weighted = rows.flatMap((row) => Array.from({ length: Math.min(row.count, 5) }, () => row.word));
      return weighted[Math.floor(Math.random() * weighted.length)] ?? rows[0]!.word;
    },

    pickEmoji(guildId: string): string | null {
      const rows = randomEmojiStmt.all(guildId) as PacchiEmojiRow[];
      if (rows.length === 0) return null;
      const weighted = rows.flatMap((row) => Array.from({ length: Math.min(row.count, 5) }, () => row.display));
      return weighted[Math.floor(Math.random() * weighted.length)] ?? rows[0]!.display;
    },

    stats(guildId: string): PacchiMemoryStats {
      return statsStmt.get({ guild_id: guildId }) as PacchiMemoryStats;
    },

    forgetWord(guildId: string, word: string): number {
      return Number(deleteWordStmt.run(guildId, word).changes);
    },

    forgetPhrase(guildId: string, phrase: string): number {
      return Number(deletePhraseStmt.run(guildId, phrase).changes);
    },

    forgetAll(guildId: string): number {
      const tx = sqlite.transaction(() => {
        const a = Number(clearWordsStmt.run(guildId).changes);
        const b = Number(clearPhrasesStmt.run(guildId).changes);
        const c = Number(clearEmojisStmt.run(guildId).changes);
        const d = Number(clearReplyLogsStmt.run(guildId).changes);
        return a + b + c + d;
      });
      return tx();
    },

    logReply(guildId: string, channelId: string, userId: string, triggerType: string, replyText: string): void {
      insertReplyLogStmt.run(ulid(), guildId, channelId, userId, triggerType, replyText, nowIso());
    },

    startSleep(guildId: string, userId: string): string {
      const current = openSleepStmt.get(guildId, userId) as { sleep_at: string } | undefined;
      if (current) return current.sleep_at;
      const now = nowIso();
      insertSleepStmt.run(ulid(), guildId, userId, now, now, now);
      return now;
    },

    endSleep(guildId: string, userId: string): { sleepAt: string; wakeAt: string; durationSeconds: number } | null {
      const row = openSleepStmt.get(guildId, userId) as { id: string; sleep_at: string } | undefined;
      if (!row) return null;
      const wakeAt = nowIso();
      const durationSeconds = Math.floor((Date.parse(wakeAt) - Date.parse(row.sleep_at)) / 1000);
      closeSleepStmt.run(wakeAt, durationSeconds, wakeAt, row.id);
      return { sleepAt: row.sleep_at, wakeAt, durationSeconds };
    },

    latestSleep(guildId: string, userId: string): { sleep_at: string; wake_at: string; duration_seconds: number } | null {
      return latestSleepStmt.get(guildId, userId) as { sleep_at: string; wake_at: string; duration_seconds: number } | undefined ?? null;
    },

    startReport(guildId: string, userId: string, channelId: string, goalText: string): boolean {
      if (openReportStmt.get(guildId, userId)) return false;
      const now = nowIso();
      insertReportStmt.run(ulid(), guildId, userId, channelId, now, goalText, now, now);
      return true;
    },

    endReport(guildId: string, userId: string, progressText: string): { reportText: string; durationSeconds: number } | null {
      const row = openReportStmt.get(guildId, userId) as { id: string; start_at: string; goal_text: string | null } | undefined;
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
      closeReportStmt.run(endAt, progressText, reportText, endAt, row.id);
      return { reportText, durationSeconds };
    },

    latestReport(guildId: string, userId: string): { start_at: string; end_at: string | null; goal_text: string | null } | null {
      return latestReportStmt.get(guildId, userId) as { start_at: string; end_at: string | null; goal_text: string | null } | undefined ?? null;
    },

    exportData(guildId: string): PacchiExportData {
      const settings = this.getSettings(guildId);
      const ngRows = sqlite.prepare("SELECT word FROM pacchi_ng_words ORDER BY word ASC").all() as { word: string }[];
      return {
        version: 1,
        exportedAt: nowIso(),
        words: this.topWords(guildId, 500).map((r) => ({ word: r.word, count: r.count })),
        phrases: this.topPhrases(guildId, 300).map((r) => ({ phrase: r.phrase, count: r.count })),
        emojis: (sqlite.prepare(
          "SELECT * FROM pacchi_emojis WHERE guild_id = ? ORDER BY count DESC, last_seen_at DESC LIMIT 500",
        ).all(guildId) as PacchiEmojiRow[]).map((r) => ({
          key: r.emoji_key,
          kind: r.kind,
          display: r.display,
          count: r.count,
        })),
        settings: {
          enabled: settings.enabled,
          defaultTalkEnabled: settings.defaultTalkEnabled,
          defaultLearnEnabled: settings.defaultLearnEnabled,
          speakRate: settings.speakRate,
          cooldownSeconds: settings.cooldownSeconds,
        },
        ngWords: ngRows.map((r) => r.word),
      };
    },

    importData(guildId: string, data: PacchiExportData): { words: number; phrases: number; emojis: number } {
      const now = nowIso();
      const tx = sqlite.transaction(() => {
        for (const word of data.words) {
          sqlite.prepare(`
            INSERT INTO pacchi_words (id, guild_id, word, count, last_seen_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(guild_id, word) DO UPDATE SET
              count = count + excluded.count,
              last_seen_at = excluded.last_seen_at
          `).run(ulid(), guildId, word.word, Math.max(1, word.count), now, now);
        }
        for (const phrase of data.phrases) {
          sqlite.prepare(`
            INSERT INTO pacchi_phrases (id, guild_id, phrase, count, last_seen_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(guild_id, phrase) DO UPDATE SET
              count = count + excluded.count,
              last_seen_at = excluded.last_seen_at
          `).run(ulid(), guildId, phrase.phrase, Math.max(1, phrase.count), now, now);
        }
        for (const emoji of data.emojis) {
          sqlite.prepare(`
            INSERT INTO pacchi_emojis (id, guild_id, emoji_key, kind, display, count, last_seen_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(guild_id, emoji_key) DO UPDATE SET
              count = count + excluded.count,
              display = excluded.display,
              last_seen_at = excluded.last_seen_at
          `).run(ulid(), guildId, emoji.key, emoji.kind, emoji.display, Math.max(1, emoji.count), now, now);
        }
      });
      tx();
      return { words: data.words.length, phrases: data.phrases.length, emojis: data.emojis.length };
    },
  };
}

export type PacchiRepository = ReturnType<typeof createPacchiRepository>;
