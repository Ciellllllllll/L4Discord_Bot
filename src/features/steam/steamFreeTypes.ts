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
  shortDescription?: string;
  priceOverview?: {
    currency?: string;
    initial?: number;
    final?: number;
    discountPercent?: number;
    discountExpiration?: number;
    initialFormatted?: string;
    finalFormatted?: string;
  };
  categories?: string[];
  genres?: string[];
};
