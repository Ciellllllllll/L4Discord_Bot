export type EpicFreeDetectedType = "current_free_game" | "upcoming_free_game" | "always_free" | "excluded";

export type EpicPromotionWindow = {
  startDate: string | null;
  endDate: string | null;
  discountPercentage: number | null;
};

export type EpicStoreOffer = {
  offerId: string | null;
  namespace: string | null;
  title: string;
  description: string | null;
  effectiveDate: string | null;
  offerType: string | null;
  categories: string[];
  originalPrice: number | null;
  discountPrice: number | null;
  currencyCode: string | null;
  currentPromotions: EpicPromotionWindow[];
  upcomingPromotions: EpicPromotionWindow[];
  imageUrl: string | null;
  productSlug: string | null;
  urlSlug: string | null;
  mappingPageSlug: string | null;
  sellerName: string | null;
  url: string;
};

export type EpicFreeCandidate = {
  offerId: string | null;
  namespace: string | null;
  title: string;
  description: string | null;
  detectedType: EpicFreeDetectedType;
  productSlug: string | null;
  url: string;
  imageUrl: string | null;
  originalPrice: number | null;
  discountPrice: number | null;
  currencyCode: string | null;
  startDate: string | null;
  endDate: string | null;
  dedupeKey: string;
  confidence: "high" | "medium" | "low";
};

export type EpicNotifyChannel = {
  guildId: string;
  channelId: string;
  enabled: boolean;
};

export type EpicWatcherStatus = {
  lastScanAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastDetectedCount: number;
};
