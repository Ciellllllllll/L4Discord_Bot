import type pino from "pino";
import type { SteamAppDetails, SteamSearchItem } from "./steamFreeTypes.js";

const SEARCH_URL = "https://store.steampowered.com/search/?maxprice=free&specials=1&cc=jp&l=japanese";
const APPDETAILS_URL = "https://store.steampowered.com/api/appdetails";
const USER_AGENT = "L4DiscordBot/0.1 SteamFreeWatcher (+https://store.steampowered.com/)";
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_SEARCH_ITEMS = 30;
const SINGLE_APPDETAILS_CONCURRENCY = 3;
const SINGLE_APPDETAILS_DELAY_MS = 300;

type FetchOptions = {
  signal?: AbortSignal;
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
      price_overview?: {
        currency?: unknown;
        initial?: unknown;
        final?: unknown;
        discount_percent?: unknown;
        initial_formatted?: unknown;
        final_formatted?: unknown;
      };
      categories?: Array<{ description?: unknown }>;
      genres?: Array<{ description?: unknown }>;
    };
  }
>;

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function stripTags(input: string): string {
  return decodeHtmlEntities(input.replace(/<[^>]+>/g, " "));
}

function attr(html: string, name: string): string | null {
  const re = new RegExp(`${name}=["']([^"']+)["']`, "i");
  return html.match(re)?.[1] ?? null;
}

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

function parseSearchItem(row: string): SteamSearchItem | null {
  const appid = normalizeAppid(attr(row, "data-ds-appid")) ?? normalizeAppid(row.match(/\/app\/(\d+)/)?.[1]);
  if (!appid) return null;
  const href = attr(row, "href") ?? `https://store.steampowered.com/app/${appid}/`;
  const titleHtml = row.match(/<span[^>]*class=["'][^"']*title[^"']*["'][^>]*>([\s\S]*?)<\/span>/i)?.[1];
  const name = stripTags(titleHtml ?? "");
  if (!name) return null;
  const discountRaw = stripTags(
    row.match(/<div[^>]*class=["'][^"']*search_discount[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? "",
  );
  const discountPercent = Number(discountRaw.match(/-?(\d+)%/)?.[1] ?? NaN);
  const priceBlock = stripTags(
    row.match(/<div[^>]*class=["'][^"']*search_price[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? "",
  );
  const priceNumbers = [...priceBlock.matchAll(/[¥￥]\s*([\d,]+)/g)].map((m) => Number(m[1]!.replace(/,/g, "")));
  return {
    appid,
    name,
    storeUrl: href.split("?")[0] ?? href,
    discountPercent: Number.isFinite(discountPercent) ? discountPercent : null,
    finalPrice: priceNumbers.length > 0 ? priceNumbers[priceNumbers.length - 1]! : parsePriceYen(priceBlock),
    originalPrice: priceNumbers.length > 1 ? priceNumbers[0]! : null,
    rawPriceText: priceBlock,
  };
}

async function fetchText(url: string, opts: FetchOptions = {}): Promise<string> {
  const res = await fetch(url, {
    signal: opts.signal,
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 300);
    throw new SteamHttpError(`Steam request failed: ${res.status}`, res.status, url, body);
  }
  return await res.text();
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
    throw new SteamHttpError(`Steam API request failed: ${res.status}`, res.status, url, text.slice(0, 300));
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
    priceOverview: po
      ? {
          currency: typeof po.currency === "string" ? po.currency : undefined,
          initial: typeof po.initial === "number" ? po.initial : undefined,
          final: typeof po.final === "number" ? po.final : undefined,
          discountPercent: typeof po.discount_percent === "number" ? po.discount_percent : undefined,
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

function httpErrorLogFields(err: unknown): Record<string, unknown> {
  if (err instanceof SteamHttpError) {
    return {
      err: err.message,
      status: err.status,
      url: err.url,
      bodyPreview: err.bodyPreview,
    };
  }
  return { err };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  constructor(private readonly log: pino.Logger) {}

  async fetchSearchItems(limit = MAX_SEARCH_ITEMS): Promise<SteamSearchItem[]> {
    try {
      const html = await withTimeout((signal) => fetchText(SEARCH_URL, { signal }));
      const rows = html.match(/<a\b[^>]*class=["'][^"']*search_result_row[^"']*["'][\s\S]*?<\/a>/gi) ?? [];
      return rows.map(parseSearchItem).filter((v): v is SteamSearchItem => v !== null).slice(0, limit);
    } catch (err) {
      this.log.warn({ err }, "steam search fetch or parse failed");
      return [];
    }
  }

  async fetchAppDetails(appids: string[]): Promise<Map<string, SteamAppDetails>> {
    const unique = normalizeAppidList(appids);
    const out = new Map<string, SteamAppDetails>();
    if (unique.length === 0) return out;
    let batchFailed = false;
    try {
      const url = `${APPDETAILS_URL}?appids=${encodeURIComponent(unique.join(","))}&cc=jp&l=japanese`;
      const json = await withTimeout((signal) => fetchJson<AppDetailsResponse>(url, { signal }));
      for (const appid of unique) {
        const normalized = normalizeDetails(appid, json[appid]);
        if (normalized) out.set(appid, normalized);
      }
      if (out.size > 0) return out;
    } catch (err) {
      batchFailed = true;
      this.log.warn({ ...httpErrorLogFields(err), count: unique.length }, "steam appdetails batch failed, fallback to single appdetails");
    }

    if (!batchFailed && out.size > 0) return out;

    for (let i = 0; i < unique.length; i += SINGLE_APPDETAILS_CONCURRENCY) {
      const chunk = unique.slice(i, i + SINGLE_APPDETAILS_CONCURRENCY);
      const results = await Promise.allSettled(
        chunk.map(async (appid) => {
          try {
            const url = `${APPDETAILS_URL}?appids=${encodeURIComponent(appid)}&cc=jp&l=japanese`;
            const json = await withTimeout((signal) => fetchJson<AppDetailsResponse>(url, { signal }));
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
          this.log.warn(
            { appid: reason.appid, ...httpErrorLogFields(reason.err ?? result.reason) },
            "steam appdetails single failed",
          );
        }
      }
      if (i + SINGLE_APPDETAILS_CONCURRENCY < unique.length) {
        await delay(SINGLE_APPDETAILS_DELAY_MS);
      }
    }
    return out;
  }
}
