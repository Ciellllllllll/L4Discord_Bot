import assert from "node:assert/strict";
import { test } from "node:test";
import type { BotContext } from "../../bot/context.js";
import { scanSteamAppListChanges } from "./steamFreeScanner.js";

test("scanSteamAppListChanges rethrows shutdown AbortError without a warning", async () => {
  const originalFetch = globalThis.fetch;
  const warnings: unknown[][] = [];
  const controller = new AbortController();
  controller.abort();
  const ctx = {
    config: { STEAM_WEB_API_KEY: "" },
    mainPgPool: {},
    log: {
      info: () => undefined,
      warn: (...args: unknown[]) => { warnings.push(args); },
    },
  } as unknown as BotContext;
  globalThis.fetch = async () => { throw new DOMException("Game deal watcher stopped", "AbortError"); };

  try {
    await assert.rejects(scanSteamAppListChanges(ctx, controller.signal), { name: "AbortError" });
    assert.deepEqual(warnings, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
