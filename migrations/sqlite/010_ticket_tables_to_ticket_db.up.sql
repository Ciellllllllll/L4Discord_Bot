-- Modmail / appeals / tickets は data/ticket.db へ移行済み想定。メイン DB から削除する。
DROP TABLE IF EXISTS modmail_replies;
DROP TABLE IF EXISTS modmail_events;
DROP TABLE IF EXISTS modmail_intakes;
DROP TABLE IF EXISTS modmail_threads;
DROP TABLE IF EXISTS appeals;
DROP TABLE IF EXISTS tickets;
