import type DatabaseLib from "better-sqlite3";
import type { PgQueryable } from "../../core/db/postgres.js";

// Modmail / appeals / 汎用 tickets を ticket.db に集約するスキーマ（CREATE IF NOT EXISTS）

export function ensureTicketDatabaseSchema(db: DatabaseLib.Database): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS tickets (
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
CREATE INDEX IF NOT EXISTS idx_tickets_guild_status ON tickets (guild_id, status);

CREATE TABLE IF NOT EXISTS modmail_threads (
  id TEXT PRIMARY KEY NOT NULL,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  channel_id TEXT,
  thread_id TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS modmail_intakes (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  dm_sent_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_modmail_intakes_user_status ON modmail_intakes (user_id, status);

CREATE TABLE IF NOT EXISTS appeals (
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
  review_message_id TEXT,
  hold_thread_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_appeals_guild_user_created ON appeals (guild_id, user_id, created_at);

CREATE TABLE IF NOT EXISTS modmail_replies (
  id TEXT PRIMARY KEY NOT NULL,
  ticket_id TEXT NOT NULL,
  appeal_id TEXT,
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
CREATE INDEX IF NOT EXISTS idx_modmail_replies_ticket_status ON modmail_replies (ticket_id, status);
CREATE INDEX IF NOT EXISTS idx_modmail_replies_thread ON modmail_replies (thread_id);
CREATE INDEX IF NOT EXISTS idx_modmail_replies_source ON modmail_replies (source_message_id, status);
CREATE INDEX IF NOT EXISTS idx_modmail_replies_pending ON modmail_replies (status);

CREATE TABLE IF NOT EXISTS modmail_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_modmail_events_type_created ON modmail_events (event_type, created_at);
`);

  for (const stmt of [
    "ALTER TABLE appeals ADD COLUMN hold_thread_id TEXT",
    "ALTER TABLE modmail_replies ADD COLUMN appeal_id TEXT",
  ]) {
    try {
      db.exec(stmt);
    } catch {
      /* 列が既にある */
    }
  }
}

export async function ensurePostgresTicketDatabaseSchema(pool: PgQueryable): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tickets (
      id text PRIMARY KEY,
      guild_id text NOT NULL,
      kind text NOT NULL,
      status text NOT NULL DEFAULT 'open',
      opener_id text,
      assignee_id text,
      data jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_tickets_guild_status ON tickets (guild_id, status);

    CREATE TABLE IF NOT EXISTS modmail_threads (
      id text PRIMARY KEY,
      guild_id text NOT NULL,
      user_id text NOT NULL,
      channel_id text,
      thread_id text,
      status text NOT NULL DEFAULT 'open',
      data jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS modmail_intakes (
      guild_id text NOT NULL,
      user_id text NOT NULL,
      status text NOT NULL,
      requested_at timestamptz NOT NULL,
      dm_sent_at timestamptz,
      updated_at timestamptz NOT NULL,
      PRIMARY KEY (guild_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_modmail_intakes_user_status ON modmail_intakes (user_id, status);

    CREATE TABLE IF NOT EXISTS appeals (
      id text PRIMARY KEY,
      code text NOT NULL UNIQUE,
      guild_id text NOT NULL,
      user_id text NOT NULL,
      punishment_type text NOT NULL,
      punishment_reason text,
      timeout_start bigint NOT NULL,
      timeout_end bigint NOT NULL,
      status text NOT NULL,
      appeal_reason text,
      detecter_incident_id text,
      created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      reviewer_id text,
      review_note text,
      review_message_id text,
      hold_thread_id text
    );
    CREATE INDEX IF NOT EXISTS idx_appeals_guild_user_created ON appeals (guild_id, user_id, created_at);

    CREATE TABLE IF NOT EXISTS modmail_replies (
      id text PRIMARY KEY,
      ticket_id text NOT NULL,
      appeal_id text,
      guild_id text NOT NULL,
      user_id text NOT NULL,
      thread_id text NOT NULL,
      status text NOT NULL,
      source_message_id text NOT NULL,
      confirm_message_id text,
      author_staff_id text NOT NULL,
      approver_staff_id text,
      content text,
      fixed_reply_body text NOT NULL,
      attachment_metadata text NOT NULL DEFAULT '[]',
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      approved_at timestamptz,
      rejected_at timestamptz,
      sent_at timestamptz,
      failed_at timestamptz,
      cancelled_at timestamptz,
      cancel_reason text,
      failure_reason text,
      close_reason text
    );
    CREATE INDEX IF NOT EXISTS idx_modmail_replies_ticket_status ON modmail_replies (ticket_id, status);
    CREATE INDEX IF NOT EXISTS idx_modmail_replies_thread ON modmail_replies (thread_id);
    CREATE INDEX IF NOT EXISTS idx_modmail_replies_source ON modmail_replies (source_message_id, status);
    CREATE INDEX IF NOT EXISTS idx_modmail_replies_pending ON modmail_replies (status);

    CREATE TABLE IF NOT EXISTS modmail_events (
      id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      event_type text NOT NULL,
      payload text NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_modmail_events_type_created ON modmail_events (event_type, created_at);

    ALTER TABLE appeals ADD COLUMN IF NOT EXISTS hold_thread_id text;
    ALTER TABLE modmail_replies ADD COLUMN IF NOT EXISTS appeal_id text;
  `);
}
