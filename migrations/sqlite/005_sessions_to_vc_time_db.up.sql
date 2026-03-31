-- VC 滞在セッションは data/vc_time.db へ分離。メイン DB の sessions を削除する。
DROP INDEX IF EXISTS idx_sessions_guild_user_open;
DROP INDEX IF EXISTS idx_sessions_open;
DROP INDEX IF EXISTS idx_sessions_channel;
DROP INDEX IF EXISTS idx_sessions_time;
DROP TABLE IF EXISTS sessions;
