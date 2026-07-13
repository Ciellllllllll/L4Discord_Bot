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
