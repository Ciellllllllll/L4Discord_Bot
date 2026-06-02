import type { CheapSharkDeal, SteamDealCandidate } from "./cheapSharkTypes.js";

export function detectSteamDeal(deal: CheapSharkDeal | null): SteamDealCandidate {
  if (!deal || !deal.dealId || !deal.steamAppId) {
    return { detectedType: "excluded_invalid", deal, dedupeKey: null };
  }
  if (deal.normalPrice === 0) {
    return { detectedType: "excluded_always_free", deal, dedupeKey: null };
  }
  if (deal.salePrice === 0 && deal.normalPrice > 0 && deal.savings >= 99.9) {
    return {
      detectedType: "steam_limited_free",
      deal,
      dedupeKey: `cheapshark_free:${deal.dealId}`,
    };
  }
  if (deal.salePrice > 0 && deal.normalPrice > deal.salePrice && deal.savings > 0) {
    return {
      detectedType: "steam_discount",
      deal,
      dedupeKey: `cheapshark_discount:${deal.steamAppId}:${deal.dealId}:${deal.salePrice}:${deal.normalPrice}:${deal.savings}:${deal.lastChange ?? "null"}`,
    };
  }
  return { detectedType: "excluded_invalid", deal, dedupeKey: null };
}
