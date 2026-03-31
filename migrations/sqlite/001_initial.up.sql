CREATE TABLE guild_settings (
  guild_id TEXT PRIMARY KEY NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE interaction_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  guild_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  action TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  executor_user_id TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_interaction_sessions_expires ON interaction_sessions (expires_at);

CREATE TABLE detecter_incidents (
  id TEXT PRIMARY KEY NOT NULL,
  guild_id TEXT NOT NULL,
  audit_entry_id TEXT NOT NULL UNIQUE,
  executor_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  reason TEXT,
  appeal_ticket_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE audit_log_cursors (
  guild_id TEXT PRIMARY KEY NOT NULL,
  last_snowflake TEXT NOT NULL
);

CREATE TABLE tickets (
  id TEXT PRIMARY KEY NOT NULL,
  guild_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  opener_id TEXT,
  assignee_id TEXT,
  data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_tickets_guild_status ON tickets (guild_id, status);

CREATE TABLE modmail_threads (
  id TEXT PRIMARY KEY NOT NULL,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  channel_id TEXT,
  thread_id TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE werewolf_games (
  id TEXT PRIMARY KEY NOT NULL,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  host_id TEXT NOT NULL,
  phase TEXT NOT NULL DEFAULT 'lobby',
  state TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE economy_accounts (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  balance INTEGER NOT NULL DEFAULT 0,
  xp INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE economy_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL,
  meta TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_economy_ledger_guild_user ON economy_ledger (guild_id, user_id);

CREATE TABLE keyword_stats (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  keyword_key TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (guild_id, user_id, keyword_key)
);

CREATE TABLE reaction_role_messages (
  id TEXT PRIMARY KEY NOT NULL,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (guild_id, channel_id, message_id)
);

CREATE TABLE panel_messages (
  id TEXT PRIMARY KEY NOT NULL,
  guild_id TEXT NOT NULL,
  panel_kind TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (guild_id, panel_kind)
);

CREATE TABLE stamp_usage (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  emoji_id TEXT NOT NULL,
  emoji_name TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (guild_id, user_id, emoji_id)
);
