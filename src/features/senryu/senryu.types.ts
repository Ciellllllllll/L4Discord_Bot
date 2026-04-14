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
    // `normalized` 文に対する kuromoji トークン列の半開区間（AI レビュー用）

  tokenSpan: { start: number; end: number };
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
