import type { BotContext } from "./context.js";
import { StartupReport } from "./startupReport.js";
import { syncGuildApplicationCommands } from "./syncCommands.js";
import { startPresence } from "./presence.js";
import { startRuntimeUptime } from "./runtimeUptime.js";
import {
  shouldStartYouTubeVideoCacheMaintenance,
  startClientReadyBackgroundServices,
  startPreviewStateCleanup,
} from "./clientReadyServices.js";
import type { createRuntimeResourceLifecycle } from "./runtimeLifecycle.js";
import type { UtilitiesMessageBundle } from "../features/utilities/utilitiesMessage.js";
import { reconcilePanelsForGuild } from "../features/panelHub/panelService.js";
import { restoreModmailUiState } from "../features/modmail/modmailRestore.js";
import { reconcileExecutionFlows } from "../features/execution/executionFlow.js";
import { reconcileTimeoutExtendFlows } from "../features/execution/timeoutExtendFlow.js";
import { reconcileWerewolfGames } from "../features/werewolf/werewolfGame.js";
import { reconcileVcTimeSessionsAtReadyPostgres } from "../features/vc/voiceSessionTracker.js";
import { startReminderScheduler, stopReminderScheduler } from "../features/reminders/reminderScheduler.js";
import { finalizeDueBokeruRounds } from "../features/bokeru/bokeru.js";
import { startGameDealWatcher } from "../features/gameDeals/gameDealWatcher.js";
import { startSteamExchangeRateUpdater } from "../features/steam/steamExchangeRateUpdater.js";
import { SteamExchangeRateRepository } from "../features/steam/steamExchangeRateRepository.js";
import { startLolWatcher } from "../features/lolWatcher/lolWatcher.watcher.js";
import { startYouTubeWatcher } from "../features/youtubeWatcher/youtubeWatcher.watcher.js";
import { createYouTubeVideoCacheMaintenanceForContext } from "../features/youtube/youtubeVideoCacheMaintenance.js";
import { deleteExpiredVxTwitterPreviewStates } from "../features/linkPreviews/twitter/vxtwitterPreviewState.js";
import { deleteExpiredPreviewTranslationStates } from "../features/linkPreviews/shared/previewState.repository.js";
import { deleteExpiredPreviewSummaries } from "../features/linkPreviews/shared/previewSummary.repository.js";

// clientReady での初期同期とバックグラウンドサービス起動。

export function registerClientReadyHandler(
  ctx: BotContext,
  lifecycle: ReturnType<typeof createRuntimeResourceLifecycle>,
  utilitiesBundle: UtilitiesMessageBundle,
): void {
  const { config, log, client, vcTimePgPool } = ctx;
  const debounceMs = config.COMMAND_SYNC_DEBOUNCE_MS;

  client.once("clientReady", async () => {
    const u = client.user;
    log.info(
      {
        tag: u?.tag,
        userId: u?.id,
        guilds: client.guilds.cache.size,
        usersCached: client.users.cache.size,
      },
      "discord gateway ready (clientReady)",
    );
    const g = client.guilds.cache.get(config.GUILD_ID);
    if (!g) {
      log.error({ expectedGuildId: config.GUILD_ID }, "bot is not a member of GUILD_ID");
      if (config.GUILD_MISMATCH_POLICY !== "warn") {
        process.exit(1);
        return;
      }
    } else {
      log.info({ guildId: g.id, guildName: g.name }, "target guild resolved");
      const startupReport = new StartupReport(log, g.id);
      await startupReport.run("panel reconciliation", () => reconcilePanelsForGuild(ctx, g.id));
      if (lifecycle.isClosed()) return;
      await startupReport.run("modmail UI restore", () => restoreModmailUiState(ctx));
      if (lifecycle.isClosed()) return;
      await startupReport.run("execution flow reconciliation", () => reconcileExecutionFlows(ctx));
      if (lifecycle.isClosed()) return;
      await startupReport.run("timeout-extend flow reconciliation", () => reconcileTimeoutExtendFlows(ctx));
      if (lifecycle.isClosed()) return;
      await startupReport.run("werewolf game reconciliation", () => reconcileWerewolfGames(ctx));
      if (lifecycle.isClosed()) return;
      await startupReport.run("VC session reconciliation", () => reconcileVcTimeSessionsAtReadyPostgres(client, vcTimePgPool, config.GUILD_ID));
      if (lifecycle.isClosed()) return;
      await startupReport.run("temporary VC tracking restore", () => ctx.vcTemp.restoreFromDatabase(g.id));
      if (lifecycle.isClosed()) return;
      ctx.vcTemp.startSweep();
      startupReport.logSummary();
    }
    if (lifecycle.isClosed()) return;
    const runSync = () => {
      void syncGuildApplicationCommands(config, log);
    };
    if (debounceMs > 0) {
      log.debug({ debounceMs }, "guild slash command sync scheduled");
      lifecycle.scheduleTimeout(runSync, debounceMs);
    } else {
      void runSync();
    }
    const started = await startClientReadyBackgroundServices({
      lifecycle,
      startUptime: () => startRuntimeUptime({
        pool: ctx.mainPgPool,
        runtimeKey: config.BOT_PROFILE,
        botVersion: config.BOT_VERSION,
        log,
      }),
      startPresence: (getUptimeSeconds) => startPresence(client, log, getUptimeSeconds),
      startReminder: () => {
        const timer = startReminderScheduler(ctx, 30_000, () => {
          void finalizeDueBokeruRounds(ctx).catch((e) => ctx.log.error({ err: e }, "bokeru sweep failed"));
        });
        return { stop: () => stopReminderScheduler(timer, log) };
      },
      startVxTwitterPreviewCleanup: () => {
        return startPreviewStateCleanup({
          deleteCommon: () => Promise.all([
            deleteExpiredPreviewTranslationStates(ctx.db),
            deleteExpiredPreviewSummaries(ctx.db),
          ]),
          deleteLegacy: () => deleteExpiredVxTwitterPreviewStates(ctx.db),
          reconcileExpansions: () => utilitiesBundle.expansions.reconcile(),
          logWarning: (err, message) => log.warn({ err }, message),
        });
      },
      startGameDeal: () => startGameDealWatcher(ctx),
      startSteamExchangeRateUpdater: () => startSteamExchangeRateUpdater({
        repository: new SteamExchangeRateRepository(ctx.mainPgPool, ctx.log),
        log: ctx.log,
      }),
      startYouTubeVideoCacheMaintenance: shouldStartYouTubeVideoCacheMaintenance(config)
        ? () => createYouTubeVideoCacheMaintenanceForContext(ctx).start()
        : undefined,
      startLolWatcher: () => startLolWatcher(ctx),
      startYouTubeWatcher: () => startYouTubeWatcher(ctx),
      logError: (err, message) => log.error({ err, guildId: config.GUILD_ID }, message),
    });
    if (!started) return;
    log.info("Background services started successfully.");
  });
}
