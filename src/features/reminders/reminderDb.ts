import type { Kysely } from "kysely";
import type { BotContext } from "../../bot/context.js";
import { createPostgresReminderKysely } from "../../core/db/kysely.js";
import type { ReminderDatabase } from "../../core/db/types.js";

let reminderKysely: Kysely<ReminderDatabase> | null = null;

export function getReminderDb(ctx: BotContext): Kysely<ReminderDatabase> {
  if (reminderKysely) return reminderKysely;
  reminderKysely = createPostgresReminderKysely({
    connectionString: ctx.config.DATABASE_URL,
    schema: ctx.config.POSTGRES_REMINDER_SCHEMA,
  });
  return reminderKysely;
}

export async function destroyReminderDb(): Promise<void> {
  if (!reminderKysely) return;
  await reminderKysely.destroy();
  reminderKysely = null;
}
