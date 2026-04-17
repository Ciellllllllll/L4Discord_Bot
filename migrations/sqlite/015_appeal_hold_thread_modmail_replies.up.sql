-- 異議申し立て保留スレッド ID（!reply 連携用）
ALTER TABLE appeals ADD COLUMN hold_thread_id TEXT;

-- Modmail 返信キューと異議保留スレッドの紐付け（NULL = 通常 Modmail）
ALTER TABLE modmail_replies ADD COLUMN appeal_id TEXT;
