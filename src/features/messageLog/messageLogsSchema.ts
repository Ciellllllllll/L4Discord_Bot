import type DatabaseLib from "better-sqlite3";

/** message.db: Downloads の message.db / 002 の INTEGER スノーフレーク + FTS に、DiscordBOTv2 相当の拡張カラムを足す */
const BASE_CREATE = `
CREATE TABLE IF NOT EXISTS message_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  log_type TEXT,
  guild_id INTEGER,
  channel_id INTEGER,
  user_id INTEGER,
  user_name TEXT,
  content TEXT,
  edited_at TEXT,
  deleted_at TEXT,
  time TEXT,
  attachments TEXT DEFAULT ''
)`;

const EXTRA_COLUMNS: [string, string][] = [
  ["message_id", "INTEGER"],
  ["author_id", "INTEGER"],
  ["author_tag", "TEXT"],
  ["author_display_name", "TEXT"],
  ["created_at", "TEXT"],
  ["message_type", "TEXT"],
  ["embeds_json", "TEXT"],
  ["reply_ref_json", "TEXT"],
  ["attachment_count", "INTEGER DEFAULT 0"],
  ["attachments_json", "TEXT"],
];

const LEGACY_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_mlogs_guild ON message_logs(guild_id)",
  "CREATE INDEX IF NOT EXISTS idx_mlogs_channel ON message_logs(channel_id)",
  "CREATE INDEX IF NOT EXISTS idx_mlogs_user_id ON message_logs(user_id)",
  "CREATE INDEX IF NOT EXISTS idx_mlogs_user_name ON message_logs(user_name)",
  "CREATE INDEX IF NOT EXISTS idx_mlogs_time ON message_logs(time)",
  "CREATE INDEX IF NOT EXISTS idx_mlogs_type ON message_logs(log_type)",
];

const EXTENDED_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_message_logs_time ON message_logs(time)",
  "CREATE INDEX IF NOT EXISTS idx_message_logs_user ON message_logs(guild_id, user_id, time)",
  "CREATE INDEX IF NOT EXISTS idx_message_logs_channel ON message_logs(guild_id, channel_id, time)",
  "CREATE INDEX IF NOT EXISTS idx_message_logs_message_id ON message_logs(guild_id, message_id)",
  "CREATE INDEX IF NOT EXISTS idx_message_logs_created_at ON message_logs(guild_id, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_message_logs_attachment_count ON message_logs(guild_id, attachment_count, created_at)",
];

const FTS_AND_TRIGGERS = `
CREATE VIRTUAL TABLE IF NOT EXISTS message_logs_fts
  USING fts5(
    content,
    content='message_logs',
    content_rowid='id',
    tokenize='unicode61'
  );

DROP TRIGGER IF EXISTS message_logs_ai_fts;
DROP TRIGGER IF EXISTS message_logs_au_fts;
DROP TRIGGER IF EXISTS message_logs_ad_fts;

CREATE TRIGGER message_logs_ai_fts
  AFTER INSERT ON message_logs BEGIN
    INSERT INTO message_logs_fts(rowid, content) VALUES (new.id, new.content);
  END;

CREATE TRIGGER message_logs_au_fts
  AFTER UPDATE OF content ON message_logs BEGIN
    INSERT INTO message_logs_fts(message_logs_fts, rowid, content)
    VALUES('delete', old.id, old.content);
    INSERT INTO message_logs_fts(rowid, content)
    VALUES (new.id, new.content);
  END;

CREATE TRIGGER message_logs_ad_fts
  AFTER DELETE ON message_logs BEGIN
    INSERT INTO message_logs_fts(message_logs_fts, rowid, content)
    VALUES('delete', old.id, old.content);
  END;
`;

export function ensureMessageLogsSchema(db: DatabaseLib.Database): void {
  db.exec(BASE_CREATE);
  const cols = db.prepare("PRAGMA table_info(message_logs)").all() as { name: string }[];
  const have = new Set(cols.map((c) => c.name));
  for (const [name, typeSql] of EXTRA_COLUMNS) {
    if (!have.has(name)) {
      db.exec(`ALTER TABLE message_logs ADD COLUMN ${name} ${typeSql}`);
    }
  }
  for (const sql of LEGACY_INDEXES) db.exec(sql);
  for (const sql of EXTENDED_INDEXES) db.exec(sql);
  db.exec(FTS_AND_TRIGGERS);
}
