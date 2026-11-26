import type { Kysely } from "kysely";
import type { CoreDeps } from "../../core/deps.js";
import { createPostgresReminderKysely } from "../../core/db/kysely.js";
import type { ReminderDatabase } from "../../core/db/types.js";

// ReminderDb が使う依存。
type ReminderDbDeps = Pick<CoreDeps, "config">;

let reminderKysely: Kysely<ReminderDatabase> | null = null;

export function getReminderDb(ctx: ReminderDbDeps): Kysely<ReminderDatabase> {
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
