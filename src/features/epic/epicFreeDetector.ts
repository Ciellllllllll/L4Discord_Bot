import type { EpicFreeCandidate, EpicFreeDetectedType, EpicPromotionWindow, EpicStoreOffer } from "./epicFreeTypes.js";

const EXCLUDED_WORDS = [
  "dlc",
  "add-on",
  "addon",
  "demo",
  "trial",
  "playtest",
  "soundtrack",
  "in-game item",
  "currency",
  "bundle",
  "追加コンテンツ",
  "体験版",
  "サウンドトラック",
];

function dateMs(value: string | null): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function isWithin(window: EpicPromotionWindow, nowMs: number): boolean {
  const start = dateMs(window.startDate);
  const end = dateMs(window.endDate);
  return start !== null && end !== null && start <= nowMs && nowMs < end;
}

function isUpcoming(window: EpicPromotionWindow, nowMs: number): boolean {
  const start = dateMs(window.startDate);
  const end = dateMs(window.endDate);
  return start !== null && end !== null && nowMs < start;
}

function isExcludedOffer(offer: EpicStoreOffer): boolean {
  const text = [offer.title, offer.description ?? "", offer.offerType ?? "", ...offer.categories].join(" ").toLowerCase();
  return EXCLUDED_WORDS.some((word) => text.includes(word.toLowerCase()));
}

function pickCurrentPromotion(offer: EpicStoreOffer, nowMs: number): EpicPromotionWindow | null {
  return offer.currentPromotions.find((promo) => isWithin(promo, nowMs)) ?? null;
}

function pickUpcomingPromotion(offer: EpicStoreOffer, nowMs: number): EpicPromotionWindow | null {
  return offer.upcomingPromotions.find((promo) => isUpcoming(promo, nowMs)) ?? null;
}

export function buildEpicDedupeKey(input: {
  offerId: string | null;
  namespace: string | null;
  title: string;
  productSlug: string | null;
  startDate: string | null;
  endDate: string | null;
  detectedType: EpicFreeDetectedType;
}): string {
  const idPart = input.offerId ? `${input.offerId}:${input.namespace ?? ""}` : `${input.title}:${input.productSlug ?? ""}`;
  return `${idPart}:${input.startDate ?? ""}:${input.endDate ?? ""}:${input.detectedType}`;
}

function toCandidate(
  offer: EpicStoreOffer,
  detectedType: EpicFreeDetectedType,
  promo: EpicPromotionWindow | null,
  confidence: EpicFreeCandidate["confidence"],
): EpicFreeCandidate {
  const startDate = promo?.startDate ?? null;
  const endDate = promo?.endDate ?? null;
  return {
    offerId: offer.offerId,
    namespace: offer.namespace,
    title: offer.title,
    description: offer.description,
    detectedType,
    productSlug: offer.productSlug,
    url: offer.url,
    imageUrl: offer.imageUrl,
    originalPrice: offer.originalPrice,
    discountPrice: offer.discountPrice,
    currencyCode: offer.currencyCode,
    startDate,
    endDate,
    dedupeKey: buildEpicDedupeKey({
      offerId: offer.offerId,
      namespace: offer.namespace,
      title: offer.title,
      productSlug: offer.productSlug,
      startDate,
      endDate,
      detectedType,
    }),
    confidence,
  };
}

export function detectEpicFreeCandidates(offers: EpicStoreOffer[], now = new Date()): EpicFreeCandidate[] {
  const nowMs = now.getTime();
  const candidates: EpicFreeCandidate[] = [];
  for (const offer of offers) {
    if (isExcludedOffer(offer)) {
      continue;
    }
    const current = pickCurrentPromotion(offer, nowMs);
    const upcoming = pickUpcomingPromotion(offer, nowMs);
    const original = offer.originalPrice;
    const discount = offer.discountPrice;
    const hasPrice = original !== null && discount !== null;
    const limitedFree = Boolean(current && hasPrice && discount === 0 && (original > 0 || current.discountPercentage === 0));
    if (limitedFree) {
      candidates.push(toCandidate(offer, "current_free_game", current, "high"));
      continue;
    }
    const upcomingFree = Boolean(upcoming && original !== null && original > 0 && upcoming.discountPercentage === 0);
    if (upcomingFree) {
      candidates.push(toCandidate(offer, "upcoming_free_game", upcoming, "medium"));
      continue;
    }
    if (hasPrice && original === 0 && discount === 0) {
      candidates.push(toCandidate(offer, "always_free", current ?? upcoming, "low"));
    }
  }
  return candidates;
}
