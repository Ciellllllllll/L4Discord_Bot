import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { GameDealRepository } from "./gameDealRepository.js";
import { buildSteamFreeStateKey, detectSteamFreeEvent } from "./steamFreeDetector.js";
import type { CheapSharkDeal } from "./cheapSharkTypes.js";
import type { SteamAppCatalogChange, SteamFreeEvent, SteamPaidPriceHistory } from "./gameDealTypes.js";
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

function countCatalogPointLookups(db: Database.Database): { db: Database.Database; getCount: () => number } {
  let count = 0;
  const wrapped = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop !== "prepare") return Reflect.get(target, prop, receiver);
      return (sql: string) => {
        const statement = target.prepare(sql);
        if (!/FROM steam_app_catalog WHERE appid = \?/.test(sql)) return statement;
        return new Proxy(statement, {
          get(statementTarget, statementProp, statementReceiver) {
            if (statementProp !== "get") return Reflect.get(statementTarget, statementProp, statementReceiver);
            return (...args: unknown[]) => {
              count += 1;
              return statement.get(...args);
            };
          },
        });
      };
    },
  }) as Database.Database;
  return { db: wrapped, getCount: () => count };
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

  const db = new Database(":memory:");
  const repo = new GameDealRepository(db);
  const baseline = repo.upsertSteamAppCatalog([{ appid: "123", name: "Paid Game", lastModified: 100, priceChangeNumber: 1 }]);
  assert.equal(baseline.baselineCreated, true);
  assert.equal(baseline.changes.length, 0);
  const changed = repo.upsertSteamAppCatalog([{ appid: "123", name: "Paid Game", lastModified: 101, priceChangeNumber: 2 }]);
  assert.equal(changed.changes.length, 1);

  const lookupDb = new Database(":memory:");
  const lookupCounter = countCatalogPointLookups(lookupDb);
  const lookupRepo = new GameDealRepository(lookupCounter.db);
  lookupRepo.upsertSteamAppCatalog([
    { appid: "1", name: "One", lastModified: 100, priceChangeNumber: 1 },
    { appid: "2", name: "Two", lastModified: 100, priceChangeNumber: 1 },
  ]);
  lookupRepo.upsertSteamAppCatalog([
    { appid: "1", name: "One", lastModified: 101, priceChangeNumber: 2 },
    { appid: "2", name: "Two", lastModified: 100, priceChangeNumber: 1 },
  ]);
  assert.equal(lookupCounter.getCount(), 0);
  lookupDb.close();

  const event: SteamFreeEvent = {
    appid: "123",
    title: "Paid Game",
    stateKey: buildSteamFreeStateKey(change),
    priceChangeNumber: 2,
    lastModified: 100,
    normalPriceCents: 198000,
    currentPriceCents: 0,
    discountPercent: 100,
    evidenceJson: "[]",
    steamUrl: "https://store.steampowered.com/app/123/",
    imageUrl: null,
  };
  assert.equal(repo.upsertSteamFreeEvent(event).shouldNotify, true);
  repo.markSteamFreeEventNotified(event.stateKey);
  assert.equal(repo.upsertSteamFreeEvent(event).shouldNotify, false);
  db.close();
}

void run()
  .then(() => {
    console.log("steamFreeDetector.spec.ts: all assertions passed");
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
