import type pino from "pino";
import type { EpicPromotionWindow, EpicStoreOffer } from "./epicFreeTypes.js";

const FREE_GAMES_URL =
  "https://store-site-backend-static-ipv4.ak.epicgames.com/freeGamesPromotions?locale=ja-JP&country=JP&allowCountries=JP";
const USER_AGENT = "L4DiscordBot/0.1 EpicFreeWatcher (+https://store.epicgames.com/)";
const REQUEST_TIMEOUT_MS = 12_000;
const DEFAULT_FREE_GAMES_PAGE = "https://store.epicgames.com/ja/free-games";

type FetchOptions = {
  signal?: AbortSignal;
};

class EpicHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
    readonly bodyPreview: string,
  ) {
    super(message);
    this.name = "EpicHttpError";
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function httpErrorLogFields(err: unknown): Record<string, unknown> {
  if (err instanceof EpicHttpError) {
    return {
      err: err.message,
      status: err.status,
      url: err.url,
      bodyPreview: err.bodyPreview,
    };
  }
  return { err };
}

async function fetchJson<T>(url: string, opts: FetchOptions = {}): Promise<T> {
  const res = await fetch(url, {
    signal: opts.signal,
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new EpicHttpError(`Epic request failed: ${res.status}`, res.status, url, text.slice(0, 300));
  }
  return JSON.parse(text) as T;
}

async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

function normalizeSlug(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.replace(/^\/+/, "").replace(/\/home$/i, "").trim();
  return trimmed || null;
}

function buildStoreUrl(productSlug: string | null, mappingPageSlug: string | null, urlSlug: string | null): string {
  const slug = normalizeSlug(productSlug) ?? normalizeSlug(mappingPageSlug) ?? normalizeSlug(urlSlug);
  return slug ? `https://store.epicgames.com/ja/p/${encodeURIComponent(slug)}` : DEFAULT_FREE_GAMES_PAGE;
}

function categoryPaths(value: unknown): string[] {
  return asArray(value)
    .map((item) => asRecord(item))
    .map((item) => asString(item?.path) ?? asString(item?.name))
    .filter((v): v is string => v !== null);
}

function promotionalWindows(value: unknown): EpicPromotionWindow[] {
  return asArray(value).flatMap((group) => {
    const record = asRecord(group);
    return asArray(record?.promotionalOffers).map((offer): EpicPromotionWindow => {
      const o = asRecord(offer);
      const discountSetting = asRecord(o?.discountSetting);
      return {
        startDate: asString(o?.startDate),
        endDate: asString(o?.endDate),
        discountPercentage: asNumber(discountSetting?.discountPercentage),
      };
    });
  });
}

function selectImage(value: unknown): string | null {
  const images = asArray(value)
    .map((item) => asRecord(item))
    .map((item) => ({
      type: asString(item?.type),
      url: asString(item?.url),
    }))
    .filter((item): item is { type: string | null; url: string } => item.url !== null);
  const preferred = ["OfferImageWide", "DieselStoreFrontWide", "Thumbnail"];
  for (const type of preferred) {
    const found = images.find((item) => item.type === type);
    if (found) return found.url;
  }
  return images[0]?.url ?? null;
}

function firstMappingPageSlug(value: unknown): string | null {
  const catalogNs = asRecord(value);
  const mappings = asArray(catalogNs?.mappings);
  const first = asRecord(mappings[0]);
  return asString(first?.pageSlug);
}

function normalizeOffer(value: unknown): EpicStoreOffer | null {
  const item = asRecord(value);
  if (!item) return null;
  const title = asString(item.title);
  if (!title) return null;
  const price = asRecord(item.price);
  const totalPrice = asRecord(price?.totalPrice);
  const promotions = asRecord(item.promotions);
  const productSlug = asString(item.productSlug);
  const urlSlug = asString(item.urlSlug);
  const mappingPageSlug = firstMappingPageSlug(item.catalogNs);
  const seller = asRecord(item.seller);
  return {
    offerId: asString(item.id),
    namespace: asString(item.namespace),
    title,
    description: asString(item.description),
    effectiveDate: asString(item.effectiveDate),
    offerType: asString(item.offerType),
    categories: categoryPaths(item.categories),
    originalPrice: asNumber(totalPrice?.originalPrice),
    discountPrice: asNumber(totalPrice?.discountPrice),
    currencyCode: asString(totalPrice?.currencyCode),
    currentPromotions: promotionalWindows(promotions?.promotionalOffers),
    upcomingPromotions: promotionalWindows(promotions?.upcomingPromotionalOffers),
    imageUrl: selectImage(item.keyImages),
    productSlug,
    urlSlug,
    mappingPageSlug,
    sellerName: asString(seller?.name),
    url: buildStoreUrl(productSlug, mappingPageSlug, urlSlug),
  };
}

function extractElements(json: unknown): unknown[] {
  const root = asRecord(json);
  const data = asRecord(root?.data);
  const catalog = asRecord(data?.Catalog);
  const searchStore = asRecord(catalog?.searchStore);
  return asArray(searchStore?.elements);
}

export class EpicStoreClient {
  constructor(private readonly log: pino.Logger) {}

  async fetchFreePromotions(): Promise<EpicStoreOffer[]> {
    try {
      const json = await withTimeout((signal) => fetchJson<unknown>(FREE_GAMES_URL, { signal }));
      return extractElements(json).map(normalizeOffer).filter((v): v is EpicStoreOffer => v !== null);
    } catch (err) {
      this.log.warn(httpErrorLogFields(err), "epic free promotions fetch failed");
      return [];
    }
  }
}
