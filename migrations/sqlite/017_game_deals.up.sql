CREATE TABLE IF NOT EXISTS game_deal_notify_channels (
  guild_id TEXT PRIMARY KEY NOT NULL,
  channel_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS game_deal_detected_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  title TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  first_detected_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  notified_at TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS game_deal_watcher_status (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_scan_at TEXT,
  last_success_at TEXT,
  last_error TEXT,
  last_detected_count INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO game_deal_watcher_status (id, last_detected_count)
VALUES (1, 0);

CREATE TABLE IF NOT EXISTS game_deal_subscriptions (
  id TEXT PRIMARY KEY NOT NULL,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  target_id TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT,
  last_state_key TEXT,
  last_notified_at TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_game_deal_subscriptions_active
  ON game_deal_subscriptions (active, guild_id);

CREATE TABLE IF NOT EXISTS game_deal_subscription_notifications (
  id TEXT PRIMARY KEY NOT NULL,
  subscription_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  message_id TEXT,
  action_pressed TEXT,
  pressed_at TEXT,
  created_at TEXT NOT NULL
);
