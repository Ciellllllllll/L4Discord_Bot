import { execSync } from "node:child_process";

if (process.platform === "win32") {
  try {
    execSync("cmd /c chcp 65001>nul", { stdio: "ignore", windowsHide: true });
  } catch {}
}

import { PostgresVcRankingRepository } from "./adapters/legacyDb/postgresVcRankingRepository.js";
import { CLIENT_INTENT_NAMES, createDiscordClient } from "./bot/createClient.js";
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
import { bindPostgresSenryuRepository } from "./features/senryu/senryu.message-handler.js";
import { VcTemporaryChannelManager } from "./features/vc/vcTemporaryChannelManager.js";
import { createPostgresVcTempPersistence } from "./features/vc/vcTempPersistence.js";

let mainStarted = false;

async function main(): Promise<void> {
  if (mainStarted) {
    console.error("main() は既に起動済みです。二重起動を無視します。");
    return;
  }
  mainStarted = true;

  const config = loadConfig();
  const log = createLogger(config);
  process.on("unhandledRejection", (reason) => {
    log.error({ err: reason }, "unhandled promise rejection");
  });
  process.on("uncaughtException", (err) => {
    log.fatal({ err }, "uncaught exception; exiting");
    process.exit(1);
  });
  log.debug(
    {
      botProfile: config.BOT_PROFILE,
      effectiveBotVersion: config.BOT_VERSION,
      guildId: config.GUILD_ID,
      messageAttachmentFilesDir: config.MESSAGE_ATTACHMENT_FILES_DIR,
      messageAttachmentArchiveEnabled: config.MESSAGE_ATTACHMENT_ARCHIVE_ENABLED,
      gameDealChannelId: config.GAME_DEAL_CHANNEL_ID ?? null,
      gameDealNotifyRoleId: config.GAME_DEAL_NOTIFY_ROLE_ID ?? null,
      vcRankingTimeZone: config.VC_TIME_RANKING_TIMEZONE,
      release: getReleaseBundleForLog(),
    },
    "config loaded (BOT_VERSION = code default or env override; release bundle from TypeScript)",
  );
  log.info("Configuration loaded successfully.");

  const runtime = await createDatabaseRuntime(config, log);
  const {
    db, ticketDb, aiHistoryDb, automodDb, messageLogPgPool, mainPgPool,
    vcTimePgPool, messageAttachmentPgPool, aiRouter,
  } = runtime;

  const client = createDiscordClient();
  log.debug({ intents: CLIENT_INTENT_NAMES }, "discord client created");
  log.info("Discord client created successfully.");
  const vcTemp = new VcTemporaryChannelManager(
    log,
    client,
    config,
    createPostgresVcTempPersistence(vcTimePgPool),
  );
  bindPostgresSenryuRepository(mainPgPool);

  const ctx: BotContext = {
    config,
    db,
    ticketDb,
    messageLogPgPool,
    messageAttachmentPgPool,
    vcTimePgPool,
    aiHistoryDb,
    automodDb,
    log,
    client,
    aiRouter,
    mainPgPool,
    vcRanking: new PostgresVcRankingRepository(vcTimePgPool, config.VC_TIME_RANKING_TIMEZONE),
    vcTemp,
  };
  log.debug("repositories: PostgreSQL schemas selected for tickets, message log, attachments, VC, AI history, automoderation, reminders");

  try {
    await copyAutomodFromGuildSettingsIfMissing(ctx, config.GUILD_ID);
  } catch (e) {
    log.warn({ err: e }, "automod migration from guild_settings skipped or failed");
  }

  const runtimeHandlers = await initializeRuntimeHandlersWithCleanup({
    registerHandlers: () => registerRuntimeHandlers(ctx),
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
    let exitCode = 0;
    try {
      await shutdownWithCleanup({
        shutdownHandlers: () => runtimeHandlers.shutdown(),
        closeDatabase: () => closeDatabaseRuntime(runtime),
        warn: (err, message) => log.warn({ err }, message),
      });
    } catch (err) {
      exitCode = 1;
      log.error({ err }, "shutdown failed");
    } finally {
      process.exit(exitCode);
    }
  })();
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
