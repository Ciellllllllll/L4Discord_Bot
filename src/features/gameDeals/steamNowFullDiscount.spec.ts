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
  <div class="search_discount">-100%</div>
  <div class="search_price"><span>¥ 1,980</span> ¥ 0</div>
</a>
<a class="search_result_row" data-ds-appid="200" href="https://store.steampowered.com/app/200/F2P_Game/">
  <span class="title">F2P Game</span>
  <div class="search_discount">-100%</div>
  <div class="search_price"><span>¥ 980</span> ¥ 0 Free To Play</div>
</a>
<a class="search_result_row" data-ds-appid="300" href="https://store.steampowered.com/app/300/Half_Game/">
  <span class="title">Half Game</span>
  <div class="search_discount">-50%</div>
  <div class="search_price"><span>¥ 1,000</span> ¥ 500</div>
</a>
`;

function appdetailsResponse(url: string) {
  const appid = new URL(url).searchParams.get("appids") ?? "";
  const common = {
    success: true,
    data: {
      name: appid === "100" ? "Paid Game" : "F2P Game",
      type: "game",
      is_free: false,
      header_image: `https://cdn.example.com/${appid}.jpg`,
      price_overview: {
        currency: "JPY",
        initial: appid === "100" ? 198000 : 98000,
        final: 0,
        discount_percent: 100,
        initial_formatted: appid === "100" ? "1,980円" : "980円",
        final_formatted: "無料",
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
  const schemaName = tempSchemaName();
  const pool = await createPgPool(connectionString, schemaName);
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = input.toString();
    if (url.includes("/search/")) {
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
      config: { DB_DRIVER: "postgres" },
      gameDealPgPool: pool,
      log: {
        debug(fields: unknown) {
          logs.push(fields);
        },
        info() {},
        warn() {},
      } as unknown as pino.Logger,
    } as BotContext;
    const items = await scanSteamNowFullDiscountItems(ctx);
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
