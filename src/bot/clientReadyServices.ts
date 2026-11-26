import type { BotContext } from "./context.js";
import type { GameDealWatcherController } from "../features/gameDeals/gameDealWatcher.js";
import type { JapaneseWorkerController } from "../features/japaneseAnalysis/japaneseWorkerProcess.js";
import type { YouTubeVideoCacheMaintenanceController } from "../features/youtube/youtubeVideoCacheMaintenance.js";
import { type RuntimeUptimeController } from "./runtimeUptime.js";
import type { SteamExchangeRateUpdaterController } from "../features/steam/steamExchangeRateUpdater.js";
import type { createRuntimeResourceLifecycle } from "./runtimeLifecycle.js";

// clientReady 後のバックグラウンドサービス起動。

type StoppableReminderHandle = NodeJS.Timeout | { stop(): void | Promise<void> };

export function shouldStartYouTubeVideoCacheMaintenance(config: Pick<BotContext["config"], "BOT_PROFILE" | "YOUTUBE_PREVIEW_ENABLED" | "ADHD_WATCHER_ENABLED">): boolean {
  return config.YOUTUBE_PREVIEW_ENABLED || config.ADHD_WATCHER_ENABLED;
}

export function startPreviewStateCleanup(options: {
  deleteCommon(): Promise<unknown>;
  deleteLegacy(): Promise<unknown>;
  reconcileExpansions?(): Promise<unknown>;
  logWarning(error: unknown, message: string): void;
  setInterval?: (callback: () => void, delay: number) => NodeJS.Timeout;
}): NodeJS.Timeout {
  const run = () => {
    void options.deleteCommon().catch((error) => options.logWarning(error, "preview translation state cleanup failed"));
    void options.deleteLegacy().catch((error) => options.logWarning(error, "vxtwitter preview state cleanup failed"));
    void options.reconcileExpansions?.().catch((error) => options.logWarning(error, "link expansion reconciliation failed"));
  };
  run();
  return (options.setInterval ?? setInterval)(run, 60 * 60 * 1_000);
}

export async function startClientReadyBackgroundServices(options: {
  lifecycle: ReturnType<typeof createRuntimeResourceLifecycle>;
  startUptime?(): Promise<RuntimeUptimeController>;
  startPresence(getUptimeSeconds?: () => number): NodeJS.Timeout;
  startReminder(): StoppableReminderHandle;
  startVxTwitterPreviewCleanup?(): NodeJS.Timeout;
  startGameDeal(): GameDealWatcherController;
  startSteamExchangeRateUpdater?(): SteamExchangeRateUpdaterController;
  startYouTubeVideoCacheMaintenance?(): Promise<YouTubeVideoCacheMaintenanceController>;
  startLolWatcher(): Promise<{ stop(): void | Promise<void> } | null>;
  startYouTubeWatcher(): { stop(): void | Promise<void> } | null;
  logError(error: unknown, message: string): void;
}): Promise<boolean> {
  if (options.lifecycle.isClosed()) return false;
  let uptimeController: RuntimeUptimeController | undefined;
  try {
    uptimeController = await options.startUptime?.();
    if (uptimeController) {
      await options.lifecycle.setClientReadyResources({ uptimeController });
      if (options.lifecycle.isClosed()) return false;
    }
    const presenceTimer = options.startPresence(uptimeController?.getUptimeSeconds);
    await options.lifecycle.setClientReadyResources({ presenceTimer });
    if (options.lifecycle.isClosed()) return false;
    const reminderTimer = options.startReminder();
    await options.lifecycle.setClientReadyResources({ reminderTimer });
    if (options.lifecycle.isClosed()) return false;
    const vxTwitterPreviewCleanupTimer = options.startVxTwitterPreviewCleanup?.();
    if (vxTwitterPreviewCleanupTimer) {
      await options.lifecycle.setClientReadyResources({ vxTwitterPreviewCleanupTimer });
      if (options.lifecycle.isClosed()) return false;
    }
    const gameDealWatcher = options.startGameDeal();
    await options.lifecycle.setClientReadyResources({ gameDealWatcher });
    if (options.lifecycle.isClosed()) return false;
    const steamExchangeRateUpdater = options.startSteamExchangeRateUpdater?.() ?? null;
    await options.lifecycle.setClientReadyResources({ steamExchangeRateUpdater });
    if (options.lifecycle.isClosed()) return false;
    const youtubeVideoCacheMaintenance = await options.startYouTubeVideoCacheMaintenance?.();
    await options.lifecycle.setClientReadyResources({ youtubeVideoCacheMaintenance: youtubeVideoCacheMaintenance ?? null });
    if (options.lifecycle.isClosed()) return false;
    const lolWatcher = await options.startLolWatcher();
    await options.lifecycle.setClientReadyResources({ lolWatcher });
    if (options.lifecycle.isClosed()) return false;
    const youtubeWatcher = options.startYouTubeWatcher();
    await options.lifecycle.setClientReadyResources({ youtubeWatcher });
    if (options.lifecycle.isClosed()) return false;
    return true;
  } catch (error) {
    options.logError(error, "background service startup failed; startup timers stopped");
    try {
      await options.lifecycle.stopClientReadyResources();
    } catch (cleanupError) {
      options.logError(cleanupError, "startup timer cleanup after background service failure failed");
    }
    return false;
  }
}

/**
 * 登録中に形態素解析器またはworkerの起動が失敗した場合、既に登録済みのlistener資源を残さない。
 * lifecycle.shutdown の失敗は元の起動失敗を隠さずログへ記録する。
 */
export async function initializeJapaneseRuntime(options: {
  lifecycle: ReturnType<typeof createRuntimeResourceLifecycle>;
  initTokenizer(): Promise<void>;
  startWorker(): Promise<JapaneseWorkerController | null>;
  logError(error: unknown, message: string): void;
}): Promise<void> {
  try {
    await options.initTokenizer();
    const worker = await options.startWorker();
    await options.lifecycle.setJapaneseWorker(worker);
  } catch (error) {
    await options.lifecycle.shutdown().catch((cleanupError) => {
      options.logError(cleanupError, "runtime lifecycle shutdown after Japanese runtime startup failure failed");
    });
    throw error;
  }
}
