CREATE TABLE IF NOT EXISTS deal_watch_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  channel_id TEXT,
  steam_app_id TEXT NOT NULL,
  title TEXT,
  last_deal_id TEXT,
  last_sale_price REAL,
  last_normal_price REAL,
  last_savings REAL,
  last_change INTEGER,
  last_checked_at TEXT,
  last_notified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  UNIQUE(guild_id, steam_app_id)
);

CREATE TABLE IF NOT EXISTS deal_detected_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  detected_type TEXT NOT NULL,
  deal_id TEXT,
  steam_app_id TEXT,
  title TEXT NOT NULL,
  sale_price REAL,
  normal_price REAL,
  savings REAL,
  last_change INTEGER,
  cheapshark_url TEXT,
  steam_url TEXT,
  image_url TEXT,
  dedupe_key TEXT NOT NULL UNIQUE,
  first_detected_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  notified_at TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS game_deal_status (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_scan_at TEXT,
  last_success_at TEXT,
  last_error TEXT,
  last_detected_count INTEGER NOT NULL DEFAULT 0,
  cheapshark_cooldown_until TEXT
);

INSERT OR IGNORE INTO game_deal_status (id, last_detected_count)
VALUES (1, 0);
