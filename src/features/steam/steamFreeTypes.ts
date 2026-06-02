export type SteamFreeDetectedType =
  | "giveaway_or_100_percent_off"
  | "free_weekend_or_limited_trial"
  | "free_to_play";

export type SteamSearchItem = {
  appid: string;
  name: string;
  storeUrl: string;
  discountPercent: number | null;
  finalPrice: number | null;
  originalPrice: number | null;
  rawPriceText: string;
};

export type SteamAppDetails = {
  appid: string;
  name: string;
  type?: string;
  isFree?: boolean;
  headerImage?: string;
  capsuleImage?: string;
  priceOverview?: {
    currency?: string;
    initial?: number;
    final?: number;
    discountPercent?: number;
    initialFormatted?: string;
    finalFormatted?: string;
  };
  categories?: string[];
  genres?: string[];
};

export type SteamFreeCandidate = {
  appid: string;
  name: string;
  detectedType: SteamFreeDetectedType;
  originalPrice: number | null;
  finalPrice: number | null;
  discountPercent: number | null;
  storeUrl: string;
  imageUrl: string | null;
  source: "steam_search_appdetails";
  confidence: "high" | "medium" | "low";
};

export type SteamNotifyChannel = {
  guildId: string;
  channelId: string;
  enabled: boolean;
};

export type SteamWatcherStatus = {
  lastScanAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastDetectedCount: number;
};

export type SteamFreeStoredItem = SteamFreeCandidate & {
  stateKey: string;
  firstDetectedAt: string;
  lastSeenAt: string;
  notifiedAt: string | null;
  active: boolean;
};
