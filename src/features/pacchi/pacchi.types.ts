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
  settings: {
    enabled: boolean;
    defaultTalkEnabled: boolean;
    defaultLearnEnabled: boolean;
    speakRate: PacchiRate;
    cooldownSeconds: number;
  } | null;
  ngWords: string[];
};
