import type pino from "pino";
import type { CheapSharkDeal, CheapSharkDealRaw } from "./cheapSharkTypes.js";

const CHEAPSHARK_DEALS_URL = "https://www.cheapshark.com/api/1.0/deals";
const USER_AGENT = "L4_DiscordBot/1.0 GameDealsBot";
const REQUEST_TIMEOUT_MS = 12_000;

type FetchOptions = {
  signal?: AbortSignal;
};

export class CheapSharkHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
    readonly bodyPreview: string,
    readonly retryAfterSeconds: number | null,
  ) {
    super(message);
    this.name = "CheapSharkHttpError";
  }
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value === "1" || value.toLowerCase() === "true";
  if (typeof value === "number") return value !== 0;
  return false;
}

function normalizeDeal(raw: CheapSharkDealRaw): CheapSharkDeal | null {
  const dealId = asString(raw.dealID);
  const title = asString(raw.title);
  const salePrice = asNumber(raw.salePrice);
  const normalPrice = asNumber(raw.normalPrice);
  const savings = asNumber(raw.savings);
  const steamAppId = asString(raw.steamAppID);
  if (!dealId || !title || salePrice === null || normalPrice === null || savings === null || !steamAppId) {
    return null;
  }
  if (!/^\d+$/.test(steamAppId)) return null;
  return {
    dealId,
    storeId: asString(raw.storeID),
    gameId: asString(raw.gameID),
    title,
    salePrice,
    normalPrice,
    savings,
    isOnSale: asBoolean(raw.isOnSale),
    steamAppId,
    thumb: asString(raw.thumb),
    lastChange: asNumber(raw.lastChange),
    cheapSharkUrl: `https://www.cheapshark.com/redirect?dealID=${encodeURIComponent(dealId)}`,
    steamUrl: `https://store.steampowered.com/app/${steamAppId}/`,
  };
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
    const retryAfter = res.headers.get("Retry-After");
    const retryAfterSeconds = retryAfter && Number.isFinite(Number(retryAfter)) ? Number(retryAfter) : null;
    throw new CheapSharkHttpError(
      `CheapShark request failed: ${res.status}`,
      res.status,
      url,
      text.slice(0, 300),
      retryAfterSeconds,
    );
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

function cheapSharkErrorLogFields(err: unknown): Record<string, unknown> {
  if (err instanceof CheapSharkHttpError) {
    return {
      err: err.message,
      status: err.status,
      url: err.url,
      bodyPreview: err.bodyPreview,
      retryAfterSeconds: err.retryAfterSeconds,
    };
  }
  return { err };
}

export class CheapSharkClient {
  constructor(private readonly log: pino.Logger) {}

  async fetchFreeSteamDeals(pageSize = 60): Promise<CheapSharkDeal[]> {
    return await this.fetchDeals({
      storeID: "1",
      upperPrice: "0",
      pageSize: String(pageSize),
      sortBy: "Savings",
    });
  }

  async fetchSteamDealsByAppId(steamAppId: string): Promise<CheapSharkDeal[]> {
    if (!/^\d+$/.test(steamAppId)) return [];
    return await this.fetchDeals({
      storeID: "1",
      steamAppID: steamAppId,
    });
  }

  private async fetchDeals(params: Record<string, string>): Promise<CheapSharkDeal[]> {
    const url = new URL(CHEAPSHARK_DEALS_URL);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    try {
      const json = await withTimeout((signal) => fetchJson<unknown>(url.toString(), { signal }));
      if (!Array.isArray(json)) return [];
      return json
        .map((value) => normalizeDeal(value as CheapSharkDealRaw))
        .filter((value): value is CheapSharkDeal => value !== null);
    } catch (err) {
      this.log.warn(cheapSharkErrorLogFields(err), "cheapshark deals fetch failed");
      throw err;
    }
  }
}
