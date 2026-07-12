import type DatabaseLib from "better-sqlite3";
import { sql, type Kysely } from "kysely";
import type { Pool } from "pg";
import type { AppConfig } from "../core/config.js";
import {
  createAiHistoryKysely, createAutomoderationKysely, createKysely, createPostgresAiHistoryKysely,
  createPostgresAutomoderationKysely, createPostgresMainKysely, createPostgresTicketKysely, createTicketKysely,
} from "../core/db/kysely.js";
import { createPgPool } from "../core/db/postgres.js";
import { ensurePostgresMainSchema } from "../core/db/postgresMainSchema.js";
import { applyPostgresMigrations, type PostgresMigration } from "../core/db/postgresMigrations.js";
import { createSqliteDatabase } from "../core/db/sqlite.js";
import { applyPendingSqliteMigrations, getSqliteUserVersion } from "../core/db/sqliteMigrations.js";
import type { AiHistoryDatabase, AutomoderationDatabase, Database, TicketDatabase } from "../core/db/types.js";
import { copyAiHistoryFromMainToDedicatedDb } from "../features/ai/copyAiHistoryFromMain.js";
import { ensureAiHistorySchema, ensurePostgresAiHistorySchema } from "../features/ai/aiHistorySchema.js";
import { ensureAiR18UserSettingsSchema } from "../features/ai/aiR18UserSettingsSchema.js";
import { ensurePostgresAiProviderSchema, PostgresAiProviderBudgetRepository, PostgresAiProviderSettingsRepository } from "../features/ai/postgresAiProviderRepository.js";
import { AiProviderRouter } from "../features/ai/aiProviderRouter.js";
import { ensureSqliteAiProviderSchema, SqliteAiProviderBudgetRepository, SqliteAiProviderSettingsRepository } from "../features/ai/aiProviderRepository.js";
import { ensurePostgresGameDealSchema } from "../features/gameDeals/postgresGameDealRepository.js";
import { ensurePostgresLolWatcherSchema } from "../features/lolWatcher/lolWatcher.repository.js";
import { prepareMessageAttachmentStore, prepareMessageAttachmentStorePostgres } from "../features/messageLog/messageAttachmentArchive.js";
import { prepareMessageLogsDatabase } from "../features/messageLog/index.js";
import { ensurePostgresMessageLogsSchema } from "../features/messageLog/messageLogsSchema.js";
import { ensureAutomoderationSchema, ensurePostgresAutomoderationSchema } from "../features/moderation/automodSchema.js";
import { ensurePacchiSchemaOnce, ensurePostgresPacchiSchema } from "../features/pacchi/pacchi.schema.js";
import { copyRemindersFromMainToReminderDb } from "../features/reminders/copyRemindersFromMain.js";
import { destroyReminderDb } from "../features/reminders/reminderDb.js";
import { ensurePostgresReminderSchema } from "../features/reminders/reminderDbSchema.js";
import { ensurePostgresSenryuSchema } from "../features/senryu/senryu.repository.js";
import { copyTicketDataFromMainToTicketDb } from "../features/tickets/copyTicketDataFromMain.js";
import { ensurePostgresTicketDatabaseSchema, ensureTicketDatabaseSchema } from "../features/tickets/ticketDbSchema.js";
import { ensurePostgresVcTempSchema } from "../features/vc/vcTempPersistence.js";
import { ensurePostgresVcTimeSchema, ensureVcTimeSchema } from "../features/vc/vcTimeSchema.js";
import type pino from "pino";

export type DatabaseRuntime = {
  usePostgres: boolean;
  sqlite?: DatabaseLib.Database;
  ticketSqlite?: DatabaseLib.Database;
  messageLogSqlite?: DatabaseLib.Database;
  messageAttachmentStoreSqlite?: DatabaseLib.Database;
  vcTimeSqlite?: DatabaseLib.Database;
  aiHistorySqlite?: DatabaseLib.Database;
  automodSqlite?: DatabaseLib.Database;
  db: Kysely<Database>;
  ticketDb: Kysely<TicketDatabase>;
  aiHistoryDb: Kysely<AiHistoryDatabase>;
  automodDb: Kysely<AutomoderationDatabase>;
  messageLogPgPool?: Pool;
  mainPgPool?: Pool;
  vcTimePgPool?: Pool;
  messageAttachmentPgPool?: Pool;
  aiRouter: AiProviderRouter;
};

export type DatabaseRuntimeCleanup = () => void | Promise<void>;

/** Registers resources while initializing a database runtime and releases them if initialization fails. */
export async function createDatabaseRuntimeWithCleanup<T>(
  create: (register: (cleanup: DatabaseRuntimeCleanup) => void) => Promise<T>,
): Promise<T> {
  const cleanups: DatabaseRuntimeCleanup[] = [];
  try {
    return await create((cleanup) => { cleanups.push(cleanup); });
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    for (const cleanup of cleanups.reverse()) {
      try { await cleanup(); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
    }
    if (cleanupErrors.length > 0) {
      // Keep the initialization failure as the primary error; cleanup errors are only diagnostic.
      (error as Error & { cleanupErrors?: unknown[] }).cleanupErrors = cleanupErrors;
    }
    throw error;
  }
}

async function pingPostgresKysely(label: string, db: Kysely<any>, expectedSchema: string): Promise<void> {
  const result = await sql<{ schema: string | null }>`SELECT current_schema() AS schema`.execute(db);
  const actualSchema = result.rows[0]?.schema ?? null;
  if (actualSchema !== expectedSchema) throw new Error(`PostgreSQL ${label} search_path resolved to ${actualSchema ?? "<none>"}; expected ${expectedSchema}`);
  await sql`SELECT 1 AS ok`.execute(db);
}

async function migrateTemporarySchema(connectionString: string, schema: string, migrations: PostgresMigration[]): Promise<void> {
  const pool = await createPgPool(connectionString, schema);
  try { await applyPostgresMigrations(pool, migrations); } finally { await pool.end(); }
}

export async function createDatabaseRuntime(config: AppConfig, log: pino.Logger): Promise<DatabaseRuntime> {
  return createDatabaseRuntimeWithCleanup((register) => createDatabaseRuntimeUnsafe(config, log, register));
}

async function createDatabaseRuntimeUnsafe(
  config: AppConfig,
  log: pino.Logger,
  register: (cleanup: DatabaseRuntimeCleanup) => void,
): Promise<DatabaseRuntime> {
  const usePostgres = config.DB_DRIVER === "postgres";
  const sqlite = usePostgres ? undefined : createSqliteDatabase(config.DATABASE_PATH);
  if (sqlite) register(() => { sqlite.close(); });
  const ticketSqlite = usePostgres ? undefined : createSqliteDatabase(config.TICKET_DATABASE_PATH);
  if (ticketSqlite) register(() => { ticketSqlite.close(); });
  const messageLogSqlite = usePostgres ? undefined : createSqliteDatabase(config.MESSAGE_LOG_DB_PATH);
  if (messageLogSqlite) register(() => { messageLogSqlite.close(); });
  messageLogSqlite?.defaultSafeIntegers(true);
  const messageAttachmentStoreSqlite = usePostgres ? undefined : createSqliteDatabase(config.MESSAGE_ATTACHMENT_STORE_DB_PATH);
  if (messageAttachmentStoreSqlite) register(() => { messageAttachmentStoreSqlite.close(); });
  const vcTimeSqlite = usePostgres ? undefined : createSqliteDatabase(config.VC_TIME_DATABASE_PATH);
  if (vcTimeSqlite) register(() => { vcTimeSqlite.close(); });
  const aiHistorySqlite = usePostgres ? undefined : createSqliteDatabase(config.AI_HISTORY_DATABASE_PATH);
  if (aiHistorySqlite) register(() => { aiHistorySqlite.close(); });
  const automodSqlite = usePostgres ? undefined : createSqliteDatabase(config.AUTOMODERATION_DATABASE_PATH);
  if (automodSqlite) register(() => { automodSqlite.close(); });
  if (!usePostgres) {
    ensureTicketDatabaseSchema(ticketSqlite!); ensureVcTimeSchema(vcTimeSqlite!); ensurePacchiSchemaOnce(sqlite!);
    ensureAiR18UserSettingsSchema(sqlite!); ensureAiHistorySchema(aiHistorySqlite!); ensureAutomoderationSchema(automodSqlite!);
    prepareMessageLogsDatabase(messageLogSqlite!); prepareMessageAttachmentStore(messageAttachmentStoreSqlite!);
  }
  const db = usePostgres ? createPostgresMainKysely({ connectionString: config.DATABASE_URL!, schema: config.POSTGRES_MAIN_SCHEMA }) : createKysely(sqlite!);
  register(() => db.destroy());
  const ticketDb = usePostgres ? createPostgresTicketKysely({ connectionString: config.DATABASE_URL!, schema: config.POSTGRES_TICKET_SCHEMA }) : createTicketKysely(ticketSqlite!);
  register(() => ticketDb.destroy());
  const aiHistoryDb = usePostgres ? createPostgresAiHistoryKysely({ connectionString: config.DATABASE_URL!, schema: config.POSTGRES_AI_HISTORY_SCHEMA }) : createAiHistoryKysely(aiHistorySqlite!);
  register(() => aiHistoryDb.destroy());
  const automodDb = usePostgres ? createPostgresAutomoderationKysely({ connectionString: config.DATABASE_URL!, schema: config.POSTGRES_AUTOMOD_SCHEMA }) : createAutomoderationKysely(automodSqlite!);
  register(() => automodDb.destroy());
  const messageLogPgPool = usePostgres ? await createPgPool(config.DATABASE_URL!, config.POSTGRES_MESSAGE_LOG_SCHEMA) : undefined;
  if (messageLogPgPool) register(() => messageLogPgPool.end());
  const mainPgPool = usePostgres ? await createPgPool(config.DATABASE_URL!, config.POSTGRES_MAIN_SCHEMA) : undefined;
  if (mainPgPool) register(() => mainPgPool.end());
  if (mainPgPool) await applyPostgresMigrations(mainPgPool, [
    { version: 1, name: "main_core_initial", apply: ensurePostgresMainSchema },
    { version: 2, name: "game_deals_initial", apply: (pool) => ensurePostgresGameDealSchema(pool, config.POSTGRES_MAIN_SCHEMA) },
    { version: 3, name: "ai_provider_initial", apply: (pool) => ensurePostgresAiProviderSchema(pool, config.POSTGRES_MAIN_SCHEMA) },
    { version: 4, name: "senryu_initial", apply: ensurePostgresSenryuSchema },
    { version: 5, name: "lol_watcher_initial", apply: ensurePostgresLolWatcherSchema },
    { version: 6, name: "pacchi_initial", apply: ensurePostgresPacchiSchema },
    { version: 7, name: "polls_state_revision", apply: async (pool) => { await pool.query("ALTER TABLE polls ADD COLUMN IF NOT EXISTS state_revision bigint NOT NULL DEFAULT 0"); } },
    { version: 8, name: "guild_settings_revision", apply: async (pool) => { await pool.query("ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 0"); } },
  ]);
  if (usePostgres) {
    await migrateTemporarySchema(config.DATABASE_URL!, config.POSTGRES_TICKET_SCHEMA, [{ version: 1, name: "ticket_initial", apply: ensurePostgresTicketDatabaseSchema }]);
    await migrateTemporarySchema(config.DATABASE_URL!, config.POSTGRES_AI_HISTORY_SCHEMA, [{ version: 1, name: "ai_history_initial", apply: ensurePostgresAiHistorySchema }]);
    await migrateTemporarySchema(config.DATABASE_URL!, config.POSTGRES_AUTOMOD_SCHEMA, [{ version: 1, name: "automod_initial", apply: ensurePostgresAutomoderationSchema }]);
    await migrateTemporarySchema(config.DATABASE_URL!, config.POSTGRES_REMINDER_SCHEMA, [{ version: 1, name: "reminder_initial", apply: ensurePostgresReminderSchema }]);
  }
  const vcTimePgPool = usePostgres ? await createPgPool(config.DATABASE_URL!, config.POSTGRES_VC_TIME_SCHEMA) : undefined;
  if (vcTimePgPool) register(() => vcTimePgPool.end());
  if (vcTimePgPool) await applyPostgresMigrations(vcTimePgPool, [{ version: 1, name: "vc_time_sessions_initial", apply: ensurePostgresVcTimeSchema }, { version: 2, name: "vc_temp_initial", apply: ensurePostgresVcTempSchema }]);
  const messageAttachmentPgPool = usePostgres ? await createPgPool(config.DATABASE_URL!, config.POSTGRES_MESSAGE_ATTACHMENT_SCHEMA) : undefined;
  if (messageAttachmentPgPool) register(() => messageAttachmentPgPool.end());
  if (messageLogPgPool) await applyPostgresMigrations(messageLogPgPool, [{ version: 1, name: "message_logs_initial", apply: ensurePostgresMessageLogsSchema }]);
  if (messageAttachmentPgPool) await applyPostgresMigrations(messageAttachmentPgPool, [{ version: 1, name: "message_attachments_initial", apply: prepareMessageAttachmentStorePostgres }]);
  if (usePostgres) {
    await pingPostgresKysely("main", db, config.POSTGRES_MAIN_SCHEMA); await pingPostgresKysely("ticket", ticketDb, config.POSTGRES_TICKET_SCHEMA);
    await pingPostgresKysely("aiHistory", aiHistoryDb, config.POSTGRES_AI_HISTORY_SCHEMA); await pingPostgresKysely("automod", automodDb, config.POSTGRES_AUTOMOD_SCHEMA);
  } else {
    for (const handle of [sqlite!, ticketSqlite!, messageLogSqlite!, messageAttachmentStoreSqlite!, vcTimeSqlite!, aiHistorySqlite!, automodSqlite!]) handle.prepare("SELECT 1").get();
  }
  log.info({ main: config.DATABASE_PATH, ticket: config.TICKET_DATABASE_PATH, messageLog: config.MESSAGE_LOG_DB_PATH, messageAttachmentStore: config.MESSAGE_ATTACHMENT_STORE_DB_PATH, vcTime: config.VC_TIME_DATABASE_PATH, aiHistory: config.AI_HISTORY_DATABASE_PATH, automoderation: config.AUTOMODERATION_DATABASE_PATH, reminderLazy: config.REMINDER_DATABASE_PATH }, usePostgres ? "database connection ok (postgres runtime)" : "sqlite connection ok");
  if (!usePostgres) {
    ensureSqliteAiProviderSchema(sqlite!);
    const beforeV = getSqliteUserVersion(sqlite!);
    const applied = applyPendingSqliteMigrations(sqlite!, { beforeApplyVersion(version, mainDb) {
      if (version === 10) copyTicketDataFromMainToTicketDb(mainDb, ticketSqlite!);
      if (version === 11) copyAiHistoryFromMainToDedicatedDb(mainDb, aiHistorySqlite!);
      if (version === 12) { const reminder = createSqliteDatabase(config.REMINDER_DATABASE_PATH); try { copyRemindersFromMainToReminderDb(mainDb, reminder); } finally { reminder.close(); } }
    }});
    const afterV = getSqliteUserVersion(sqlite!);
    log.info(applied.length ? { applied, userVersion: afterV, previousVersion: beforeV, dbDriver: config.DB_DRIVER } : { userVersion: afterV, dbDriver: config.DB_DRIVER }, applied.length ? "sqlite migrations applied" : "sqlite schema up to date (no pending migrations)");
  } else log.info({ mainSchema: config.POSTGRES_MAIN_SCHEMA, ticketSchema: config.POSTGRES_TICKET_SCHEMA, messageLogSchema: config.POSTGRES_MESSAGE_LOG_SCHEMA, vcTimeSchema: config.POSTGRES_VC_TIME_SCHEMA }, "sqlite migrations skipped because runtime databases are postgres");
  const aiRouter = new AiProviderRouter(config, mainPgPool ? new PostgresAiProviderSettingsRepository(mainPgPool) : new SqliteAiProviderSettingsRepository(sqlite!), mainPgPool ? new PostgresAiProviderBudgetRepository(mainPgPool) : new SqliteAiProviderBudgetRepository(sqlite!));
  return { usePostgres, sqlite, ticketSqlite, messageLogSqlite, messageAttachmentStoreSqlite, vcTimeSqlite, aiHistorySqlite, automodSqlite, db, ticketDb, aiHistoryDb, automodDb, messageLogPgPool, mainPgPool, vcTimePgPool, messageAttachmentPgPool, aiRouter };
}

export async function closeDatabaseRuntime(runtime: DatabaseRuntime): Promise<void> {
  const errors: unknown[] = [];
  const close = async (operation: () => void | Promise<void>) => {
    try { await operation(); } catch (error) { errors.push(error); }
  };
  await close(() => runtime.db.destroy()); await close(() => runtime.ticketDb.destroy()); await close(() => runtime.aiHistoryDb.destroy()); await close(() => runtime.automodDb.destroy());
  if (runtime.messageLogPgPool) await close(() => runtime.messageLogPgPool!.end());
  if (runtime.mainPgPool) await close(() => runtime.mainPgPool!.end());
  if (runtime.vcTimePgPool) await close(() => runtime.vcTimePgPool!.end());
  if (runtime.messageAttachmentPgPool) await close(() => runtime.messageAttachmentPgPool!.end());
  await close(() => destroyReminderDb());
  if (runtime.messageLogSqlite) await close(() => { runtime.messageLogSqlite!.close(); });
  if (runtime.messageAttachmentStoreSqlite) await close(() => { runtime.messageAttachmentStoreSqlite!.close(); });
  if (runtime.vcTimeSqlite) await close(() => { runtime.vcTimeSqlite!.close(); });
  if (runtime.ticketSqlite) await close(() => { runtime.ticketSqlite!.close(); });
  if (runtime.aiHistorySqlite) await close(() => { runtime.aiHistorySqlite!.close(); });
  if (runtime.automodSqlite) await close(() => { runtime.automodSqlite!.close(); });
  if (runtime.sqlite) await close(() => { runtime.sqlite!.close(); });
  if (errors.length > 0) throw errors[0];
}
