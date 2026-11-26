import { ensurePostgresLinkExpansionSchema } from "../features/linkPreviews/shared/linkExpansionRepository.js";
import { sql, type Kysely } from "kysely";
import type { Pool } from "pg";
import type pino from "pino";
import type { AppConfig } from "../core/config.js";
import {
  createPostgresAiHistoryKysely,
  createPostgresAutomoderationKysely,
  createPostgresMainKysely,
  createPostgresTicketKysely,
} from "../core/db/kysely.js";
import { migrateLegacyBooleanColumns } from "../core/db/legacyBooleanColumns.js";
import { LEGACY_FLAG_COLUMNS } from "../core/db/legacyFlagColumns.js";
import { createPgPool } from "../core/db/postgres.js";
import { ensurePostgresMainSchema } from "../core/db/postgresMainSchema.js";
import { applyPostgresMigrations, type PostgresMigration } from "../core/db/postgresMigrations.js";
import type { AiHistoryDatabase, AutomoderationDatabase, Database, TicketDatabase } from "../core/db/types.js";
import { ensurePostgresRuntimeUptimeSchema } from "./runtimeUptime.js";
import { ensurePostgresAiHistorySchema } from "../features/ai/aiHistorySchema.js";
import { ensurePostgresAiProviderSchema, migratePostgresAiProviderOpenRouterBudgetSchema, migratePostgresAiProviderOpenRouterSchema, PostgresAiProviderBudgetRepository, PostgresAiProviderSettingsRepository } from "../features/ai/postgresAiProviderRepository.js";
import { AiProviderRouter } from "../features/ai/aiProviderRouter.js";
import { dropPostgresSteamAppListTables, ensurePostgresGameDealSchema } from "../features/gameDeals/postgresGameDealRepository.js";
import { ensurePostgresLolWatcherSchema } from "../features/lolWatcher/lolWatcher.repository.js";
import { migratePostgresAnonymousSurveyFeedback } from "../features/anonymousSurvey/surveySchema.js";
import { migratePostgresGithubPreviewSupport, migratePostgresInstagramPreviewSupport, migratePostgresPreviewTranslationStates, migratePostgresSteamPreviewSupport, migratePostgresTikTokPreviewSupport, migratePostgresWebPreviewSupport } from "../features/linkPreviews/shared/previewState.repository.js";
import { ensurePostgresPreviewSummarySchema } from "../features/linkPreviews/shared/previewSummary.repository.js";
import {
  ensurePostgresSteamExchangeRateSchema,
} from "../features/steam/steamExchangeRateRepository.js";
import { prepareMessageAttachmentStorePostgres } from "../features/messageLog/messageAttachmentArchive.js";
import { ensurePostgresMessageLogsSchema } from "../features/messageLog/messageLogsSchema.js";
import { ensurePostgresAutomoderationSchema } from "../features/moderation/automodSchema.js";
import { ensurePostgresPacchiSchema, migratePostgresPacchiBooleanColumns } from "../features/pacchi/pacchi.schema.js";
import { destroyReminderDb } from "../features/reminders/reminderDb.js";
import { ensurePostgresReminderSchema } from "../features/reminders/reminderDbSchema.js";
import { ensurePostgresSenryuSchema } from "../features/senryu/senryu.repository.js";
import { ensurePostgresTicketDatabaseSchema } from "../features/tickets/ticketDbSchema.js";
import { ensurePostgresVcTempSchema } from "../features/vc/vcTempPersistence.js";
import { ensurePostgresVcTimeSchema } from "../features/vc/vcTimeSchema.js";
import { ensurePostgresYouTubeWatcherSchema, migratePostgresYouTubeWatcherDurableMedia } from "../features/youtubeWatcher/youtubeWatcher.repository.js";
import { migratePostgresYouTubeVideoCacheReferences } from "../features/youtube/youtubeVideoCache.repository.js";
import { ensurePostgresBokeruSchema } from "../features/bokeru/bokeruRepository.js";

export type DatabaseRuntime = {
  db: Kysely<Database>;
  ticketDb: Kysely<TicketDatabase>;
  aiHistoryDb: Kysely<AiHistoryDatabase>;
  automodDb: Kysely<AutomoderationDatabase>;
  messageLogPgPool: Pool;
  mainPgPool: Pool;
  vcTimePgPool: Pool;
  messageAttachmentPgPool: Pool;
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
  const db = createPostgresMainKysely({ connectionString: config.DATABASE_URL, schema: config.POSTGRES_MAIN_SCHEMA });
  register(() => db.destroy());
  const ticketDb = createPostgresTicketKysely({ connectionString: config.DATABASE_URL, schema: config.POSTGRES_TICKET_SCHEMA });
  register(() => ticketDb.destroy());
  const aiHistoryDb = createPostgresAiHistoryKysely({ connectionString: config.DATABASE_URL, schema: config.POSTGRES_AI_HISTORY_SCHEMA });
  register(() => aiHistoryDb.destroy());
  const automodDb = createPostgresAutomoderationKysely({ connectionString: config.DATABASE_URL, schema: config.POSTGRES_AUTOMOD_SCHEMA });
  register(() => automodDb.destroy());

  const messageLogPgPool = await createPgPool(config.DATABASE_URL, config.POSTGRES_MESSAGE_LOG_SCHEMA);
  register(() => messageLogPgPool.end());
  const mainPgPool = await createPgPool(config.DATABASE_URL, config.POSTGRES_MAIN_SCHEMA);
  register(() => mainPgPool.end());
  const vcTimePgPool = await createPgPool(config.DATABASE_URL, config.POSTGRES_VC_TIME_SCHEMA);
  register(() => vcTimePgPool.end());
  const messageAttachmentPgPool = await createPgPool(config.DATABASE_URL, config.POSTGRES_MESSAGE_ATTACHMENT_SCHEMA);
  register(() => messageAttachmentPgPool.end());

  await applyPostgresMigrations(mainPgPool, [
    { version: 1, name: "main_core_initial", apply: ensurePostgresMainSchema },
    { version: 2, name: "game_deals_initial", apply: (pool) => ensurePostgresGameDealSchema(pool, config.POSTGRES_MAIN_SCHEMA) },
    { version: 3, name: "ai_provider_initial", apply: (pool) => ensurePostgresAiProviderSchema(pool, config.POSTGRES_MAIN_SCHEMA) },
    { version: 4, name: "senryu_initial", apply: ensurePostgresSenryuSchema },
    { version: 5, name: "lol_watcher_initial", apply: ensurePostgresLolWatcherSchema },
    { version: 6, name: "pacchi_initial", apply: ensurePostgresPacchiSchema },
    { version: 7, name: "polls_state_revision", apply: async (pool) => { await pool.query("ALTER TABLE polls ADD COLUMN IF NOT EXISTS state_revision bigint NOT NULL DEFAULT 0"); } },
    { version: 8, name: "guild_settings_revision", apply: async (pool) => { await pool.query("ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 0"); } },
    { version: 9, name: "vx_twitter_preview_states", apply: async (pool) => { await pool.query(`
      CREATE TABLE IF NOT EXISTS vx_twitter_preview_states (
        message_id text PRIMARY KEY, guild_id text NOT NULL, channel_id text NOT NULL, tweet_url text NOT NULL,
        tweet jsonb NOT NULL, translations jsonb NOT NULL, expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_vx_twitter_preview_states_expires ON vx_twitter_preview_states (expires_at);
    `); } },
    { version: 10, name: "youtube_watcher_initial", apply: ensurePostgresYouTubeWatcherSchema },
    { version: 11, name: "pacchi_boolean_columns", apply: migratePostgresPacchiBooleanColumns },
    { version: 12, name: "drop_steam_app_list_tables", apply: (pool) => dropPostgresSteamAppListTables(pool, config.POSTGRES_MAIN_SCHEMA) },
    { version: 13, name: "youtube_watcher_durable_media", apply: migratePostgresYouTubeWatcherDurableMedia },
    { version: 14, name: "youtube_video_cache_references", apply: migratePostgresYouTubeVideoCacheReferences },
    { version: 15, name: "preview_translation_states", apply: migratePostgresPreviewTranslationStates },
    { version: 16, name: "steam_link_preview", apply: async (pool) => {
      await migratePostgresSteamPreviewSupport(pool);
      await ensurePostgresSteamExchangeRateSchema(pool);
    } },
    { version: 17, name: "runtime_uptime_sessions", apply: ensurePostgresRuntimeUptimeSchema },
    { version: 18, name: "github_link_preview", apply: migratePostgresGithubPreviewSupport },
    { version: 19, name: "tiktok_link_preview", apply: migratePostgresTikTokPreviewSupport },
    { version: 20, name: "anonymous_survey_feedback", apply: migratePostgresAnonymousSurveyFeedback },
    { version: 21, name: "instagram_link_preview", apply: migratePostgresInstagramPreviewSupport },
    { version: 22, name: "bokeru_initial", apply: ensurePostgresBokeruSchema },
    { version: 23, name: "link_expansion_tracking", apply: ensurePostgresLinkExpansionSchema },
    { version: 24, name: "web_link_preview", apply: async (pool) => {
      await migratePostgresWebPreviewSupport(pool);
      await ensurePostgresPreviewSummarySchema(pool);
    } },
    { version: 25, name: "ai_provider_openrouter", apply: (pool) => migratePostgresAiProviderOpenRouterSchema(pool, config.POSTGRES_MAIN_SCHEMA) },
    { version: 26, name: "ai_provider_openrouter_budget", apply: (pool) => migratePostgresAiProviderOpenRouterBudgetSchema(pool, config.POSTGRES_MAIN_SCHEMA) },
    // version 11 で漏れていた、SQLite 由来の bigint フラグ列を boolean に直す。
    { version: 27, name: "legacy_flag_columns", apply: (pool) => migrateLegacyBooleanColumns(pool, LEGACY_FLAG_COLUMNS) },
  ]);
  await migrateTemporarySchema(config.DATABASE_URL, config.POSTGRES_TICKET_SCHEMA, [{ version: 1, name: "ticket_initial", apply: ensurePostgresTicketDatabaseSchema }]);
  await migrateTemporarySchema(config.DATABASE_URL, config.POSTGRES_AI_HISTORY_SCHEMA, [{ version: 1, name: "ai_history_initial", apply: ensurePostgresAiHistorySchema }]);
  await migrateTemporarySchema(config.DATABASE_URL, config.POSTGRES_AUTOMOD_SCHEMA, [{ version: 1, name: "automod_initial", apply: ensurePostgresAutomoderationSchema }]);
  await migrateTemporarySchema(config.DATABASE_URL, config.POSTGRES_REMINDER_SCHEMA, [{ version: 1, name: "reminder_initial", apply: ensurePostgresReminderSchema }]);
  await applyPostgresMigrations(vcTimePgPool, [
    { version: 1, name: "vc_time_sessions_initial", apply: ensurePostgresVcTimeSchema },
    { version: 2, name: "vc_temp_initial", apply: ensurePostgresVcTempSchema },
  ]);
  await applyPostgresMigrations(messageLogPgPool, [{ version: 1, name: "message_logs_initial", apply: ensurePostgresMessageLogsSchema }]);
  await applyPostgresMigrations(messageAttachmentPgPool, [{ version: 1, name: "message_attachments_initial", apply: prepareMessageAttachmentStorePostgres }]);

  await pingPostgresKysely("main", db, config.POSTGRES_MAIN_SCHEMA);
  await pingPostgresKysely("ticket", ticketDb, config.POSTGRES_TICKET_SCHEMA);
  await pingPostgresKysely("aiHistory", aiHistoryDb, config.POSTGRES_AI_HISTORY_SCHEMA);
  await pingPostgresKysely("automod", automodDb, config.POSTGRES_AUTOMOD_SCHEMA);

  const aiRouter = new AiProviderRouter(
    config,
    new PostgresAiProviderSettingsRepository(mainPgPool),
    new PostgresAiProviderBudgetRepository(mainPgPool),
  );
  log.debug({
    mainSchema: config.POSTGRES_MAIN_SCHEMA,
    ticketSchema: config.POSTGRES_TICKET_SCHEMA,
    messageLogSchema: config.POSTGRES_MESSAGE_LOG_SCHEMA,
    vcTimeSchema: config.POSTGRES_VC_TIME_SCHEMA,
  }, "database connection ok (postgres runtime)");
  log.info("Database runtime initialized successfully.");
  return { db, ticketDb, aiHistoryDb, automodDb, messageLogPgPool, mainPgPool, vcTimePgPool, messageAttachmentPgPool, aiRouter };
}

export async function closeDatabaseRuntime(runtime: DatabaseRuntime): Promise<void> {
  const errors: unknown[] = [];
  const close = async (operation: () => void | Promise<void>) => {
    try { await operation(); } catch (error) { errors.push(error); }
  };
  await close(() => runtime.db.destroy());
  await close(() => runtime.ticketDb.destroy());
  await close(() => runtime.aiHistoryDb.destroy());
  await close(() => runtime.automodDb.destroy());
  await close(() => runtime.messageLogPgPool.end());
  await close(() => runtime.mainPgPool.end());
  await close(() => runtime.vcTimePgPool.end());
  await close(() => runtime.messageAttachmentPgPool.end());
  await close(() => destroyReminderDb());
  if (errors.length > 0) throw errors[0];
}
