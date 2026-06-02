CREATE TABLE IF NOT EXISTS epic_free_notify_channels (
  guild_id TEXT PRIMARY KEY NOT NULL,
  channel_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS epic_free_detected_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  offer_id TEXT,
  namespace TEXT,
  title TEXT NOT NULL,
  detected_type TEXT NOT NULL,
  product_slug TEXT,
  url TEXT NOT NULL,
  image_url TEXT,
  original_price INTEGER,
  discount_price INTEGER,
  currency_code TEXT,
  start_date TEXT,
  end_date TEXT,
  first_detected_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  notified_at TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  dedupe_key TEXT NOT NULL UNIQUE
);

CREATE INDEX IF NOT EXISTS idx_epic_free_detected_items_active
  ON epic_free_detected_items (active, last_seen_at);

CREATE TABLE IF NOT EXISTS epic_free_watcher_status (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_scan_at TEXT,
  last_success_at TEXT,
  last_error TEXT,
  last_detected_count INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO epic_free_watcher_status (id, last_detected_count)
VALUES (1, 0);
