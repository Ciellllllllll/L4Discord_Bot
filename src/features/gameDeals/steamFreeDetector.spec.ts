import assert from "node:assert/strict";
import { buildSteamFreeStateKey, detectSteamFreeEvent } from "./steamFreeDetector.js";
import type { CheapSharkDeal } from "./cheapSharkTypes.js";
import type { SteamAppCatalogChange, SteamPaidPriceHistory } from "./gameDealTypes.js";
import type { SteamAppDetails, SteamSearchItem } from "../steam/steamFreeTypes.js";

const change: SteamAppCatalogChange = {
  appid: "123",
  name: "Paid Game",
  lastModified: 100,
  priceChangeNumber: 2,
  previousLastModified: 90,
  previousPriceChangeNumber: 1,
};

const paidHistory: SteamPaidPriceHistory = {
  appid: "123",
  title: "Paid Game",
  normalPriceCents: 198000,
  normalPriceDisplay: "1,980円",
  source: "steam_appdetails",
};

function details(extra: Partial<SteamAppDetails> = {}): SteamAppDetails {
  return {
    appid: "123",
    name: "Paid Game",
    type: "game",
    isFree: false,
    priceOverview: {
      initial: 198000,
      final: 0,
      discountPercent: 100,
      initialFormatted: "1,980円",
      finalFormatted: "無料",
    },
    ...extra,
  };
}

function search(extra: Partial<SteamSearchItem> = {}): SteamSearchItem {
  return {
    appid: "123",
    name: "Paid Game",
    storeUrl: "https://store.steampowered.com/app/123/",
    originalPrice: 1980,
    finalPrice: 0,
    discountPercent: 100,
    rawPriceText: "1,980円 無料 -100%",
    ...extra,
  };
}

function cheapSharkDeal(extra: Partial<CheapSharkDeal> = {}): CheapSharkDeal {
  return {
    dealId: "deal",
    storeId: "1",
    gameId: "game",
    title: "Paid Game",
    salePrice: 0,
    normalPrice: 19.99,
    savings: 100,
    isOnSale: true,
    steamAppId: "123",
    thumb: null,
    lastChange: 100,
    cheapSharkUrl: "https://www.cheapshark.com/redirect?dealID=deal",
    steamUrl: "https://store.steampowered.com/app/123/",
    ...extra,
  };
}

function runDetector(input: {
  appdetails?: SteamAppDetails | null;
  searchItem?: SteamSearchItem | null;
  cheapSharkDeals?: CheapSharkDeal[];
  history?: SteamPaidPriceHistory | null;
  overrideChange?: SteamAppCatalogChange;
}) {
  return detectSteamFreeEvent({
    change: input.overrideChange ?? change,
    appdetails: input.appdetails === undefined ? details() : input.appdetails,
    searchItem: input.searchItem === undefined ? null : input.searchItem,
    cheapSharkDeals: input.cheapSharkDeals ?? [],
    paidHistory: input.history === undefined ? paidHistory : input.history,
  });
}

async function run(): Promise<void> {
  assert.equal(runDetector({ appdetails: details({ type: "dlc" }) }).shouldNotify, false);
  assert.equal(runDetector({ appdetails: details({ type: "software" }) }).shouldNotify, false);
  assert.equal(runDetector({ appdetails: details({ type: "game", categories: ["Demo"] }) }).shouldNotify, false);
  assert.equal(runDetector({ appdetails: details({ type: "game", genres: ["Soundtrack"] }) }).shouldNotify, false);

  const alwaysFree = runDetector({
    appdetails: details({ isFree: true, priceOverview: undefined }),
    history: null,
  });
  assert.equal(alwaysFree.shouldNotify, false);

  assert.equal(runDetector({ appdetails: details() }).shouldNotify, true);
  assert.equal(runDetector({ appdetails: null, searchItem: search(), history: null }).shouldNotify, true);
  assert.equal(runDetector({ appdetails: details({ priceOverview: undefined }), cheapSharkDeals: [cheapSharkDeal()], history: null }).shouldNotify, true);
  assert.equal(runDetector({ searchItem: search({ rawPriceText: "Free Weekend Play for Free" }) }).shouldNotify, false);
  assert.equal(runDetector({ appdetails: details({ isFree: true, priceOverview: { initial: 198000, final: 0, discountPercent: 100 } }) }).shouldNotify, true);

  const baselineOnly = runDetector({
    overrideChange: {
      ...change,
      previousLastModified: null,
      previousPriceChangeNumber: null,
    },
  });
  assert.equal(baselineOnly.shouldNotify, false);

  assert.equal(buildSteamFreeStateKey(change), "steam_free:123:2:100");
}

void run()
  .then(() => {
    console.log("steamFreeDetector.spec.ts: all assertions passed");
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
