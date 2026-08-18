import type DatabaseLib from "better-sqlite3";

export function ensureSqliteGameDealSourceSchema(db: DatabaseLib.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS steam_app_catalog (
      appid TEXT PRIMARY KEY,
      name TEXT,
      last_modified INTEGER,
      price_change_number INTEGER,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS steam_paid_price_history (
      appid TEXT PRIMARY KEY,
      title TEXT,
      normal_price_cents INTEGER,
      normal_price_display TEXT,
      source TEXT NOT NULL,
      first_paid_seen_at TEXT NOT NULL,
      last_paid_seen_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS steam_free_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      appid TEXT NOT NULL,
      title TEXT NOT NULL,
      state_key TEXT NOT NULL UNIQUE,
      price_change_number INTEGER,
      last_modified INTEGER,
      normal_price_cents INTEGER,
      current_price_cents INTEGER NOT NULL DEFAULT 0,
      discount_percent INTEGER,
      evidence_json TEXT NOT NULL,
      steam_url TEXT NOT NULL,
      image_url TEXT,
      first_detected_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      notified_at TEXT,
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS steam_verify_queue (
      appid TEXT PRIMARY KEY,
      reason TEXT NOT NULL,
      price_change_number INTEGER,
      last_modified INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT NOT NULL,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const columns = db.pragma("table_info(game_deal_subscription_notifications)") as Array<{ name: string }>;
  for (const column of ["guild_id", "target_platform", "target_id"]) {
    if (!columns.some((row) => row.name === column)) {
      db.exec(`ALTER TABLE game_deal_subscription_notifications ADD COLUMN ${column} TEXT`);
    }
  }
}
