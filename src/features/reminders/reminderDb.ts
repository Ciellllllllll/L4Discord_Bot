import type { Kysely } from "kysely";
import type { BotContext } from "../../bot/context.js";
import { createReminderKysely } from "../../core/db/kysely.js";
import { createSqliteDatabase } from "../../core/db/sqlite.js";
import type { ReminderDatabase } from "../../core/db/types.js";
import { ensureReminderSchema } from "./reminderDbSchema.js";

let reminderKysely: Kysely<ReminderDatabase> | null = null;

// リマインダー機能が初めて DB に触れるときだけ `reminder.db` を開き、スキーマを保証する。
// （マイグレーション 012 で既にファイルが作られている場合はそのまま再利用）

export function getReminderDb(ctx: BotContext): Kysely<ReminderDatabase> {
  if (reminderKysely) return reminderKysely;
  const sqlite = createSqliteDatabase(ctx.config.REMINDER_DATABASE_PATH);
  ensureReminderSchema(sqlite);
  reminderKysely = createReminderKysely(sqlite);
  return reminderKysely;
}
