import assert from "node:assert/strict";
import { test } from "node:test";
import type { CoreDeps } from "../../core/deps.js";
import { checkSubscriptions } from "./gameDealScanner.js";
import type { GameDealSubscription } from "./gameDealTypes.js";

function subscription(id: string, platform: GameDealSubscription["platform"], targetId: string): GameDealSubscription {
  return { id, guildId: "guild", channelId: "channel", userId: `user-${id}`, platform, targetId, url: `https://example.test/${targetId}`, title: null, lastStateKey: null, active: true };
}

function context(): Pick<CoreDeps, "log" | "mainPgPool"> {
  return { log: { warn: () => undefined } } as unknown as Pick<CoreDeps, "log" | "mainPgPool">;
}

test("checkSubscriptions deduplicates Steam app ids and fetches Epic promotions once", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("appdetails")) {
      const appid = new URL(url).searchParams.get("appids")!;
      return new Response(JSON.stringify({ [appid]: { success: true, data: { name: `Steam ${appid}`, price_overview: { initial: 1000, final: 500, discount_percent: 50 } } } }));
    }
    return new Response(JSON.stringify({ data: { Catalog: { searchStore: { elements: [{ id: "offer", title: "Epic Game", productSlug: "epic-game", price: { totalPrice: { originalPrice: 2000, discountPrice: 0 } }, promotions: { promotionalOffers: [{ promotionalOffers: [{ startDate: "2020-01-01T00:00:00.000Z", endDate: "2099-01-01T00:00:00.000Z", discountSetting: { discountPercentage: 100 } }] }] } }] } } } }));
  };
  try {
    const hits = await checkSubscriptions(context(), [
      subscription("steam-1", "steam", "10"),
      subscription("steam-2", "steam", "10"),
      subscription("steam-3", "steam", "20"),
      subscription("epic-1", "epic", "epic-game"),
      subscription("epic-2", "epic", "epic-game"),
    ]);
    assert.equal(calls.filter((url) => url.includes("appdetails")).length, 2);
    assert.equal(calls.filter((url) => url.includes("freeGamesPromotions")).length, 1);
    assert.deepEqual(hits.map((hit) => hit.subscription.id).sort(), ["epic-1", "epic-2", "steam-1", "steam-2", "steam-3"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
