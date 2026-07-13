import Bottleneck from "bottleneck";
import type pino from "pino";
import type { SteamAppCatalogEntry } from "../gameDeals/gameDealTypes.js";

const APP_LIST_URL = "https://api.steampowered.com/IStoreService/GetAppList/v1/";
const USER_AGENT = "L4DiscordBot/0.1 SteamAppListWatcher (+https://store.steampowered.com/)";
const REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RESULTS = 50_000;
const APP_LIST_PAGE_DELAY_MS = 750;
const APP_LIST_MAX_RETRIES = 3;
const APP_LIST_BASE_RETRY_DELAY_MS = 1_000;
const appListLimiter = new Bottleneck({
  maxConcurrent: 1,
  minTime: APP_LIST_PAGE_DELAY_MS,
});

export type SteamAppListFetchOptions = {
  signal?: AbortSignal;
};

type AppListRaw = {
  response?: {
    apps?: unknown;
  };
  apps?: unknown;
};

export class SteamAppListHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
    readonly bodyPreview: string,
    readonly retryAfterSeconds: number | null,
  ) {
    super(message);
    this.name = "SteamAppListHttpError";
  }
}

function asString(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === "number" && Number.isInteger(value)) return String(value);
  return null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeApp(raw: unknown): SteamAppCatalogEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const appid = asString(record.appid);
  const name = asString(record.name) ?? "";
  if (!appid || !/^\d+$/.test(appid)) return null;
  return {
    appid,
    name,
    lastModified: asNumber(record.last_modified),
    priceChangeNumber: asNumber(record.price_change_number),
  };
}

async function fetchJson<T>(url: string, opts: SteamAppListFetchOptions = {}): Promise<T> {
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
    throw new SteamAppListHttpError(
      `Steam AppList request failed: ${res.status}`,
      res.status,
      url,
      text.slice(0, 300),
      retryAfterSeconds,
    );
  }
  return JSON.parse(text) as T;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetriableStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function retryDelayMs(err: SteamAppListHttpError, attempt: number): number {
  if (err.retryAfterSeconds !== null && err.retryAfterSeconds >= 0) {
    return err.retryAfterSeconds * 1000;
  }
  return APP_LIST_BASE_RETRY_DELAY_MS * attempt;
}

async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, externalSignal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fn(externalSignal ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

export class SteamAppListClient {
  constructor(
    private readonly log: pino.Logger,
    private readonly apiKey?: string,
  ) {}

  async fetchAllApps(maxResults = DEFAULT_MAX_RESULTS, options: SteamAppListFetchOptions = {}): Promise<SteamAppCatalogEntry[]> {
    const byAppid = new Map<string, SteamAppCatalogEntry>();
    let lastAppid = 0;
    for (;;) {
      const url = new URL(APP_LIST_URL);
      url.searchParams.set("max_results", String(maxResults));
      if (lastAppid > 0) url.searchParams.set("last_appid", String(lastAppid));
      if (this.apiKey?.trim()) url.searchParams.set("key", this.apiKey.trim());
      const json = await this.fetchAppListPage(url.toString(), options);
      const rawApps = Array.isArray(json.response?.apps) ? json.response.apps : Array.isArray(json.apps) ? json.apps : [];
      const apps = rawApps.map(normalizeApp).filter((value): value is SteamAppCatalogEntry => value !== null);
      for (const app of apps) byAppid.set(app.appid, app);
      this.log.info({ count: apps.length, total: byAppid.size, lastAppid }, "steam app list page fetched");
      if (apps.length === 0) break;
      const nextLastAppid = Number(apps[apps.length - 1]!.appid);
      if (!Number.isFinite(nextLastAppid) || nextLastAppid <= lastAppid) break;
      lastAppid = nextLastAppid;
      if (apps.length < maxResults) break;
    }
    return [...byAppid.values()].sort((a, b) => Number(a.appid) - Number(b.appid));
  }

  private async fetchAppListPage(url: string, options: SteamAppListFetchOptions): Promise<AppListRaw> {
    for (let attempt = 1; attempt <= APP_LIST_MAX_RETRIES; attempt += 1) {
      try {
        return await appListLimiter.schedule(() => withTimeout((signal) => fetchJson<AppListRaw>(url, { signal }), options.signal));
      } catch (err) {
        if (!(err instanceof SteamAppListHttpError) || !isRetriableStatus(err.status) || attempt >= APP_LIST_MAX_RETRIES) {
          throw err;
        }
        const delayMs = retryDelayMs(err, attempt);
        this.log.warn({ status: err.status, attempt, delayMs }, "steam app list page fetch retry scheduled");
        await delay(delayMs);
      }
    }
    throw new Error("unreachable steam app list retry state");
  }
}
