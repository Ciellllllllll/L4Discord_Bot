CREATE TABLE IF NOT EXISTS steam_free_notify_channels (
  guild_id TEXT PRIMARY KEY NOT NULL,
  channel_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS steam_free_detected_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  appid TEXT NOT NULL,
  name TEXT NOT NULL,
  detected_type TEXT NOT NULL,
  original_price INTEGER,
  final_price INTEGER,
  discount_percent INTEGER,
  store_url TEXT NOT NULL,
  image_url TEXT,
  state_key TEXT NOT NULL,
  first_detected_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  notified_at TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE(appid, detected_type)
);

CREATE INDEX IF NOT EXISTS idx_steam_free_detected_items_active
  ON steam_free_detected_items (active, last_seen_at);

CREATE INDEX IF NOT EXISTS idx_steam_free_detected_items_state
  ON steam_free_detected_items (appid, detected_type, state_key);

CREATE TABLE IF NOT EXISTS steam_free_watcher_status (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_scan_at TEXT,
  last_success_at TEXT,
  last_error TEXT,
  last_detected_count INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO steam_free_watcher_status (id, last_detected_count)
VALUES (1, 0);
