-- リマインダーは専用 DB（既定: data/reminder.db）へ移行済み想定。メイン DB から削除する。
DROP INDEX IF EXISTS idx_reminders_guild_fire;
DROP TABLE IF EXISTS reminders;
