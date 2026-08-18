import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { ensureSqliteAiProviderSourceSchema } from "../features/ai/aiProviderRepository.js";
import { ensureSqliteGameDealSourceSchema } from "../features/gameDeals/gameDealSourceSchema.js";

function tableNames(db: Database.Database): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>)
    .map((row) => row.name);
}

const db = new Database(":memory:");
try {
  for (const file of ["017_game_deals.up.sql", "018_game_deals_steam_source_status.up.sql", "019_cheapshark_deals.up.sql"]) {
    db.exec(readFileSync(join(process.cwd(), "migrations", "sqlite", file), "utf8"));
  }
  ensureSqliteAiProviderSourceSchema(db);
  ensureSqliteGameDealSourceSchema(db);
  assert.deepEqual(tableNames(db).filter((name) => !name.startsWith("sqlite_")), [
    "ai_guild_provider_settings",
    "ai_provider_daily_budget",
    "ai_provider_token_reservations",
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
  ]);
  const notificationColumns = db.pragma("table_info(game_deal_subscription_notifications)") as Array<{ name: string }>;
  assert.deepEqual(
    notificationColumns.map((column) => column.name).filter((name) => ["guild_id", "target_platform", "target_id"].includes(name)),
    ["guild_id", "target_platform", "target_id"],
  );
} finally {
  db.close();
}

console.log("sqliteSourceSchema.spec.ts: all assertions passed");
