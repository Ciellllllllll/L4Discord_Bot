import assert from "node:assert/strict";
import { createPgPool, quotePgIdent } from "../../core/db/postgres.js";
import {
  ensurePostgresGameDealSchema,
  PostgresGameDealRepository,
} from "./postgresGameDealRepository.js";
import type { CheapSharkDeal } from "./cheapSharkTypes.js";
import type { GameDealSubscription, SteamFreeEvent } from "./gameDealTypes.js";

type CapturingPool = {
  queries: string[];
  query: (sql: string) => Promise<{ rows: unknown[] }>;
};

const expectedTables = [
  "deal_detected_items",
  "deal_watch_items",
  "game_deal_detected_items",
  "game_deal_notify_channels",
  "game_deal_status",
  "game_deal_subscription_notifications",
  "game_deal_subscriptions",
  "game_deal_watcher_status",
  "steam_app_catalog",
  "steam_free_events",
  "steam_paid_price_history",
  "steam_verify_queue",
].sort();

function tempSchemaName(): string {
  return `game_deals_spec_${process.pid}_${Date.now()}`;
}

function createCapturingPool(): CapturingPool {
  return {
    queries: [],
    async query(sql: string): Promise<{ rows: unknown[] }> {
      this.queries.push(sql);
      return { rows: [] };
    },
  };
}

async function assertLegacyBooleanColumnMigrationsAreEmitted(): Promise<void> {
  const pool = createCapturingPool();
  await ensurePostgresGameDealSchema(pool as unknown as Parameters<typeof ensurePostgresGameDealSchema>[0], "legacy_schema");
  const sql = pool.queries.join("\n");
  const expected = [
    ["game_deal_notify_channels", "enabled"],
    ["game_deal_detected_items", "active"],
    ["game_deal_subscriptions", "active"],
    ["deal_watch_items", "enabled"],
    ["deal_detected_items", "active"],
    ["steam_free_events", "active"],
  ] as const;
  for (const [table, column] of expected) {
    assert.match(sql, new RegExp(`ALTER TABLE "legacy_schema"\\.${table}[\\s\\S]+ALTER COLUMN ${column} TYPE boolean`));
  }
}

function cheapSharkDeal(extra: Partial<CheapSharkDeal> = {}): CheapSharkDeal {
  return {
    dealId: "deal-1",
    storeId: "1",
    gameId: "game-1",
    title: "Discounted Game",
    salePrice: 0.99,
    normalPrice: 19.99,
    savings: 95,
    isOnSale: true,
    steamAppId: "100",
    thumb: "https://cdn.example.com/100.jpg",
    lastChange: 123,
    cheapSharkUrl: "https://www.cheapshark.com/redirect?dealID=deal-1",
    steamUrl: "https://store.steampowered.com/app/100/",
    ...extra,
  };
}

function subscriptionHit(subscription: GameDealSubscription, stateKey: string) {
  return {
    subscription,
    title: "Watched Game",
    url: "https://store.steampowered.com/app/100/",
    imageUrl: "https://cdn.example.com/100.jpg",
    originalPrice: 1980,
    currentPrice: 0,
    discountPercent: 100,
    stateKey,
    platform: "steam" as const,
  };
}

function steamFreeEvent(extra: Partial<SteamFreeEvent> = {}): SteamFreeEvent {
  return {
    appid: "100",
    title: "Free Game",
    stateKey: "steam_free:100:2:200",
    priceChangeNumber: 2,
    lastModified: 200,
    normalPriceCents: 198000,
    currentPriceCents: 0,
    discountPercent: 100,
    evidenceJson: JSON.stringify([{ source: "steam_appdetails" }]),
    steamUrl: "https://store.steampowered.com/app/100/",
    imageUrl: "https://cdn.example.com/100.jpg",
    ...extra,
  };
}

async function assertSchemaTables(pool: { query: PostgresGameDealRepository["pool"]["query"] }, schemaName: string): Promise<void> {
  const result = await pool.query<{ table_name: string }>(
    `
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = $1
      AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `,
    [schemaName],
  );
  assert.deepEqual(result.rows.map((row) => row.table_name).sort(), expectedTables);
}

async function run(): Promise<boolean> {
  await assertLegacyBooleanColumnMigrationsAreEmitted();

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.log("postgresGameDealRepository.spec.ts: DATABASE_URL is not set; skipping PostgreSQL integration assertions");
    return false;
  }

  const schemaName = tempSchemaName();
  const pool = await createPgPool(connectionString, schemaName);
  try {
    await ensurePostgresGameDealSchema(pool, schemaName);
    await assertSchemaTables(pool, schemaName);

    const repo = new PostgresGameDealRepository(pool);

    assert.equal(await repo.getNotifyChannel("guild-1"), null);
    assert.deepEqual(await repo.enableNotifyChannel("guild-1", "channel-1"), { alreadyEnabledInChannel: false });
    assert.deepEqual(await repo.enableNotifyChannel("guild-1", "channel-1"), { alreadyEnabledInChannel: true });
    assert.deepEqual(await repo.getNotifyChannel("guild-1"), {
      guildId: "guild-1",
      channelId: "channel-1",
      enabled: true,
    });
    assert.deepEqual(await repo.listEnabledNotifyChannels(), [
      { guildId: "guild-1", channelId: "channel-1", enabled: true },
    ]);
    await repo.disableNotifyChannel("guild-1");
    assert.deepEqual(await repo.listEnabledNotifyChannels(), []);
    assert.equal((await repo.getNotifyChannel("guild-1"))?.enabled, false);

    const subscription = await repo.addSubscription({
      guildId: "guild-1",
      channelId: "channel-1",
      userId: "user-1",
      platform: "steam",
      targetId: "100",
      url: "https://store.steampowered.com/app/100/",
      title: "Watched Game",
    });
    assert.equal(subscription.active, true);
    assert.equal((await repo.listActiveSubscriptions()).length, 1);
    assert.equal((await repo.listActiveSubscriptionsForUser("guild-1", "user-1"))[0]?.id, subscription.id);

    assert.deepEqual(await repo.updateSubscriptionSeen(subscriptionHit(subscription, "state-1")), { shouldNotify: true });
    const updatedSubscription = (await repo.listActiveSubscriptionsForUser("guild-1", "user-1"))[0]!;
    assert.equal(updatedSubscription.lastStateKey, "state-1");
    assert.deepEqual(await repo.updateSubscriptionSeen(subscriptionHit(updatedSubscription, "state-1")), {
      shouldNotify: false,
    });

    const notificationId = await repo.createTargetNotification({
      guildId: "guild-1",
      platform: "steam",
      targetId: "100",
      subscriptionId: subscription.id,
      userId: "user-1",
    });
    await repo.setNotificationMessage(notificationId, "message-1");
    assert.deepEqual(await repo.getNotification(notificationId), {
      subscriptionId: subscription.id,
      userId: "user-1",
      actionPressed: null,
      guildId: "guild-1",
      targetPlatform: "steam",
      targetId: "100",
    });
    await repo.markNotificationPressed(notificationId, "dismiss");
    assert.equal((await repo.getNotification(notificationId))?.actionPressed, "dismiss");

    await repo.deactivateSubscription(subscription.id);
    assert.deepEqual(await repo.listActiveSubscriptions(), []);
    const targetSubscription = await repo.addSubscription({
      guildId: "guild-1",
      channelId: "channel-1",
      userId: "user-1",
      platform: "steam",
      targetId: "200",
      url: "https://store.steampowered.com/app/200/",
    });
    assert.equal(targetSubscription.active, true);
    assert.equal(
      await repo.deactivateSubscriptionForTargetUser({
        guildId: "guild-1",
        userId: "user-1",
        platform: "steam",
        targetId: "200",
      }),
      1,
    );
    assert.equal(
      await repo.deactivateSubscriptionForTargetUser({
        guildId: "guild-1",
        userId: "user-1",
        platform: "steam",
        targetId: "200",
      }),
      0,
    );

    const deal = cheapSharkDeal();
    assert.equal((await repo.addDealWatch({ guildId: "guild-1", channelId: "channel-1", steamAppId: "100", deal })).created, true);
    assert.equal((await repo.addDealWatch({ guildId: "guild-1", channelId: "channel-1", steamAppId: "100", deal })).created, false);
    const watch = await repo.getDealWatch("guild-1", "100");
    assert.equal(watch?.title, "Discounted Game");
    assert.equal((await repo.listDealWatches("guild-1")).length, 1);
    assert.equal((await repo.listAllDealWatches()).length, 1);
    await repo.updateDealWatchChecked(watch!, cheapSharkDeal({ dealId: "deal-2", salePrice: 0 }), true);
    const checkedWatch = await repo.getDealWatch("guild-1", "100");
    assert.equal(checkedWatch?.lastDealId, "deal-2");
    assert.notEqual(checkedWatch?.lastNotifiedAt, null);
    assert.equal(await repo.disableDealWatch("guild-1", "100"), 1);
    assert.deepEqual(await repo.listDealWatches("guild-1"), []);

    assert.deepEqual(
      await repo.upsertDetectedDeal({ source: "cheapshark", detectedType: "sale", deal, dedupeKey: "deal:100", markNotified: true }),
      { shouldNotify: true },
    );
    assert.deepEqual(
      await repo.upsertDetectedDeal({ source: "cheapshark", detectedType: "sale", deal, dedupeKey: "deal:100", markNotified: true }),
      { shouldNotify: false },
    );

    assert.equal(await repo.hasSteamAppCatalog(), false);
    assert.deepEqual(
      await repo.upsertSteamAppCatalog([
        { appid: "100", name: "One", lastModified: 10, priceChangeNumber: 1 },
        { appid: "200", name: "Two", lastModified: 20, priceChangeNumber: 1 },
      ]),
      { baselineCreated: true, changes: [] },
    );
    assert.equal(await repo.hasSteamAppCatalog(), true);
    const catalogUpdate = await repo.upsertSteamAppCatalog([
      { appid: "100", name: "One", lastModified: 11, priceChangeNumber: 2 },
      { appid: "200", name: "Two", lastModified: 20, priceChangeNumber: 1 },
      { appid: "300", name: "Three", lastModified: 30, priceChangeNumber: 1 },
    ]);
    assert.equal(catalogUpdate.baselineCreated, false);
    assert.deepEqual(catalogUpdate.changes, [
      {
        appid: "100",
        name: "One",
        lastModified: 11,
        priceChangeNumber: 2,
        previousLastModified: 10,
        previousPriceChangeNumber: 1,
      },
    ]);

    await repo.enqueueSteamVerify({ appid: "100", reason: "price_change_detected", priceChangeNumber: 2, lastModified: 11 });
    await repo.enqueueSteamVerify({ appid: "200", reason: "delayed", priceChangeNumber: 1, lastModified: 20, delayMs: 60_000 });
    assert.deepEqual((await repo.listDueSteamVerifyQueue(10)).map((item) => item.appid), ["100"]);
    await repo.markSteamVerifyRetry("100", "retry", "temporary failure");
    assert.deepEqual(await repo.listDueSteamVerifyQueue(10), []);
    await repo.enqueueSteamVerify({ appid: "100", reason: "ready", priceChangeNumber: 2, lastModified: 11 });
    assert.equal((await repo.listDueSteamVerifyQueue(10))[0]?.appid, "100");
    await repo.removeSteamVerifyQueue("100");
    assert.deepEqual(await repo.listDueSteamVerifyQueue(10), []);

    const event = steamFreeEvent();
    assert.deepEqual(await repo.upsertSteamFreeEvent(event), { shouldNotify: true });
    assert.deepEqual(await repo.upsertSteamFreeEvent(steamFreeEvent({ title: "Free Game Updated" })), { shouldNotify: true });
    assert.equal((await repo.listActiveSteamFreeEvents(10))[0]?.title, "Free Game Updated");
    await repo.markSteamFreeEventNotified(event.stateKey);
    assert.deepEqual(await repo.upsertSteamFreeEvent(event), { shouldNotify: false });
    assert.equal((await repo.listActiveSteamFreeEvents(10))[0]?.stateKey, event.stateKey);
    return true;
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${quotePgIdent(schemaName)} CASCADE`);
    await pool.end();
  }
}

void run()
  .then((ranAssertions) => {
    if (ranAssertions) console.log("postgresGameDealRepository.spec.ts: all assertions passed");
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
