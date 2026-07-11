import type DatabaseLib from "better-sqlite3";
import { Kysely, PostgresDialect, SqliteDialect } from "kysely";
import { Pool } from "pg";
import type {
  AiHistoryDatabase,
  AutomoderationDatabase,
  Database,
  ReminderDatabase,
  TicketDatabase,
} from "./types.js";
import { pgSearchPathOption } from "./postgres.js";

export type PostgresKyselyOptions = {
  connectionString: string;
  schema: string;
};

function createPostgresKysely<T>(options: PostgresKyselyOptions): Kysely<T> {
  const pool = new Pool({
    connectionString: options.connectionString,
    options: `-c search_path=${pgSearchPathOption(options.schema)},public`,
  });
  return new Kysely<T>({
    dialect: new PostgresDialect({ pool }),
  });
}

export function createKysely(sqlite: DatabaseLib.Database): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new SqliteDialect({
      database: sqlite,
    }),
  });
}

export function createPostgresMainKysely(options: PostgresKyselyOptions): Kysely<Database> {
  return createPostgresKysely<Database>(options);
}

export function createTicketKysely(sqlite: DatabaseLib.Database): Kysely<TicketDatabase> {
  return new Kysely<TicketDatabase>({
    dialect: new SqliteDialect({
      database: sqlite,
    }),
  });
}

export function createPostgresTicketKysely(options: PostgresKyselyOptions): Kysely<TicketDatabase> {
  return createPostgresKysely<TicketDatabase>(options);
}

export function createAiHistoryKysely(sqlite: DatabaseLib.Database): Kysely<AiHistoryDatabase> {
  return new Kysely<AiHistoryDatabase>({
    dialect: new SqliteDialect({
      database: sqlite,
    }),
  });
}

export function createPostgresAiHistoryKysely(options: PostgresKyselyOptions): Kysely<AiHistoryDatabase> {
  return createPostgresKysely<AiHistoryDatabase>(options);
}

export function createAutomoderationKysely(sqlite: DatabaseLib.Database): Kysely<AutomoderationDatabase> {
  return new Kysely<AutomoderationDatabase>({
    dialect: new SqliteDialect({
      database: sqlite,
    }),
  });
}

export function createPostgresAutomoderationKysely(options: PostgresKyselyOptions): Kysely<AutomoderationDatabase> {
  return createPostgresKysely<AutomoderationDatabase>(options);
}

export function createReminderKysely(sqlite: DatabaseLib.Database): Kysely<ReminderDatabase> {
  return new Kysely<ReminderDatabase>({
    dialect: new SqliteDialect({
      database: sqlite,
    }),
  });
}

export function createPostgresReminderKysely(options: PostgresKyselyOptions): Kysely<ReminderDatabase> {
  return createPostgresKysely<ReminderDatabase>(options);
}
