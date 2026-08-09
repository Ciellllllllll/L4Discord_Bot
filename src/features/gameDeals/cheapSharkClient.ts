import Bottleneck from "bottleneck";
import type pino from "pino";
import type { CheapSharkDeal, CheapSharkDealRaw } from "./cheapSharkTypes.js";

const CHEAPSHARK_DEALS_URL = "https://www.cheapshark.com/api/1.0/deals";
const USER_AGENT = "L4_DiscordBot/1.0 GameDealsBot";
const REQUEST_TIMEOUT_MS = 12_000;
const CHEAPSHARK_REQUEST_INTERVAL_MS = 1_100;
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 30 * 60 * 1_000;
const cheapSharkLimiter = new Bottleneck({
  maxConcurrent: 1,
  minTime: CHEAPSHARK_REQUEST_INTERVAL_MS,
});

type FetchOptions = {
  signal?: AbortSignal;
};

type CheapSharkClientOptions = {
  cooldownUntil?: string | null;
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
    const retryAfterSeconds = parseRetryAfterSeconds(retryAfter);
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

function parseRetryAfterSeconds(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, (timestamp - Date.now()) / 1_000) : null;
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
  private cooldownUntilMs = 0;

  constructor(private readonly log: pino.Logger, options: CheapSharkClientOptions = {}) {
    const cooldownUntilMs = options.cooldownUntil ? Date.parse(options.cooldownUntil) : NaN;
    if (Number.isFinite(cooldownUntilMs) && cooldownUntilMs > Date.now()) {
      this.cooldownUntilMs = cooldownUntilMs;
    }
  }

  getCooldownUntil(): string | null {
    return this.cooldownUntilMs > Date.now() ? new Date(this.cooldownUntilMs).toISOString() : null;
  }

  async fetchSteamDealsByAppId(steamAppId: string, options: FetchOptions = {}): Promise<CheapSharkDeal[]> {
    if (!/^\d+$/.test(steamAppId)) return [];
    if (this.getCooldownUntil()) return [];
    return await this.fetchDeals({
      storeID: "1",
      steamAppID: steamAppId,
    }, options);
  }

  private async fetchDeals(params: Record<string, string>, options: FetchOptions): Promise<CheapSharkDeal[]> {
    const url = new URL(CHEAPSHARK_DEALS_URL);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    try {
      const json = await cheapSharkLimiter.schedule(() => withTimeout((signal) => fetchJson<unknown>(url.toString(), { signal: options.signal ? AbortSignal.any([signal, options.signal]) : signal })));
      if (!Array.isArray(json)) return [];
      return json
        .map((value) => normalizeDeal(value as CheapSharkDealRaw))
        .filter((value): value is CheapSharkDeal => value !== null);
    } catch (err) {
      if (options.signal?.aborted) throw err;
      if (err instanceof CheapSharkHttpError && err.status === 429) {
        const cooldownMs = err.retryAfterSeconds === null
          ? DEFAULT_RATE_LIMIT_COOLDOWN_MS
          : Math.max(1, Math.ceil(err.retryAfterSeconds)) * 1_000;
        this.cooldownUntilMs = Math.max(this.cooldownUntilMs, Date.now() + cooldownMs);
        throw err;
      }
      this.log.warn(cheapSharkErrorLogFields(err), "cheapshark deals fetch failed");
      throw err;
    }
  }
}
