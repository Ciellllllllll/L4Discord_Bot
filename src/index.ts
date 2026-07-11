import { execSync } from "node:child_process";
import "dotenv/config";

if (process.platform === "win32") {
  try {
    execSync("cmd /c chcp 65001>nul", { stdio: "ignore", windowsHide: true });
  } catch {}
}

import { PostgresVcRankingRepository } from "./adapters/legacyDb/postgresVcRankingRepository.js";
import { SqliteVcRankingRepository } from "./adapters/legacyDb/sqliteVcRankingRepository.js";
import { createDiscordClient } from "./bot/createClient.js";
import type { BotContext } from "./bot/context.js";
import { closeDatabaseRuntime, createDatabaseRuntime } from "./bot/databaseRuntime.js";
import { registerRuntimeHandlers } from "./bot/registerRuntimeHandlers.js";
import { initializeRuntimeHandlersWithCleanup } from "./bot/registerWithCleanup.js";
import { loginWithCleanup } from "./bot/loginWithCleanup.js";
import { shutdownWithCleanup } from "./bot/shutdownWithCleanup.js";
import { loadConfig } from "./core/config.js";
import { createLogger } from "./core/logger.js";
import { getReleaseBundleForLog } from "./core/releaseVersions.js";
import { copyAutomodFromGuildSettingsIfMissing } from "./features/moderation/copyAutomodFromGuildSettings.js";
import { bindPostgresSenryuRepository, bindSenryuRepository } from "./features/senryu/senryu.message-handler.js";
import { VcTemporaryChannelManager } from "./features/vc/vcTemporaryChannelManager.js";
import { createPostgresVcTempPersistence, createSqliteVcTempPersistence } from "./features/vc/vcTempPersistence.js";

let mainStarted = false;

async function main(): Promise<void> {
  if (mainStarted) {
    console.error("main() は既に起動済みです。二重起動を無視します。");
    return;
  }
  mainStarted = true;

  const config = loadConfig();
  const log = createLogger(config);
  log.info(
    {
      botProfile: config.BOT_PROFILE,
      dbDriver: config.DB_DRIVER,
      effectiveBotVersion: config.BOT_VERSION,
      guildId: config.GUILD_ID,
      databasePath: config.DATABASE_PATH,
      messageLogDbPath: config.MESSAGE_LOG_DB_PATH,
      messageAttachmentStoreDbPath: config.MESSAGE_ATTACHMENT_STORE_DB_PATH,
      messageAttachmentFilesDir: config.MESSAGE_ATTACHMENT_FILES_DIR,
      messageAttachmentArchiveEnabled: config.MESSAGE_ATTACHMENT_ARCHIVE_ENABLED,
      gameDealChannelId: config.GAME_DEAL_CHANNEL_ID ?? null,
      gameDealNotifyRoleId: config.GAME_DEAL_NOTIFY_ROLE_ID ?? null,
      ticketDbPath: config.TICKET_DATABASE_PATH,
      vcTimeDbPath: config.VC_TIME_DATABASE_PATH,
      vcRankingTimeZone: config.VC_TIME_RANKING_TIMEZONE,
      aiHistoryDbPath: config.AI_HISTORY_DATABASE_PATH,
      automoderationDbPath: config.AUTOMODERATION_DATABASE_PATH,
      reminderDbPath: config.REMINDER_DATABASE_PATH,
      release: getReleaseBundleForLog(),
    },
    "config loaded (BOT_VERSION = code default or env override; release bundle from TypeScript)",
  );

  const runtime = await createDatabaseRuntime(config, log);
  const {
    sqlite, ticketSqlite, messageLogSqlite, messageAttachmentStoreSqlite, vcTimeSqlite,
    aiHistorySqlite, automodSqlite, db, ticketDb, aiHistoryDb, automodDb, messageLogPgPool, mainPgPool,
    vcTimePgPool, messageAttachmentPgPool, aiRouter,
  } = runtime;

  const client = createDiscordClient();
  log.info(
    {
      intents: [
        "Guilds",
        "GuildMessages",
        "MessageContent",
        "GuildMembers",
        "GuildModeration",
        "GuildVoiceStates",
        "DirectMessages",
      ],
    },
    "discord client created",
  );
  const vcTemp = new VcTemporaryChannelManager(
    log,
    client,
    config,
    vcTimePgPool ? createPostgresVcTempPersistence(vcTimePgPool) : createSqliteVcTempPersistence(sqlite!),
  );
  if (mainPgPool) bindPostgresSenryuRepository(mainPgPool);
  else bindSenryuRepository(sqlite!);

  const ctx: BotContext = {
    config,
    db,
    sqlite,
    ticketDb,
    ticketSqlite,
    messageLogSqlite,
    messageLogPgPool: messageLogPgPool ?? undefined,
    messageAttachmentStoreSqlite,
    messageAttachmentPgPool: messageAttachmentPgPool ?? undefined,
    vcTimeSqlite,
    aiHistoryDb,
    aiHistorySqlite,
    automodDb,
    automodSqlite,
    log,
    client,
    aiRouter,
    gameDealPgPool: mainPgPool ?? undefined,
    vcRanking: vcTimePgPool
      ? new PostgresVcRankingRepository(vcTimePgPool, config.VC_TIME_RANKING_TIMEZONE)
      : new SqliteVcRankingRepository(vcTimeSqlite!, config.VC_TIME_RANKING_TIMEZONE),
    vcTemp,
  };
  log.info(
    config.DB_DRIVER === "postgres"
      ? "repositories: PostgreSQL schemas selected for tickets, message log, attachments, VC, AI history, automoderation, reminders"
      : "repositories: tickets (ticket.db), message log (message.db), VC ranking (vc_time.db), AI history (AI_History.db), automoderation (Automoderation.db), reminders (reminder.db, on first use)",
  );

  try {
    await copyAutomodFromGuildSettingsIfMissing(ctx, config.GUILD_ID);
  } catch (e) {
    log.warn({ err: e }, "automod migration from guild_settings skipped or failed");
  }

  const runtimeHandlers = await initializeRuntimeHandlersWithCleanup({
    registerHandlers: () => registerRuntimeHandlers(ctx, { vcTimePgPool }),
    closeDatabase: () => closeDatabaseRuntime(runtime),
    destroyClient: () => client.destroy(),
    warn: (err, message) => log.warn({ err }, message),
  });
  log.info("connecting to Discord (login)…");
  try {
    await loginWithCleanup({
      login: () => client.login(config.DISCORD_TOKEN),
      shutdownHandlers: () => runtimeHandlers.shutdown(),
      closeDatabase: () => closeDatabaseRuntime(runtime),
      warn: (err, message) => log.warn({ err }, message),
    });
  } catch (err) {
    if (err instanceof Error && (err as { code?: unknown }).code === "TokenInvalid") {
      throw new Error(
        "DISCORD_TOKEN was rejected by Discord. Regenerate the bot token in Discord Developer Portal > Bot > Reset Token, paste only the raw token into .env, then restart the bot.",
        { cause: err },
      );
    }
    throw err;
  }
  log.info("discord login call returned (awaiting clientReady for full readiness)");

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = () => shutdownPromise ??= (async () => {
    log.info("shutting down");
    await shutdownWithCleanup({
      shutdownHandlers: () => runtimeHandlers.shutdown(),
      closeDatabase: () => closeDatabaseRuntime(runtime),
      warn: (err, message) => log.warn({ err }, message),
    });
    process.exit(0);
  })();
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
