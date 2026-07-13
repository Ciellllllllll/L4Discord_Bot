-- 004 のロールバック: メイン DB に旧 message_logs + FTS を復元（002 と同じ定義）
CREATE TABLE message_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  log_type TEXT,
  guild_id INTEGER,
  channel_id INTEGER,
  user_id INTEGER,
  user_name TEXT,
  content TEXT,
  edited_at TEXT,
  deleted_at TEXT,
  time TEXT
);

ALTER TABLE message_logs ADD COLUMN attachments TEXT DEFAULT '';

CREATE INDEX idx_mlogs_guild ON message_logs(guild_id);
CREATE INDEX idx_mlogs_channel ON message_logs(channel_id);
CREATE INDEX idx_mlogs_user_id ON message_logs(user_id);
CREATE INDEX idx_mlogs_user_name ON message_logs(user_name);
CREATE INDEX idx_mlogs_time ON message_logs(time);
CREATE INDEX idx_mlogs_type ON message_logs(log_type);

CREATE VIRTUAL TABLE message_logs_fts
  USING fts5(
    content,
    content='message_logs',
    content_rowid='id',
    tokenize='unicode61'
  );

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
