import assert from "node:assert/strict";
import type pino from "pino";
import type { BotContext } from "../../bot/context.js";
import { createPgPool, quotePgIdent } from "../../core/db/postgres.js";
import { getOptionalPostgresTestUrl } from "../../test/postgresTestEnv.js";
import { ensurePostgresGameDealSchema } from "./postgresGameDealRepository.js";
import { scanSteamNowFullDiscountItems } from "./steamFreeScanner.js";

const searchHtml = `
<a class="search_result_row" data-ds-appid="100" href="https://store.steampowered.com/app/100/Paid_Game/">
  <span class="title">Paid Game</span>
  <div class="search_price_discount_combined" data-price-final="0">
    <div class="discount_block search_discount_block" data-price-final="0" data-discount="100">
      <div class="discount_pct">-100%</div>
      <div class="discount_prices"><div class="discount_original_price">¥1,980</div><div class="discount_final_price">¥0</div></div>
    </div>
  </div>
</a>
<a class="search_result_row" data-ds-appid="200" href="https://store.steampowered.com/app/200/F2P_Game/">
  <span class="title">F2P Game</span>
  <div class="search_price_discount_combined" data-price-final="0">
    <div class="discount_block search_discount_block" data-price-final="0" data-discount="100">
      <div class="discount_pct">-100%</div>
      <div class="discount_prices"><div class="discount_original_price">¥980</div><div class="discount_final_price">¥0 Free To Play</div></div>
    </div>
  </div>
</a>
<a class="search_result_row" data-ds-appid="300" href="https://store.steampowered.com/app/300/Half_Game/">
  <span class="title">Half Game</span>
  <div class="search_price_discount_combined" data-price-final="500">
    <div class="discount_block search_discount_block" data-price-final="500" data-discount="50">
      <div class="discount_pct">-50%</div>
      <div class="discount_prices"><div class="discount_original_price">¥1,000</div><div class="discount_final_price">¥500</div></div>
    </div>
  </div>
</a>
<a class="search_result_row" data-ds-appid="400" href="https://store.steampowered.com/app/400/Stale_Price_Game/">
  <span class="title">Stale Price Game</span>
  <div class="search_price_discount_combined" data-price-final="0">
    <div class="discount_block search_discount_block" data-price-final="0" data-discount="100">
      <div class="discount_pct">-100%</div>
      <div class="discount_prices"><div class="discount_original_price">¥1,480</div><div class="discount_final_price">¥0</div></div>
    </div>
  </div>
</a>
<a class="search_result_row" data-ds-appid="500" href="https://store.steampowered.com/app/500/Weekend_Game/">
  <span class="title">Weekend Game</span>
  <div class="search_price_discount_combined" data-price-final="0">
    <div class="discount_block search_discount_block" data-price-final="0" data-discount="100">
      <div class="discount_pct">-100%</div>
      <div class="discount_prices"><div class="discount_original_price">¥1,280</div><div class="discount_final_price">¥0</div></div>
    </div>
  </div>
</a>
`;

function appdetailsResponse(url: string) {
  const appid = new URL(url).searchParams.get("appids") ?? "";
  const common = {
    success: true,
    data: {
      name: appid === "100" ? "Paid Game" : appid === "400" ? "Stale Price Game" : appid === "500" ? "Weekend Game" : "F2P Game",
      type: "game",
      is_free: appid === "100" || appid === "200",
      short_description: appid === "500" ? "Free Weekend promotion" : undefined,
      header_image: `https://cdn.example.com/${appid}.jpg`,
      price_overview: {
        currency: "JPY",
        initial: appid === "100" ? 198000 : appid === "400" ? 148000 : appid === "500" ? 128000 : 98000,
        final: appid === "100" ? 198000 : appid === "400" ? 500 : 0,
        discount_percent: appid === "400" ? 99 : 100,
        initial_formatted: appid === "100" ? "1,980円" : appid === "400" ? "1,480円" : appid === "500" ? "1,280円" : "980円",
        final_formatted: appid === "400" ? "5円" : "無料",
      },
      categories: [],
      genres: [],
    },
  };
  return { [appid]: common };
}

function tempSchemaName(): string {
  return `game_deals_steam_now_spec_${process.pid}_${Date.now()}`;
}

async function run(): Promise<boolean> {
  const connectionString = getOptionalPostgresTestUrl("DATABASE_URL", "steamNowFullDiscount.spec.ts");
  if (!connectionString) return false;

  const originalFetch = globalThis.fetch;
  const logs: unknown[] = [];
  let searchUrl: string | null = null;
  const schemaName = tempSchemaName();
  const pool = await createPgPool(connectionString, schemaName);
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = input.toString();
    if (url.includes("/search/")) {
      searchUrl = url;
      return new Response(searchHtml, { status: 200, headers: { "Content-Type": "text/html" } });
    }
    if (url.includes("/api/appdetails")) {
      return Response.json(appdetailsResponse(url));
    }
    throw new Error(`unexpected URL: ${url}`);
  }) as typeof fetch;

  try {
    await ensurePostgresGameDealSchema(pool, schemaName);
    const ctx = {
      config: {},
      mainPgPool: pool,
      log: {
        debug(fields: unknown) {
          logs.push(fields);
        },
        info() {},
        warn() {},
      } as unknown as pino.Logger,
    } as unknown as BotContext;
    const items = await scanSteamNowFullDiscountItems(ctx);
    const parsedSearchUrl = new URL(searchUrl!);
    assert.equal(parsedSearchUrl.searchParams.get("hwtype"), "0");
    assert.equal(parsedSearchUrl.searchParams.get("maxprice"), "free");
    assert.equal(parsedSearchUrl.searchParams.get("category1"), "998");
    assert.equal(parsedSearchUrl.searchParams.get("specials"), "1");
    assert.equal(parsedSearchUrl.searchParams.get("ndl"), "1");
    assert.equal(parsedSearchUrl.searchParams.get("cc"), "jp");
    assert.equal(parsedSearchUrl.searchParams.get("l"), "japanese");
    assert.equal(items.length, 1);
    assert.equal(items[0]?.platform, "steam");
    assert.equal(items[0]?.title, "Paid Game");
    assert.equal(items[0]?.dedupeKey.startsWith("steam_now:100:"), true);
    const duplicateItems = await scanSteamNowFullDiscountItems(ctx, undefined, { onlyUnnotified: true });
    assert.equal(duplicateItems.length, 1);
    await pool.query("UPDATE steam_free_events SET notified_at = CURRENT_TIMESTAMP WHERE state_key = $1", [
      items[0]?.dedupeKey,
    ]);
    const notifiedDuplicateItems = await scanSteamNowFullDiscountItems(ctx, undefined, { onlyUnnotified: true });
    assert.equal(notifiedDuplicateItems.length, 0);
    const manualItems = await scanSteamNowFullDiscountItems(ctx);
    assert.equal(manualItems.length, 1);
    assert.equal(logs.some((entry) => JSON.stringify(entry).includes("excluded_free_to_play")), true);
    assert.equal(logs.some((entry) => JSON.stringify(entry).includes("not_currently_free_in_appdetails")), true);
    assert.equal(logs.some((entry) => JSON.stringify(entry).includes("excluded_free_weekend_or_play_free")), true);
    return true;
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${quotePgIdent(schemaName)} CASCADE`);
    await pool.end();
    globalThis.fetch = originalFetch;
  }
}

run()
  .then((ranAssertions) => {
    if (ranAssertions) console.log("steamNowFullDiscount.spec.ts: all assertions passed");
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
