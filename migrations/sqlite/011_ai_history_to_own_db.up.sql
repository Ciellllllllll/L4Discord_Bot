-- /q 履歴は専用 DB（既定: data/AI_History.db）へ移行済み想定。メイン DB から削除する。
DROP INDEX IF EXISTS idx_ai_history_guild_user;
DROP INDEX IF EXISTS idx_ai_history_guild_created;
DROP TABLE IF EXISTS ai_history;
