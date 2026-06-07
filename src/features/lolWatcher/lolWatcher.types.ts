export type LolWatcherResult = "win" | "lose";

export type LolWatcherAccount = {
  accountKey: string;
  accountKeyNorm: string;
  userId: string | null;
  channelId: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type LolWatcherApiAccount = {
  puuid: string;
  gameName: string;
  tagLine: string;
  displayName: string;
};

export type LolWatcherLiveGame = {
  gameId: string;
  queueName: string;
  championName: string;
  championImageUrl: string | null;
  startedAt: string;
};

export type LolWatcherCompletedGame = {
  gameId: string;
  detailUrl: string | null;
  queueName: string;
  championName: string;
  championImageUrl: string | null;
  result: LolWatcherResult;
  aiScore: number | null;
  kills: number;
  deaths: number;
  assists: number;
  durationSeconds: number;
  killParticipationPercent: number;
  endedAt: string;
};

export type LolWatcherRiotState = {
  account: LolWatcherApiAccount;
  liveGame: LolWatcherLiveGame | null;
  completedGames: LolWatcherCompletedGame[];
};

export type LolWatcherFetchResult =
  | { ok: true; state: LolWatcherRiotState }
  | { ok: false; error: string; httpStatus?: number };

export type LolWatcherDeepLolResult =
  | { ok: true; aiScore: number | null; detailUrl: string; templateName: string }
  | { ok: false; error: string; detailUrl: string | null; templateName: string; httpStatus?: number };

export type LolWatcherActiveStatus = "active" | "missing" | "stale" | "completed" | "error";

export type LolWatcherActiveGame = {
  accountKeyNorm: string;
  gameId: string;
  messageId: string | null;
  status: LolWatcherActiveStatus;
  startedAt: string | null;
  lastSeenAt: string;
  missingSince: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

export type LolWatcherNotificationType =
  | "edited_from_start"
  | "completed_without_start"
  | "completed_after_edit_failure";

export type LolWatcherNotificationStatus = "posted" | "edited" | "failed";

export type LolWatcherNotification = {
  accountKeyNorm: string;
  gameId: string;
  messageId: string | null;
  notificationType: LolWatcherNotificationType;
  status: LolWatcherNotificationStatus;
  errorMessage: string | null;
  deepLolStatus: "pending" | "enriched" | "not_found" | "failed";
  deepLolRetryCount: number;
  createdAt: string;
  updatedAt: string;
};

export type LolWatcherStatus = {
  key: string;
  value: string | null;
  updatedAt: string;
};

export type LolWatcherScanResult = {
  scannedAccounts: number;
  failedAccounts: number;
  startedGames: number;
  completedGames: number;
  staleGames: number;
  deepLolEnrichedGames: number;
  errors: string[];
};

export function normalizeLolWatcherAccountKey(accountKey: string): string {
  return accountKey.trim().toLowerCase();
}

export function parseRiotId(accountKey: string): { gameName: string; tagLine: string } | null {
  const trimmed = accountKey.trim();
  const index = trimmed.lastIndexOf("#");
  if (index <= 0 || index === trimmed.length - 1) return null;
  return {
    gameName: trimmed.slice(0, index),
    tagLine: trimmed.slice(index + 1),
  };
}
