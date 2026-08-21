import assert from "node:assert/strict";
import { test } from "node:test";
import { startSteamExchangeRateUpdater } from "./steamExchangeRateUpdater.js";

test("為替更新は東京時間の正午以降に日付単位で1回だけ取得する", async () => {
  const claimed = new Set<string>();
  const fetched: string[] = [];
  let tick: (() => void) | undefined;
  const controller = startSteamExchangeRateUpdater({
    repository: {
      tryClaimDailyFetch: async (date) => {
        if (claimed.has(date)) return false;
        claimed.add(date);
        return true;
      },
      recordSuccess: async () => undefined,
      recordFailure: async () => undefined,
    },
    now: () => new Date("2026-08-21T03:00:00.000Z"),
    fetchRate: async () => {
      fetched.push("called");
      return 150.15;
    },
    setInterval: (callback) => {
      tick = callback;
      return 1 as never;
    },
    clearInterval: () => undefined,
  });
  await controller.ready;
  tick?.();
  await controller.ready;
  assert.deepEqual(fetched, ["called"]);
  await controller.stop();
});

test("正午前は為替取得を開始しない", async () => {
  let fetched = 0;
  const controller = startSteamExchangeRateUpdater({
    repository: {
      tryClaimDailyFetch: async () => true,
      recordSuccess: async () => undefined,
      recordFailure: async () => undefined,
    },
    now: () => new Date("2026-08-21T02:00:00.000Z"),
    fetchRate: async () => {
      fetched += 1;
      return 150;
    },
    setInterval: () => 1 as never,
    clearInterval: () => undefined,
  });
  await controller.ready;
  assert.equal(fetched, 0);
  await controller.stop();
});

test("既定経路は global fetch を使い、stop で進行中取得を中断する", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ input: string; signal: AbortSignal | null | undefined }> = [];
  let failures = 0;
  let startedResolve: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    startedResolve = resolve;
  });
  globalThis.fetch = ((input: string, init?: RequestInit) => {
    calls.push({ input, signal: init?.signal });
    startedResolve?.();
    return new Promise<Response>((_resolve, reject) => {
      if (init?.signal?.aborted) {
        reject(init.signal.reason ?? new DOMException("stopped", "AbortError"));
        return;
      }
      init?.signal?.addEventListener("abort", () => {
        reject(init.signal?.reason ?? new DOMException("stopped", "AbortError"));
      }, { once: true });
    });
  }) as typeof fetch;

  const controller = startSteamExchangeRateUpdater({
    repository: {
      tryClaimDailyFetch: async () => true,
      recordSuccess: async () => undefined,
      recordFailure: async () => {
        failures += 1;
      },
    },
    now: () => new Date("2026-08-21T03:00:00.000Z"),
    setInterval: () => 1 as never,
    clearInterval: () => undefined,
  });

  try {
    await started;
    await controller.stop();
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.input, /query1\.finance\.yahoo\.com\/v8\/finance\/chart\/JPY%3DX/);
    assert.equal(calls[0]!.signal?.aborted, true);
    assert.equal(failures, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
