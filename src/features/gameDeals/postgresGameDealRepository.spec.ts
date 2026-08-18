import assert from "node:assert/strict";
import { createPgPool, quotePgIdent } from "../../core/db/postgres.js";
import {
  dropPostgresSteamAppListTables,
  ensurePostgresGameDealSchema,
  PostgresGameDealRepository,
} from "./postgresGameDealRepository.js";
import { getOptionalPostgresTestUrl } from "../../test/postgresTestEnv.js";
import type { GameDealSubscription, SteamFreeEvent } from "./gameDealTypes.js";

type CapturingPool = {
  queries: string[];
  query: (sql: string) => Promise<{ rows: unknown[] }>;
};

const expectedTables = [
  "game_deal_detected_items",
  "game_deal_notify_channels",
  "game_deal_subscription_notifications",
  "game_deal_subscriptions",
  "game_deal_watcher_status",
  "steam_free_events",
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
    ["steam_free_events", "active"],
  ] as const;
  for (const [table, column] of expected) {
    assert.match(sql, new RegExp(`ALTER TABLE "legacy_schema"\\.${table}[\\s\\S]+ALTER COLUMN ${column} TYPE boolean`));
  }
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

  const connectionString = getOptionalPostgresTestUrl("DATABASE_URL", "postgresGameDealRepository.spec.ts");
  if (!connectionString) return false;

  const schemaName = tempSchemaName();
  const pool = await createPgPool(connectionString, schemaName);
  try {
    await ensurePostgresGameDealSchema(pool, schemaName);
    await assertSchemaTables(pool, schemaName);
    await pool.query("CREATE TABLE steam_app_catalog (appid text PRIMARY KEY)");
    await pool.query("CREATE TABLE steam_verify_queue (appid text PRIMARY KEY)");
    await dropPostgresSteamAppListTables(pool, schemaName);
    await dropPostgresSteamAppListTables(pool, schemaName);
    assert.deepEqual(
      (await pool.query<{ catalog: string | null; queue: string | null }>(
        "SELECT to_regclass('steam_app_catalog') AS catalog, to_regclass('steam_verify_queue') AS queue",
      )).rows,
      [{ catalog: null, queue: null }],
    );

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
