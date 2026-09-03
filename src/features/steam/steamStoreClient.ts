import Bottleneck from "bottleneck";
import { load, type CheerioAPI } from "cheerio";
import type { SteamAppDetails, SteamSearchItem } from "./steamFreeTypes.js";

const SEARCH_URL = "https://store.steampowered.com/search/?hwtype=0&maxprice=free&category1=998&specials=1&ndl=1&cc=jp&l=japanese";
const APPDETAILS_URL = "https://store.steampowered.com/api/appdetails";
const USER_AGENT = "L4DiscordBot/0.1 SteamFreeWatcher (+https://store.steampowered.com/)";
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_SEARCH_ITEMS = 90;
const SINGLE_APPDETAILS_CONCURRENCY = 3;
const SINGLE_APPDETAILS_DELAY_MS = 300;
const MAX_STEAM_PAGE_REDIRECTS = 5;
const STEAM_HTML_HEADERS = {
  "User-Agent": USER_AGENT,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "ja-JP,ja;q=0.9,en-US;q=0.7,en;q=0.6",
  "Cache-Control": "no-cache",
  Referer: "https://store.steampowered.com/",
} as const;
const steamSearchLimiter = new Bottleneck({
  maxConcurrent: 1,
  minTime: 1_000,
});
const steamPageLimiter = new Bottleneck({
  maxConcurrent: 1,
  minTime: 1_000,
});
const steamAppDetailsLimiter = new Bottleneck({
  maxConcurrent: SINGLE_APPDETAILS_CONCURRENCY,
  minTime: SINGLE_APPDETAILS_DELAY_MS,
});

export type SteamStoreFetchOptions = {
  signal?: AbortSignal;
  fetcher?: SteamFetchLike;
};

export type SteamFetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type SteamPagePrice =
  | { kind: "paid"; usd: number }
  | { kind: "free" }
  | { kind: "unknown" };

export type SteamPageRating = {
  label?: string;
  percent?: number;
  reviewCount?: number;
};

export type SteamPagePreview = {
  canonicalUrl: string;
  appid?: string;
  title: string;
  body: string;
  price: SteamPagePrice;
  rating: SteamPageRating;
  imageUrl?: string;
};

type LoggerLike = {
  warn: (obj: unknown, message?: string) => void;
};

class SteamHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
    readonly bodyPreview: string,
  ) {
    super(message);
    this.name = "SteamHttpError";
  }
}

class SteamSearchUnavailableError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
    readonly bodyPreview: string,
  ) {
    super(message);
    this.name = "SteamSearchUnavailableError";
  }
}

type AppDetailsResponse = Record<
  string,
  {
    success?: boolean;
    data?: {
      name?: unknown;
      type?: unknown;
      is_free?: unknown;
      header_image?: unknown;
      capsule_image?: unknown;
      short_description?: unknown;
      price_overview?: {
        currency?: unknown;
        initial?: unknown;
        final?: unknown;
        discount_percent?: unknown;
        discount_expiration?: unknown;
        initial_formatted?: unknown;
        final_formatted?: unknown;
      };
      categories?: Array<{ description?: unknown }>;
      genres?: Array<{ description?: unknown }>;
    };
  }
>;

function normalizeAppid(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return /^\d+$/.test(trimmed) ? trimmed : null;
}

function parsePriceYen(raw: string): number | null {
  const normalized = raw.replace(/[,￥¥\s]/g, "");
  const match = normalized.match(/(\d+)/);
  if (!match) return /無料|free/i.test(raw) ? 0 : null;
  return Number(match[1]);
}

function normalizedText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function isOfficialSteamHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^www\./, "");
  return normalized === "steampowered.com"
    || normalized.endsWith(".steampowered.com")
    || normalized === "steamcommunity.com"
    || normalized.endsWith(".steamcommunity.com");
}

export function canonicalSteamUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return null;
    if (!isOfficialSteamHost(url.hostname)) return null;
    url.hostname = url.hostname.toLowerCase();
    url.port = "";
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (key.toLowerCase().startsWith("utm_") || ["cc", "l", "ref", "snr", "clickthrough"].includes(key.toLowerCase())) {
        url.searchParams.delete(key);
      }
    }
    url.searchParams.sort();
    const path = url.pathname.replace(/\/+$/, "");
    url.pathname = `${path || ""}/`;
    return url.toString();
  } catch {
    return null;
  }
}

function parseUsdPrice(raw: string): SteamPagePrice {
  const normalized = normalizedText(raw);
  if (!normalized) return { kind: "unknown" };
  if (/free\s+to\s+play|free\s+access|^free$|無料/i.test(normalized)) {
    return { kind: "free" };
  }
  const matches = [...normalized.matchAll(/\$\s*([\d,]+(?:\.\d{1,2})?)/g)];
  const last = matches.at(-1)?.[1];
  if (!last) return { kind: "unknown" };
  const usd = Number(last.replace(/,/g, ""));
  if (usd === 0) return { kind: "free" };
  return Number.isFinite(usd) ? { kind: "paid", usd } : { kind: "unknown" };
}

function parseSteamRating(raw: string, label: string): SteamPageRating {
  const percentValue = raw.match(/(\d{1,3})\s*%/);
  const reviewCountValue = raw.match(/(?:of\s+the\s+|based\s+on\s+)([\d,]+)\s+user\s+reviews/i);
  const percent = percentValue ? Number(percentValue[1]) : undefined;
  const reviewCount = reviewCountValue ? Number(reviewCountValue[1]!.replace(/,/g, "")) : undefined;
  return {
    ...(label ? { label } : {}),
    ...(Number.isFinite(percent) ? { percent } : {}),
    ...(Number.isFinite(reviewCount) ? { reviewCount } : {}),
  };
}

function safeHttpsUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function parseSteamPagePreviewHtml(html: string, canonicalUrl: string): SteamPagePreview {
  const $ = load(html);
  const appid = normalizeAppid(canonicalUrl.match(/\/app\/(\d+)/i)?.[1]) ?? undefined;
  const title = normalizedText(
    $("#appHubAppName").first().text()
      || $("meta[property='og:title']").attr("content")
      || $("title").first().text(),
  ).replace(/\s+on\s+Steam$/i, "");
  const description = $("#game_area_description").first().clone();
  description.find("h1, h2, h3").remove();
  const body = normalizedText($(".game_description_snippet").first().text())
    || normalizedText(description.text())
    || normalizedText($("meta[property='og:description']").attr("content") ?? "")
    || normalizedText($("meta[name='description']").attr("content") ?? "")
    || "";
  const priceCandidates = [
    $(".discount_final_price").first().text(),
    $(".game_purchase_price").first().text(),
    $(".game_area_purchase_game .game_purchase_price").first().text(),
  ].map(normalizedText).filter(Boolean);
  const price = parseUsdPrice(priceCandidates[0] ?? "");
  const reviewRow = $(".user_reviews_summary_row").first();
  const ratingTooltip = reviewRow.attr("data-tooltip-html") ?? normalizedText(reviewRow.text());
  const ratingLabel = normalizedText(reviewRow.find(".game_review_summary").first().text());
  const imageUrl = safeHttpsUrl($("meta[property='og:image']").attr("content"));
  return {
    canonicalUrl,
    ...(appid ? { appid } : {}),
    title: title || "Steamページ",
    body,
    price,
    rating: parseSteamRating(ratingTooltip, ratingLabel),
    ...(imageUrl ? { imageUrl } : {}),
  };
}

function pageRequestUrl(canonicalUrl: string): string {
  const url = new URL(canonicalUrl);
  if (url.hostname.toLowerCase().endsWith("steampowered.com")) {
    url.searchParams.set("cc", "us");
    url.searchParams.set("l", "english");
  }
  return url.toString();
}

function parseSearchItem($: CheerioAPI, row: Parameters<CheerioAPI>[0]): SteamSearchItem | null {
  const $row = $(row);
  const href = $row.attr("href") ?? "";
  const appid = normalizeAppid($row.attr("data-ds-appid")) ?? normalizeAppid(href.match(/\/app\/(\d+)/)?.[1]);
  if (!appid) return null;
  const name = normalizedText($row.find(".title").first().text());
  if (!name) return null;
  const discountBlock = $row.find(".discount_block").first();
  const discountRaw = normalizedText($row.find(".discount_pct").first().text() || $row.find(".search_discount").first().text());
  const dataDiscount = Number(discountBlock.attr("data-discount") ?? NaN);
  const discountPercent = Number.isFinite(dataDiscount)
    ? dataDiscount
    : Number(discountRaw.match(/-?(\d+)%/)?.[1] ?? NaN);
  const priceBlock = normalizedText(
    $row.find(".search_price_discount_combined").first().text() || $row.find(".search_price").first().text(),
  );
  const discountLabel = normalizedText(discountBlock.attr("aria-label") ?? "");
  if (!priceBlock && !discountRaw && !discountLabel && !Number.isFinite(dataDiscount)) return null;
  const originalPriceBlock = normalizedText($row.find(".discount_original_price").first().text());
  const finalPriceBlock = normalizedText($row.find(".discount_final_price").first().text());
  const priceNumbers = [...priceBlock.matchAll(/[¥￥]\s*([\d,]+)/g)].map((m) => Number(m[1]!.replace(/,/g, "")));
  const hasFreePriceMarker = /free|無料/i.test(priceBlock) || /free|無料/i.test(discountLabel);
  const finalPrice = parsePriceYen(finalPriceBlock)
    ?? (hasFreePriceMarker ? 0 : priceNumbers.length > 1 ? priceNumbers[priceNumbers.length - 1]! : parsePriceYen(priceBlock));
  const originalPrice = parsePriceYen(originalPriceBlock)
    ?? (priceNumbers.length > 1
      ? priceNumbers[0]!
      : hasFreePriceMarker && priceNumbers.length > 0
        ? priceNumbers[0]!
        : null);
  return {
    appid,
    name,
    storeUrl: (href || `https://store.steampowered.com/app/${appid}/`).split("?")[0] ?? href,
    discountPercent: Number.isFinite(discountPercent) ? discountPercent : null,
    finalPrice,
    originalPrice,
    rawPriceText: priceBlock || discountLabel,
  };
}

async function fetchText(url: string, opts: SteamStoreFetchOptions = {}): Promise<string> {
  const res = await (opts.fetcher ?? fetch)(url, {
    signal: opts.signal,
    headers: STEAM_HTML_HEADERS,
  });
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 300);
    throw new SteamHttpError(`Steam request failed: ${res.status}`, res.status, url, body);
  }
  return await res.text();
}

async function fetchSteamPageText(url: string, opts: SteamStoreFetchOptions = {}): Promise<string> {
  const fetcher = opts.fetcher ?? fetch;
  let currentUrl = url;

  for (let redirectCount = 0; redirectCount <= MAX_STEAM_PAGE_REDIRECTS; redirectCount += 1) {
    const res = await fetcher(currentUrl, {
      signal: opts.signal,
      redirect: "manual",
      headers: STEAM_HTML_HEADERS,
    });

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      if (redirectCount === MAX_STEAM_PAGE_REDIRECTS) {
        throw new Error("Steam page redirect limit exceeded");
      }
      const location = res.headers.get("location");
      const redirectUrl = location ? new URL(location, currentUrl).toString() : null;
      const canonicalRedirectUrl = redirectUrl ? canonicalSteamUrl(redirectUrl) : null;
      if (!canonicalRedirectUrl) {
        throw new Error("Steam page redirect target must be an HTTPS URL on an official Steam domain");
      }
      currentUrl = pageRequestUrl(canonicalRedirectUrl);
      continue;
    }

    const finalUrl = res.url || currentUrl;
    if (!canonicalSteamUrl(finalUrl)) {
      throw new Error("Steam page final URL must be an HTTPS URL on an official Steam domain");
    }
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 300);
      throw new SteamHttpError(`Steam request failed: ${res.status}`, res.status, currentUrl, body);
    }
    return await res.text();
  }

  throw new Error("Steam page redirect limit exceeded");
}

async function fetchJson<T>(url: string, opts: SteamStoreFetchOptions = {}): Promise<T> {
  const res = await (opts.fetcher ?? fetch)(url, {
    signal: opts.signal,
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new SteamHttpError(`Steam API request failed: ${res.status}`, res.status, url, text.slice(0, 300));
  }
  return JSON.parse(text) as T;
}

async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, externalSignal?: AbortSignal): Promise<T> {
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return fn(externalSignal ? AbortSignal.any([timeoutSignal, externalSignal]) : timeoutSignal);
}

function normalizeDetails(appid: string, raw: AppDetailsResponse[string]): SteamAppDetails | null {
  if (!raw?.success || !raw.data) return null;
  const d = raw.data;
  const name = typeof d.name === "string" ? d.name : "";
  if (!name) return null;
  const po = d.price_overview;
  return {
    appid,
    name,
    type: typeof d.type === "string" ? d.type : undefined,
    isFree: typeof d.is_free === "boolean" ? d.is_free : undefined,
    headerImage: typeof d.header_image === "string" ? d.header_image : undefined,
    capsuleImage: typeof d.capsule_image === "string" ? d.capsule_image : undefined,
    shortDescription: typeof d.short_description === "string" ? d.short_description : undefined,
    priceOverview: po
      ? {
          currency: typeof po.currency === "string" ? po.currency : undefined,
          initial: typeof po.initial === "number" ? po.initial : undefined,
          final: typeof po.final === "number" ? po.final : undefined,
          discountPercent: typeof po.discount_percent === "number" ? po.discount_percent : undefined,
          discountExpiration: typeof po.discount_expiration === "number" ? po.discount_expiration : undefined,
          initialFormatted: typeof po.initial_formatted === "string" ? po.initial_formatted : undefined,
          finalFormatted: typeof po.final_formatted === "string" ? po.final_formatted : undefined,
        }
      : undefined,
    categories: Array.isArray(d.categories)
      ? d.categories.map((c) => c.description).filter((v): v is string => typeof v === "string")
      : undefined,
    genres: Array.isArray(d.genres)
      ? d.genres.map((g) => g.description).filter((v): v is string => typeof v === "string")
      : undefined,
  };
}

function appdetailsSingleErrorLogFields(err: unknown): Record<string, unknown> {
  if (err instanceof SteamHttpError) {
    return {
      err: err.message,
      status: err.status,
      bodyPreview: err.bodyPreview,
    };
  }
  return { err };
}

function normalizeAppidList(appids: string[]): string[] {
  const out = new Set<string>();
  for (const appid of appids) {
    const normalized = normalizeAppid(appid);
    if (normalized) out.add(normalized);
  }
  return [...out].slice(0, MAX_SEARCH_ITEMS);
}

export class SteamStoreClient {
  constructor(private readonly log: LoggerLike = { warn: () => undefined }) {}

  async fetchPagePreview(url: string, options: SteamStoreFetchOptions = {}): Promise<SteamPagePreview> {
    const canonicalUrl = canonicalSteamUrl(url);
    if (!canonicalUrl) throw new Error("Steam page URL must be an HTTPS URL on an official Steam domain");
    const requestUrl = pageRequestUrl(canonicalUrl);
    const html = await steamPageLimiter.schedule(() => withTimeout(
      (signal) => fetchSteamPageText(requestUrl, { signal, fetcher: options.fetcher }),
      options.signal,
    ));
    return parseSteamPagePreviewHtml(html, canonicalUrl);
  }

  async fetchSearchItems(limit = MAX_SEARCH_ITEMS, options: SteamStoreFetchOptions = {}): Promise<SteamSearchItem[]> {
    const byAppid = new Map<string, SteamSearchItem>();
    try {
      const html = await steamSearchLimiter.schedule(() => withTimeout(
        (signal) => fetchText(SEARCH_URL, { signal, fetcher: options.fetcher }),
        options.signal,
      ));
      const $ = load(html);
      const rows = $("a.search_result_row").toArray();
      const parsedItems = rows.map((row) => parseSearchItem($, row)).filter((v): v is SteamSearchItem => v !== null);
      if (rows.length > 0 && parsedItems.length === 0) {
        throw new Error("Steam search page contained rows but no valid items");
      }
      for (const item of parsedItems) {
        if (!byAppid.has(item.appid)) byAppid.set(item.appid, item);
        if (byAppid.size >= limit) break;
      }
    } catch (err) {
      if (err instanceof SteamHttpError && err.status === 403) {
        throw new SteamSearchUnavailableError("Steam search source unavailable", err.status, err.url, err.bodyPreview);
      }
      this.log.warn({ err, url: SEARCH_URL }, "steam search fetch or parse failed");
      throw err;
    }
    return [...byAppid.values()].slice(0, limit);
  }

  async fetchAppDetails(appids: string[], options: SteamStoreFetchOptions = {}): Promise<Map<string, SteamAppDetails>> {
    const unique = normalizeAppidList(appids);
    const out = new Map<string, SteamAppDetails>();
    if (unique.length === 0) return out;

    const results = await Promise.allSettled(
      unique.map(async (appid) => {
        try {
          const url = `${APPDETAILS_URL}?appids=${encodeURIComponent(appid)}&cc=jp&l=japanese`;
          const json = await steamAppDetailsLimiter.schedule(() =>
            withTimeout((signal) => fetchJson<AppDetailsResponse>(url, { signal, fetcher: options.fetcher }), options.signal),
          );
          return { appid, details: normalizeDetails(appid, json[appid]) };
        } catch (err) {
          throw { appid, err };
        }
      }),
    );
    for (const result of results) {
      if (result.status === "fulfilled") {
        if (result.value.details) out.set(result.value.appid, result.value.details);
      } else {
        const reason = result.reason as { appid?: unknown; err?: unknown };
        const error = reason.err ?? result.reason;
        if (options.signal?.aborted) throw options.signal.reason ?? error;
        if (error instanceof SteamHttpError && error.status === 403) throw error;
        this.log.warn(
          { appid: reason.appid, ...appdetailsSingleErrorLogFields(error) },
          "steam appdetails single failed",
        );
      }
    }
    return out;
  }
}
