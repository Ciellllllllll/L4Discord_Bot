import type { PgQueryable } from "../../core/db/postgres.js";

export const STEAM_EXCHANGE_SYMBOL = "JPY=X";
const YAHOO_CHART_URL = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(STEAM_EXCHANGE_SYMBOL)}?range=5d&interval=1d`;
const TOKYO_TIME_ZONE = "Asia/Tokyo";

type LoggerLike = { warn: (obj: unknown, message?: string) => void };
export type SteamExchangeRateFetch = (input: string, init?: RequestInit) => Promise<Response>;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 50 && value < 300 ? value : null;
}

export function parseYahooUsdJpyRate(payload: unknown): number | null {
  const result = record(record(payload)?.chart)?.result;
  const first = Array.isArray(result) ? record(result[0]) : null;
  const indicators = record(first?.indicators);
  const quotes = Array.isArray(indicators?.quote) ? record(indicators.quote[0]) : null;
  const closes = Array.isArray(quotes?.close) ? quotes.close : [];
  for (let index = closes.length - 1; index >= 0; index -= 1) {
    const rate = numberValue(closes[index]);
    if (rate !== null) return rate;
  }
  return numberValue(record(first?.meta)?.regularMarketPrice);
}

export function tokyoDateKey(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TOKYO_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function tokyoHour(now = new Date()): number {
  const value = new Intl.DateTimeFormat("en-US", {
    timeZone: TOKYO_TIME_ZONE,
    hour: "2-digit",
    hour12: false,
  }).format(now);
  return value === "24" ? 0 : Number(value);
}

export async function fetchYahooUsdJpyRate(
  fetcher: SteamExchangeRateFetch = fetch,
  signal?: AbortSignal,
): Promise<number> {
  const timeoutSignal = AbortSignal.timeout(12_000);
  const response = await fetcher(YAHOO_CHART_URL, {
    signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
    headers: {
      Accept: "application/json",
      "User-Agent": "L4DiscordBot/0.1 (+https://finance.yahoo.com/)",
    },
  });
  if (!response.ok) throw new Error(`Yahoo Finance Chart API request failed: ${response.status}`);
  const payload = JSON.parse(await response.text()) as unknown;
  const rate = parseYahooUsdJpyRate(payload);
  if (rate === null) throw new Error("Yahoo Finance Chart API returned no valid USD/JPY rate");
  return rate;
}

export async function ensurePostgresSteamExchangeRateSchema(pool: PgQueryable): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS steam_exchange_rates (
      rate_date date NOT NULL,
      rate numeric(12, 6),
      status text NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed')),
      attempted_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      fetched_at timestamptz,
      error_message text,
      PRIMARY KEY (rate_date)
    );
    CREATE INDEX IF NOT EXISTS idx_steam_exchange_rates_latest
      ON steam_exchange_rates (rate_date DESC)
      WHERE status = 'succeeded' AND rate IS NOT NULL;
  `);
}

export class SteamExchangeRateRepository {
  constructor(private readonly pool: PgQueryable, private readonly log?: LoggerLike) {}

  async tryClaimDailyFetch(rateDate: string): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO steam_exchange_rates (rate_date, status)
       VALUES ($1, 'pending')
       ON CONFLICT (rate_date) DO NOTHING`,
      [rateDate],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async recordSuccess(rateDate: string, rate: number): Promise<void> {
    await this.pool.query(
      `UPDATE steam_exchange_rates
       SET rate = $1, status = 'succeeded', fetched_at = CURRENT_TIMESTAMP, error_message = NULL
       WHERE rate_date = $2`,
      [rate, rateDate],
    );
  }

  async recordFailure(rateDate: string, error: unknown): Promise<void> {
    const message = String(error instanceof Error ? error.message : error).slice(0, 500);
    try {
      await this.pool.query(
        `UPDATE steam_exchange_rates
         SET status = 'failed', error_message = $1
         WHERE rate_date = $2`,
        [message, rateDate],
      );
    } catch (updateError) {
      this.log?.warn({ error: String(updateError), rateDate }, "steam exchange rate failure state save failed");
    }
  }

  async getLatestSuccessfulRate(): Promise<number | null> {
    const result = await this.pool.query<{ rate: string | number | null }>(
      `SELECT rate
       FROM steam_exchange_rates
       WHERE status = 'succeeded' AND rate IS NOT NULL
       ORDER BY rate_date DESC
       LIMIT 1`,
    );
    const raw = result.rows[0]?.rate;
    const rate = numberValue(typeof raw === "string" ? Number(raw) : raw);
    return rate;
  }
}
