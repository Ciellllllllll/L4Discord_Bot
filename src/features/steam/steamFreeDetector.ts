import type { SteamAppDetails, SteamFreeCandidate, SteamSearchItem } from "./steamFreeTypes.js";

const EXCLUDED_WORDS = ["demo", "playtest", "soundtrack", "サウンドトラック", "体験版"];

function centsToYen(value: number | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.round(value / 100);
}

function containsAny(text: string, words: string[]): boolean {
  const lower = text.toLowerCase();
  return words.some((word) => lower.includes(word.toLowerCase()));
}

function isExcluded(details: SteamAppDetails): boolean {
  if (details.type && details.type !== "game") return true;
  const bag = [details.name, ...(details.categories ?? []), ...(details.genres ?? [])].join(" ");
  if (containsAny(bag, EXCLUDED_WORDS)) return true;
  if (containsAny(bag, ["downloadable content", "dlc", "video"])) return true;
  return false;
}

export function buildSteamStateKey(candidate: Pick<SteamFreeCandidate, "appid" | "detectedType" | "finalPrice" | "discountPercent">): string {
  return `${candidate.appid}:${candidate.detectedType}:${candidate.finalPrice ?? "null"}:${candidate.discountPercent ?? "null"}`;
}

export function detectSteamFreeCandidates(
  searchItems: SteamSearchItem[],
  detailsByAppid: Map<string, SteamAppDetails>,
): SteamFreeCandidate[] {
  const candidates: SteamFreeCandidate[] = [];
  for (const item of searchItems) {
    const details = detailsByAppid.get(item.appid);
    if (!details || isExcluded(details)) continue;
    const po = details.priceOverview;
    const finalPrice = centsToYen(po?.final) ?? item.finalPrice;
    const originalPrice = centsToYen(po?.initial) ?? item.originalPrice;
    const discountPercent = po?.discountPercent ?? item.discountPercent;
    const rawPriceText = item.rawPriceText.toLowerCase();
    const htmlLooksFree = finalPrice === 0 || /free|無料|0/.test(rawPriceText);
    const htmlLooksFreeWeekend = /weekend|週末|期間|play for free|無料プレイ/i.test(item.rawPriceText);

    if (finalPrice === null && discountPercent === null && details.isFree !== true) continue;

    if (finalPrice === 0 && discountPercent === 100) {
      candidates.push({
        appid: item.appid,
        name: details.name || item.name,
        detectedType: "giveaway_or_100_percent_off",
        originalPrice,
        finalPrice,
        discountPercent,
        storeUrl: item.storeUrl,
        imageUrl: details.headerImage ?? details.capsuleImage ?? null,
        source: "steam_search_appdetails",
        confidence: "high",
      });
      continue;
    }

    if (finalPrice === 0 && htmlLooksFree && originalPrice !== null && originalPrice > 0) {
      candidates.push({
        appid: item.appid,
        name: details.name || item.name,
        detectedType: "giveaway_or_100_percent_off",
        originalPrice,
        finalPrice,
        discountPercent,
        storeUrl: item.storeUrl,
        imageUrl: details.headerImage ?? details.capsuleImage ?? null,
        source: "steam_search_appdetails",
        confidence: "medium",
      });
      continue;
    }

    if (htmlLooksFreeWeekend && htmlLooksFree) {
      candidates.push({
        appid: item.appid,
        name: details.name || item.name,
        detectedType: "free_weekend_or_limited_trial",
        originalPrice,
        finalPrice,
        discountPercent,
        storeUrl: item.storeUrl,
        imageUrl: details.headerImage ?? details.capsuleImage ?? null,
        source: "steam_search_appdetails",
        confidence: "low",
      });
      continue;
    }

    if (details.isFree === true && (discountPercent !== null || /special|free|無料/i.test(item.rawPriceText))) {
      candidates.push({
        appid: item.appid,
        name: details.name || item.name,
        detectedType: "free_to_play",
        originalPrice,
        finalPrice: 0,
        discountPercent,
        storeUrl: item.storeUrl,
        imageUrl: details.headerImage ?? details.capsuleImage ?? null,
        source: "steam_search_appdetails",
        confidence: "low",
      });
    }
  }
  return candidates;
}
