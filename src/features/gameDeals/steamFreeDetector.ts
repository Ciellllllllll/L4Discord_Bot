import type { CheapSharkDeal } from "./cheapSharkTypes.js";
import type { SteamAppCatalogChange, SteamPaidPriceHistory } from "./gameDealTypes.js";
import type { SteamAppDetails, SteamSearchItem } from "../steam/steamFreeTypes.js";

export type SteamFreeEvidence = {
  source: "steam_appdetails" | "steam_search" | "cheapshark" | "db_paid_history";
  normalPriceCents?: number | null;
  currentPriceCents?: number | null;
  discountPercent?: number | null;
  text?: string | null;
};

export type SteamFreeDetectionInput = {
  change: SteamAppCatalogChange;
  appdetails: SteamAppDetails | null;
  searchItem: SteamSearchItem | null;
  cheapSharkDeals: CheapSharkDeal[];
  paidHistory: SteamPaidPriceHistory | null;
};

export type SteamFreeDetectionResult =
  | {
      shouldNotify: true;
      appid: string;
      title: string;
      stateKey: string;
      steamUrl: string;
      imageUrl: string | null;
      normalPriceCents: number;
      currentPriceCents: number;
      discountPercent: number | null;
      evidence: SteamFreeEvidence[];
    }
  | {
      shouldNotify: false;
      reason: string;
      evidence: SteamFreeEvidence[];
    };

const EXCLUDED_TYPE_WORDS = ["dlc", "demo", "soundtrack", "software", "tool", "video", "hardware"];
const FREE_PLAY_TEXT = /free\s*weekend|play\s*for\s*free|無料プレイ|週末無料|フリーウィークエンド/i;
const F2P_TEXT = /free\s*to\s*play|基本プレイ無料|無料プレイ可/i;
const FREE_TO_KEEP_TEXT = /free\s*to\s*keep|keep\s*it\s*forever|永久にライブラリ|ライブラリに追加/i;

function centsFromYen(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value * 100)) : null;
}

function dollarsToCents(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value * 100)) : null;
}

function textIncludesAny(values: Array<string | undefined>, matcher: RegExp): boolean {
  return values.some((value) => !!value && matcher.test(value));
}

function normalizedWords(details: SteamAppDetails | null): string[] {
  return [
    details?.type,
    ...(details?.categories ?? []),
    ...(details?.genres ?? []),
  ]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.toLowerCase());
}

function appdetailsCurrentFree(details: SteamAppDetails | null): SteamFreeEvidence | null {
  const po = details?.priceOverview;
  if (!po) return null;
  const initial = typeof po.initial === "number" ? po.initial : null;
  const final = typeof po.final === "number" ? po.final : null;
  const discountPercent = typeof po.discountPercent === "number" ? po.discountPercent : null;
  if (initial !== null && initial > 0 && final === 0 && (discountPercent === null || discountPercent >= 100)) {
    return {
      source: "steam_appdetails",
      normalPriceCents: initial,
      currentPriceCents: 0,
      discountPercent,
      text: po.initialFormatted ?? null,
    };
  }
  if (initial !== null && initial > 0) {
    return {
      source: "steam_appdetails",
      normalPriceCents: initial,
      currentPriceCents: final,
      discountPercent,
      text: po.initialFormatted ?? null,
    };
  }
  return null;
}

function searchCurrentFree(item: SteamSearchItem | null): SteamFreeEvidence | null {
  if (!item) return null;
  const original = centsFromYen(item.originalPrice);
  const final = centsFromYen(item.finalPrice);
  if (original !== null && original > 0 && final === 0 && (item.discountPercent ?? 0) >= 100) {
    return {
      source: "steam_search",
      normalPriceCents: original,
      currentPriceCents: 0,
      discountPercent: item.discountPercent,
      text: item.rawPriceText,
    };
  }
  if (FREE_TO_KEEP_TEXT.test(item.rawPriceText) && original !== null && original > 0) {
    return {
      source: "steam_search",
      normalPriceCents: original,
      currentPriceCents: 0,
      discountPercent: item.discountPercent ?? 100,
      text: item.rawPriceText,
    };
  }
  return null;
}

export function cheapSharkPaidFreeEvidence(deals: CheapSharkDeal[]): SteamFreeEvidence | null {
  const matched = deals.find((deal) => deal.normalPrice > 0 && deal.salePrice === 0 && deal.savings >= 99.9);
  if (!matched) return null;
  return {
    source: "cheapshark",
    normalPriceCents: dollarsToCents(matched.normalPrice),
    currentPriceCents: 0,
    discountPercent: Math.round(matched.savings),
    text: matched.dealId,
  };
}

function dbPaidEvidence(history: SteamPaidPriceHistory | null): SteamFreeEvidence | null {
  if (!history || history.normalPriceCents === null || history.normalPriceCents <= 0) return null;
  return {
    source: "db_paid_history",
    normalPriceCents: history.normalPriceCents,
    currentPriceCents: null,
    discountPercent: null,
    text: history.source,
  };
}

function bestNormalPrice(evidence: SteamFreeEvidence[]): number | null {
  const values = evidence.map((item) => item.normalPriceCents).filter((value): value is number => typeof value === "number" && value > 0);
  return values.length > 0 ? Math.max(...values) : null;
}

function hasSteamPriceChange(change: SteamAppCatalogChange): boolean {
  return change.previousLastModified !== null || change.previousPriceChangeNumber !== null;
}

export function buildSteamFreeStateKey(change: Pick<SteamAppCatalogChange, "appid" | "priceChangeNumber" | "lastModified">): string {
  return `steam_free:${change.appid}:${change.priceChangeNumber ?? "none"}:${change.lastModified ?? "none"}`;
}

export function detectSteamFreeEvent(input: SteamFreeDetectionInput): SteamFreeDetectionResult {
  const { change, appdetails, searchItem } = input;
  const evidence = [
    appdetailsCurrentFree(appdetails),
    searchCurrentFree(searchItem),
    cheapSharkPaidFreeEvidence(input.cheapSharkDeals),
    dbPaidEvidence(input.paidHistory),
  ].filter((value): value is SteamFreeEvidence => value !== null);

  if (!hasSteamPriceChange(change)) return { shouldNotify: false, reason: "baseline_only", evidence };
  if (!appdetails && !searchItem) return { shouldNotify: false, reason: "missing_steam_evidence", evidence };

  const words = normalizedWords(appdetails);
  if (appdetails?.type && appdetails.type !== "game") return { shouldNotify: false, reason: "excluded_non_game_type", evidence };
  if (words.some((word) => EXCLUDED_TYPE_WORDS.some((excluded) => word.includes(excluded)))) {
    return { shouldNotify: false, reason: "excluded_non_game_content", evidence };
  }

  const textValues = [appdetails?.name, searchItem?.name, searchItem?.rawPriceText, ...(appdetails?.categories ?? []), ...(appdetails?.genres ?? [])];
  if (textIncludesAny(textValues, FREE_PLAY_TEXT)) return { shouldNotify: false, reason: "excluded_free_weekend_or_play_free", evidence };
  if (appdetails?.isFree === true && !evidence.some((item) => item.source === "db_paid_history")) {
    return { shouldNotify: false, reason: "excluded_always_free_without_paid_history", evidence };
  }
  if (textIncludesAny(textValues, F2P_TEXT) && !evidence.some((item) => item.source === "db_paid_history")) {
    return { shouldNotify: false, reason: "excluded_free_to_play", evidence };
  }

  const currentFreeEvidence = evidence.find((item) => item.currentPriceCents === 0 && item.source !== "db_paid_history");
  if (!currentFreeEvidence) return { shouldNotify: false, reason: "not_currently_free", evidence };
  const normalPrice = bestNormalPrice(evidence);
  if (normalPrice === null) return { shouldNotify: false, reason: "missing_paid_price_evidence", evidence };
  const hasPaidHistory = evidence.some((item) => item.source === "db_paid_history") || evidence.some((item) => item.normalPriceCents !== null && item.normalPriceCents !== undefined && item.normalPriceCents > 0);
  if (!hasPaidHistory) return { shouldNotify: false, reason: "missing_paid_history", evidence };

  return {
    shouldNotify: true,
    appid: change.appid,
    title: appdetails?.name || searchItem?.name || change.name || `Steam ${change.appid}`,
    stateKey: buildSteamFreeStateKey(change),
    steamUrl: `https://store.steampowered.com/app/${change.appid}/`,
    imageUrl: appdetails?.headerImage ?? appdetails?.capsuleImage ?? null,
    normalPriceCents: normalPrice,
    currentPriceCents: 0,
    discountPercent: currentFreeEvidence.discountPercent ?? 100,
    evidence,
  };
}
