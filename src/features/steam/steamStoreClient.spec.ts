import assert from "node:assert/strict";
import { test } from "node:test";
import { SteamStoreClient } from "./steamStoreClient.js";

test("SteamStoreClient rejects a search page with rows that cannot be parsed", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    '<a class="search_result_row" data-ds-appid="123"><span class="title">Broken row</span></a>',
    { status: 200, headers: { "Content-Type": "text/html" } },
  );

  try {
    await assert.rejects(
      new SteamStoreClient({ warn() {} } as never).fetchSearchItems(),
      /Steam search page contained rows but no valid items/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("SteamStoreClient propagates appdetails 403 and aborts, and parses the legacy free price shape", async () => {
  const originalFetch = globalThis.fetch;
  const client = new SteamStoreClient({ warn() {} } as never);

  try {
    globalThis.fetch = async () => new Response("forbidden", { status: 403 });
    await assert.rejects(client.fetchAppDetails(["123"]), /Steam API request failed: 403/);

    const controller = new AbortController();
    controller.abort(new DOMException("stopped", "AbortError"));
    globalThis.fetch = async (_input, init) => {
      if (init?.signal?.aborted) throw init.signal.reason ?? new DOMException("stopped", "AbortError");
      throw new Error("expected an aborted signal");
    };
    await assert.rejects(
      client.fetchAppDetails(["123"], { signal: controller.signal }),
      (error: unknown) => error instanceof DOMException && error.name === "AbortError",
    );

    globalThis.fetch = async () => new Response(
      '<a class="search_result_row" data-ds-appid="123" href="https://store.steampowered.com/app/123/Legacy_Game/"><span class="title">Legacy Game</span><div class="search_discount">-100%</div><div class="search_price">¥1,980<br>Free</div></a>',
      { status: 200, headers: { "Content-Type": "text/html" } },
    );
    const [item] = await client.fetchSearchItems();
    assert.deepEqual(item && {
      appid: item.appid,
      name: item.name,
      discountPercent: item.discountPercent,
      originalPrice: item.originalPrice,
      finalPrice: item.finalPrice,
    }, {
      appid: "123",
      name: "Legacy Game",
      discountPercent: 100,
      originalPrice: 1980,
      finalPrice: 0,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

console.log("steamStoreClient.spec.ts: all assertions passed");
