import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import type { AiHistoryDatabase, AutomoderationDatabase, Database, ReminderDatabase, TicketDatabase } from "./types.js";
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

export function createPostgresMainKysely(options: PostgresKyselyOptions): Kysely<Database> {
  return createPostgresKysely<Database>(options);
}

export function createPostgresTicketKysely(options: PostgresKyselyOptions): Kysely<TicketDatabase> {
  return createPostgresKysely<TicketDatabase>(options);
}

export function createPostgresAiHistoryKysely(options: PostgresKyselyOptions): Kysely<AiHistoryDatabase> {
  return createPostgresKysely<AiHistoryDatabase>(options);
}

export function createPostgresAutomoderationKysely(options: PostgresKyselyOptions): Kysely<AutomoderationDatabase> {
  return createPostgresKysely<AutomoderationDatabase>(options);
}

export function createPostgresReminderKysely(options: PostgresKyselyOptions): Kysely<ReminderDatabase> {
  return createPostgresKysely<ReminderDatabase>(options);
}
