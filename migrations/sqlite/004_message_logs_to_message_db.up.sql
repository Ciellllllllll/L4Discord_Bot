-- メッセージログは data/message.db（専用 DB）へ移行。メイン DB からは削除する。
DROP TRIGGER IF EXISTS message_logs_ad_fts;
DROP TRIGGER IF EXISTS message_logs_au_fts;
DROP TRIGGER IF EXISTS message_logs_ai_fts;
DROP TABLE IF EXISTS message_logs_fts;
DROP TABLE IF EXISTS message_logs;
