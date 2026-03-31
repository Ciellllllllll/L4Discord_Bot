-- メイン DB へチケット系テーブルを戻す（ticket.db の内容は自動では戻さない）
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

CREATE TABLE modmail_intakes (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  dm_sent_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);
CREATE INDEX idx_modmail_intakes_user_status ON modmail_intakes (user_id, status);

CREATE TABLE appeals (
  id TEXT PRIMARY KEY NOT NULL,
  code TEXT NOT NULL UNIQUE,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  punishment_type TEXT NOT NULL,
  punishment_reason TEXT,
  timeout_start INTEGER NOT NULL,
  timeout_end INTEGER NOT NULL,
  status TEXT NOT NULL,
  appeal_reason TEXT,
  detecter_incident_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  reviewer_id TEXT,
  review_note TEXT,
  review_message_id TEXT
);
CREATE INDEX idx_appeals_guild_user_created ON appeals (guild_id, user_id, created_at);

CREATE TABLE modmail_replies (
  id TEXT PRIMARY KEY NOT NULL,
  ticket_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  status TEXT NOT NULL,
  source_message_id TEXT NOT NULL,
  confirm_message_id TEXT,
  author_staff_id TEXT NOT NULL,
  approver_staff_id TEXT,
  content TEXT,
  fixed_reply_body TEXT NOT NULL,
  attachment_metadata TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  approved_at TEXT,
  rejected_at TEXT,
  sent_at TEXT,
  failed_at TEXT,
  cancelled_at TEXT,
  cancel_reason TEXT,
  failure_reason TEXT,
  close_reason TEXT
);
CREATE INDEX idx_modmail_replies_ticket_status ON modmail_replies (ticket_id, status);
CREATE INDEX idx_modmail_replies_thread ON modmail_replies (thread_id);
CREATE INDEX idx_modmail_replies_source ON modmail_replies (source_message_id, status);
CREATE INDEX idx_modmail_replies_pending ON modmail_replies (status);

CREATE TABLE modmail_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_modmail_events_type_created ON modmail_events (event_type, created_at);
