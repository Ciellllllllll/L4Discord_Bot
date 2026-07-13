export type PacchiRate = "silent" | "low" | "normal" | "high" | "unlimited";

export type PacchiSettings = {
  guildId: string;
  enabled: boolean;
  defaultTalkEnabled: boolean;
  defaultLearnEnabled: boolean;
  speakRate: PacchiRate;
  cooldownSeconds: number;
  lastSpokeAt: string | null;
  lastLearnedAt: string | null;
};

export type PacchiChannelSettings = {
  guildId: string;
  channelId: string;
  talkEnabled: boolean;
  learnEnabled: boolean;
};

export type PacchiWordRow = {
  id: string;
  guild_id: string;
  word: string;
  count: number;
  last_seen_at: string;
  created_at: string;
};

export type PacchiPhraseRow = {
  id: string;
  guild_id: string;
  phrase: string;
  count: number;
  last_seen_at: string;
  created_at: string;
};

export type PacchiEmojiKind = "unicode" | "custom" | "sticker";

export type PacchiEmojiRow = {
  id: string;
  guild_id: string;
  emoji_key: string;
  kind: PacchiEmojiKind;
  display: string;
  count: number;
  last_seen_at: string;
  created_at: string;
};

export type PacchiLearnedEmoji = {
  key: string;
  kind: PacchiEmojiKind;
  display: string;
};

export type PacchiMemoryStats = {
  wordCount: number;
  phraseCount: number;
  emojiCount: number;
  sleepLogCount: number;
  dailyReportCount: number;
};

export type PacchiExportData = {
  version: 1;
  exportedAt: string;
  words: { word: string; count: number }[];
  phrases: { phrase: string; count: number }[];
  emojis: { key: string; kind: PacchiEmojiKind; display: string; count: number }[];
  lexicon?: PacchiLexiconExportEntry[];
  cooccurrences?: PacchiCooccurrenceExportEntry[];
  userDictionaryEntries?: PacchiUserDictionaryExportEntry[];
  sentencePatterns?: PacchiSentencePatternExportEntry[];
  settings: {
    enabled: boolean;
    defaultTalkEnabled: boolean;
    defaultLearnEnabled: boolean;
    speakRate: PacchiRate;
    cooldownSeconds: number;
  } | null;
  ngWords: string[];
};

export type PacchiLexiconInput = {
  surface: string;
  base: string;
  reading: string;
  pos: string[];
  isProperNoun: boolean;
  isOov: boolean;
  source: string;
};

export type PacchiLexiconExportEntry = PacchiLexiconInput & {
  count: number;
};

export type PacchiCooccurrenceExportEntry = {
  wordA: string;
  wordB: string;
  count: number;
};

export type PacchiUserDictionaryExportEntry = {
  surface: string;
  reading: string;
  reason: string;
  count: number;
};

export type PacchiLexiconRow = {
  surface: string;
  base: string;
  reading: string;
  pos_json: string;
  is_proper_noun: number;
  is_oov: number;
  count: number;
  last_seen_at: string;
};

export type PacchiSentencePatternInput = {
  surfacePattern: string;
  slots: string[];
  ending: string;
  sourceKind: string;
  safeLevel: number;
};

export type PacchiSentencePatternExportEntry = PacchiSentencePatternInput & {
  count: number;
};

export type PacchiSentencePatternRow = {
  surface_pattern: string;
  slots_json: string;
  ending: string;
  count: number;
  safe_level: number;
};

export type PacchiSenryuSubmissionInput = {
  guildId: string;
  channelId: string;
  messageId: string;
  authorId: string;
  kamigo: string;
  nakashichi: string;
  shimogo: string;
  formatted: string;
  sourceContent: string;
};
