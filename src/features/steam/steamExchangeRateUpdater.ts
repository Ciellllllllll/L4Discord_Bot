import {
  fetchYahooUsdJpyRate,
  SteamExchangeRateRepository,
  tokyoDateKey,
  tokyoHour,
} from "./steamExchangeRateRepository.js";

export type SteamExchangeRateUpdaterRepository = Pick<
  SteamExchangeRateRepository,
  "tryClaimDailyFetch" | "recordSuccess" | "recordFailure"
>;

type LoggerLike = {
  warn?: (obj: unknown, message?: string) => void;
  info?: (obj: unknown, message?: string) => void;
};

export type SteamExchangeRateUpdaterController = {
  readonly ready: Promise<void>;
  stop(): Promise<void>;
};

export function startSteamExchangeRateUpdater(options: {
  repository: SteamExchangeRateUpdaterRepository;
  fetchRate?: (signal?: AbortSignal) => Promise<number>;
  now?: () => Date;
  setInterval?: (callback: () => void, delay: number) => NodeJS.Timeout;
  clearInterval?: (timer: NodeJS.Timeout) => void;
  log?: LoggerLike;
}): SteamExchangeRateUpdaterController {
  const now = options.now ?? (() => new Date());
  const abort = new AbortController();
  const setTimer = options.setInterval ?? setInterval;
  const clearTimer = options.clearInterval ?? clearInterval;
  let running = Promise.resolve();

  const run = async (): Promise<void> => {
    if (abort.signal.aborted || tokyoHour(now()) < 12) return;
    const date = tokyoDateKey(now());
    let claimed: boolean;
    try {
      claimed = await options.repository.tryClaimDailyFetch(date);
    } catch (error) {
      options.log?.warn?.({ error: String(error), date }, "steam exchange rate claim failed");
      return;
    }
    if (!claimed) return;
    try {
      const rate = await (options.fetchRate
        ? options.fetchRate(abort.signal)
        : fetchYahooUsdJpyRate(fetch, abort.signal));
      await options.repository.recordSuccess(date, rate);
      options.log?.info?.({ rate, date }, "steam exchange rate updated");
    } catch (error) {
      if (abort.signal.aborted) return;
      await options.repository.recordFailure(date, error);
      options.log?.warn?.({ error: String(error), date }, "steam exchange rate update failed");
    }
  };

  const scheduleRun = (): void => {
    running = running.then(run, run);
  };
  scheduleRun();
  const timer = setTimer(scheduleRun, 60_000);

  return {
    get ready() { return running; },
    async stop() {
      clearTimer(timer);
      abort.abort(new DOMException("stopped", "AbortError"));
      await running;
    },
  };
}
