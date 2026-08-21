import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSteamPagePreviewHtml, SteamStoreClient } from "./steamStoreClient.js";

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

test("SteamStoreClient parses the Steam page title, description, USD price, rating, image, and appid", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(`
    <html>
      <head><meta property="og:image" content="https://cdn.example.test/header.jpg"></head>
      <body>
        <div id="appHubAppName">Counter-Strike 2</div>
        <div id="game_area_description"><h2>About This Game</h2><p>A tactical shooter.</p></div>
        <div class="game_purchase_price price">$9.99</div>
        <div class="user_reviews_summary_row" data-tooltip-html="76% of the 78,889 user reviews are positive.">
          <span class="game_review_summary">Mostly Positive</span>
        </div>
      </body>
    </html>
  `, { status: 200, headers: { "Content-Type": "text/html" } });

  try {
    const preview = await new SteamStoreClient({ warn() {} } as never).fetchPagePreview(
      "https://store.steampowered.com/app/730/Counter_Strike_2/?cc=jp&l=japanese",
    );
    assert.deepEqual(preview, {
      canonicalUrl: "https://store.steampowered.com/app/730/Counter_Strike_2/",
      appid: "730",
      title: "Counter-Strike 2",
      body: "A tactical shooter.",
      price: { kind: "paid", usd: 9.99 },
      rating: { label: "Mostly Positive", percent: 76, reviewCount: 78_889 },
      imageUrl: "https://cdn.example.test/header.jpg",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("SteamStoreClient rejects a redirect outside official Steam domains", async () => {
  let requests = 0;
  const fetcher = async () => {
    requests += 1;
    return new Response(null, {
      status: 302,
      headers: { Location: "https://example.com/not-steam" },
    });
  };

  await assert.rejects(
    new SteamStoreClient({ warn() {} } as never).fetchPagePreview(
      "https://store.steampowered.com/app/730/Counter_Strike_2/",
      { fetcher },
    ),
    /official Steam domain/,
  );
  assert.equal(requests, 1);
});

test("SteamStoreClient follows redirects that remain on an official Steam domain", async () => {
  const requests: string[] = [];
  const fetcher = async (input: string) => {
    requests.push(input);
    if (requests.length === 1) {
      return new Response(null, {
        status: 302,
        headers: { Location: "/app/730/Counter_Strike_2/" },
      });
    }
    return new Response('<div id="appHubAppName">Counter-Strike 2</div>', { status: 200 });
  };

  const preview = await new SteamStoreClient({ warn() {} }).fetchPagePreview(
    "https://store.steampowered.com/",
    { fetcher },
  );
  assert.equal(preview.title, "Counter-Strike 2");
  assert.equal(requests.length, 2);
  assert.match(requests[1]!, /\/app\/730\/Counter_Strike_2\/\?cc=us&l=english$/);
});

test("SteamStoreClient treats a zero-dollar Steam price as free", () => {
  const preview = parseSteamPagePreviewHtml(
    '<div class="game_purchase_price">$0.00</div>',
    "https://store.steampowered.com/app/730/Counter_Strike_2/",
  );
  assert.deepEqual(preview.price, { kind: "free" });
});

test("Steam page parsing falls back to OGP description metadata", () => {
  const preview = parseSteamPagePreviewHtml(
    '<meta property="og:title" content="Community page"><meta property="og:description" content="Community description">',
    "https://steamcommunity.com/sharedfiles/filedetails/?id=1",
  );
  assert.equal(preview.title, "Community page");
  assert.equal(preview.body, "Community description");
});

console.log("steamStoreClient.spec.ts: all assertions passed");
