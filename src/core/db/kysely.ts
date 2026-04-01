import type DatabaseLib from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import type {
  AiHistoryDatabase,
  AutomoderationDatabase,
  Database,
  ReminderDatabase,
  TicketDatabase,
} from "./types.js";

export function createKysely(sqlite: DatabaseLib.Database): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new SqliteDialect({
      database: sqlite,
    }),
  });
}

export function createTicketKysely(sqlite: DatabaseLib.Database): Kysely<TicketDatabase> {
  return new Kysely<TicketDatabase>({
    dialect: new SqliteDialect({
      database: sqlite,
    }),
  });
}

export function createAiHistoryKysely(sqlite: DatabaseLib.Database): Kysely<AiHistoryDatabase> {
  return new Kysely<AiHistoryDatabase>({
    dialect: new SqliteDialect({
      database: sqlite,
    }),
  });
}

export function createAutomoderationKysely(sqlite: DatabaseLib.Database): Kysely<AutomoderationDatabase> {
  return new Kysely<AutomoderationDatabase>({
    dialect: new SqliteDialect({
      database: sqlite,
    }),
  });
}

export function createReminderKysely(sqlite: DatabaseLib.Database): Kysely<ReminderDatabase> {
  return new Kysely<ReminderDatabase>({
    dialect: new SqliteDialect({
      database: sqlite,
    }),
  });
}
