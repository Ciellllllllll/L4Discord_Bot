export type KuromojiToken = {
  surface: string;
  pos: [string, string, string, string];
  cType: string;
  cForm: string;
  lemma: string;
  reading: string;
  pronunciation: string;
  isKnown: boolean;
};

export type SenryuCandidate = {
  kamigo: string;
  nakashichi: string;
  shimogo: string;
  formatted: string;
};

export type SenryuRecord = {
  id?: string;
  guildId: string;
  channelId: string;
  messageId: string;
  authorId: string;
  kamigo: string;
  nakashichi: string;
  shimogo: string;
  formatted: string;
  sourceContent: string;
  spoiler: boolean;
  detectedAt: string;
};

export type SavedSenryuRecord = SenryuRecord & { id: string };
