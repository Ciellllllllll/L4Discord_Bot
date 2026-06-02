export type CheapSharkDealRaw = {
  dealID?: unknown;
  storeID?: unknown;
  gameID?: unknown;
  title?: unknown;
  salePrice?: unknown;
  normalPrice?: unknown;
  savings?: unknown;
  isOnSale?: unknown;
  steamAppID?: unknown;
  thumb?: unknown;
  lastChange?: unknown;
};

export type CheapSharkDeal = {
  dealId: string;
  storeId: string | null;
  gameId: string | null;
  title: string;
  salePrice: number;
  normalPrice: number;
  savings: number;
  isOnSale: boolean;
  steamAppId: string;
  thumb: string | null;
  lastChange: number | null;
  cheapSharkUrl: string;
  steamUrl: string;
};

export type SteamDealDetectedType = "steam_limited_free" | "steam_discount" | "excluded_always_free" | "excluded_invalid";

export type SteamDealCandidate = {
  detectedType: SteamDealDetectedType;
  deal: CheapSharkDeal | null;
  dedupeKey: string | null;
};
