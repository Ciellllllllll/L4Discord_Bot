import { shutdownDetecterService } from "../features/detecter/detecterService.js";
import { shutdownExecutionFlowRuntime } from "../features/execution/executionFlow.js";
import { shutdownTimeoutExtendFlowRuntime } from "../features/execution/timeoutExtendFlow.js";
import type { GameDealWatcherController } from "../features/gameDeals/gameDealWatcher.js";
import type { YouTubeVideoCacheMaintenanceController } from "../features/youtube/youtubeVideoCacheMaintenance.js";
import type { RuntimeUptimeController } from "./runtimeUptime.js";
import type { SteamExchangeRateUpdaterController } from "../features/steam/steamExchangeRateUpdater.js";

// 起動リソースの停止とライフサイクル。

export type RuntimeHandlerHandle = { shutdown(): Promise<void> };

type StoppableReminderHandle = NodeJS.Timeout | { stop(): void | Promise<void> };

type RuntimeResources = {
  uptimeController?: RuntimeUptimeController;
  presenceTimer?: NodeJS.Timeout;
  reminderTimer?: StoppableReminderHandle;
  vxTwitterPreviewCleanupTimer?: NodeJS.Timeout;
  gameDealWatcher?: GameDealWatcherController;
  steamExchangeRateUpdater?: SteamExchangeRateUpdaterController | null;
  clearInterval?: (timer: NodeJS.Timeout) => void;
  clearTimeout?: (timer: NodeJS.Timeout) => void;
  deferredTimers?: Iterable<NodeJS.Timeout>;
  lolWatcher?: { stop(): void | Promise<void> } | null;
  youtubeVideoCacheMaintenance?: YouTubeVideoCacheMaintenanceController | null;
  youtubeWatcher?: { stop(): void | Promise<void> } | null;
  japaneseWorker?: { stop(): Promise<void> } | null;
  shutdownModerationFlows?: () => void | Promise<void>;
};

type RuntimeCoreResources = {
  vcTemp: { stopSweep(): void };
  client: { destroy(): void | Promise<void> };
};

async function stopRuntimeResources(
  options: RuntimeResources & Partial<RuntimeCoreResources>,
): Promise<void> {
  const errors: unknown[] = [];
  const stop = async (operation: () => void | Promise<void>) => {
    try { await operation(); } catch (error) { errors.push(error); }
  };
  const clear = options.clearInterval ?? clearInterval;
  const clearDeferred = options.clearTimeout ?? clearTimeout;
  for (const timer of options.deferredTimers ?? []) await stop(() => clearDeferred(timer));
  if (options.presenceTimer) await stop(() => clear(options.presenceTimer!));
  if (options.uptimeController) await stop(() => options.uptimeController!.stop());
  if (options.reminderTimer) {
    const reminder = options.reminderTimer;
    await stop(() => ("stop" in reminder && typeof reminder.stop === "function" ? reminder.stop() : clear(reminder as NodeJS.Timeout)));
  }
  if (options.vxTwitterPreviewCleanupTimer) await stop(() => clear(options.vxTwitterPreviewCleanupTimer!));
  if (options.gameDealWatcher) await stop(() => options.gameDealWatcher!.stop());
  if (options.steamExchangeRateUpdater) await stop(() => options.steamExchangeRateUpdater!.stop());
  if (options.youtubeVideoCacheMaintenance) await stop(() => options.youtubeVideoCacheMaintenance!.stop());
  if (options.lolWatcher) await stop(() => options.lolWatcher!.stop());
  if (options.youtubeWatcher) await stop(() => options.youtubeWatcher!.stop());
  if (options.japaneseWorker) await stop(() => options.japaneseWorker!.stop());
  if (options.shutdownModerationFlows) await stop(() => options.shutdownModerationFlows!());
  if (options.vcTemp) await stop(() => options.vcTemp!.stopSweep());
  if (options.client) await stop(() => options.client!.destroy());
  if (errors.length > 0) throw errors[0];
}

export function createRuntimeShutdown(options: RuntimeResources & RuntimeCoreResources): () => Promise<void> {
  return async () => {
    await stopRuntimeResources(options);
  };
}

/** Discord client を閉じる前に、処罰系フローが保持する期限タイマーと対象ロックを解放する。 */
export async function shutdownModerationFlowRuntimes(): Promise<void> {
  shutdownDetecterService();
  await Promise.all([shutdownExecutionFlowRuntime(), shutdownTimeoutExtendFlowRuntime()]);
}

export function createRuntimeResourceLifecycle(options: {
  vcTemp: { stopSweep(): void };
  client: { destroy(): void | Promise<void> };
  clearInterval?: (timer: NodeJS.Timeout) => void;
  setTimeout?: (callback: () => void, delay: number) => NodeJS.Timeout;
  clearTimeout?: (timer: NodeJS.Timeout) => void;
  shutdownModerationFlows?: () => void | Promise<void>;
}): RuntimeHandlerHandle & {
  setClientReadyResources(resources: {
    uptimeController?: RuntimeUptimeController;
    presenceTimer?: NodeJS.Timeout;
    reminderTimer?: StoppableReminderHandle;
    vxTwitterPreviewCleanupTimer?: NodeJS.Timeout;
    gameDealWatcher?: GameDealWatcherController;
    steamExchangeRateUpdater?: SteamExchangeRateUpdaterController | null;
    lolWatcher?: { stop(): void | Promise<void> } | null;
    youtubeVideoCacheMaintenance?: YouTubeVideoCacheMaintenanceController | null;
    youtubeWatcher?: { stop(): void | Promise<void> } | null;
  }): Promise<void>;
  setJapaneseWorker(worker: { stop(): Promise<void> } | null): Promise<void>;
  stopClientReadyResources(): Promise<void>;
  isClosed(): boolean;
  scheduleTimeout(callback: () => void, delay: number): void;
} {
  let uptimeController: RuntimeUptimeController | undefined;
  let presenceTimer: NodeJS.Timeout | undefined;
  let reminderTimer: StoppableReminderHandle | undefined;
  let vxTwitterPreviewCleanupTimer: NodeJS.Timeout | undefined;
  let gameDealWatcher: GameDealWatcherController | undefined;
  let steamExchangeRateUpdater: SteamExchangeRateUpdaterController | null = null;
  let lolWatcher: { stop(): void | Promise<void> } | null = null;
  let youtubeVideoCacheMaintenance: YouTubeVideoCacheMaintenanceController | null = null;
  let youtubeWatcher: { stop(): void | Promise<void> } | null = null;
  let japaneseWorker: { stop(): Promise<void> } | null = null;
  let closed = false;
  let shutdownPromise: Promise<void> | undefined;
  const deferredTimers = new Set<NodeJS.Timeout>();
  return {
    async setClientReadyResources(resources) {
      if (closed) {
        await stopRuntimeResources({ ...resources, clearInterval: options.clearInterval });
        return;
      }
      if ("uptimeController" in resources) uptimeController = resources.uptimeController;
      if ("presenceTimer" in resources) presenceTimer = resources.presenceTimer;
      if ("reminderTimer" in resources) reminderTimer = resources.reminderTimer;
      if ("vxTwitterPreviewCleanupTimer" in resources) vxTwitterPreviewCleanupTimer = resources.vxTwitterPreviewCleanupTimer;
      if ("gameDealWatcher" in resources) gameDealWatcher = resources.gameDealWatcher;
      if ("steamExchangeRateUpdater" in resources) steamExchangeRateUpdater = resources.steamExchangeRateUpdater ?? null;
      if ("lolWatcher" in resources) lolWatcher = resources.lolWatcher ?? null;
      if ("youtubeVideoCacheMaintenance" in resources) youtubeVideoCacheMaintenance = resources.youtubeVideoCacheMaintenance ?? null;
      if ("youtubeWatcher" in resources) youtubeWatcher = resources.youtubeWatcher ?? null;
    },
    async setJapaneseWorker(worker) {
      if (closed) {
        if (worker) await stopRuntimeResources({ japaneseWorker: worker });
        return;
      }
      japaneseWorker = worker;
    },
    async stopClientReadyResources() {
      const resources = { uptimeController, presenceTimer, reminderTimer, vxTwitterPreviewCleanupTimer, gameDealWatcher, steamExchangeRateUpdater, lolWatcher, youtubeVideoCacheMaintenance, youtubeWatcher, clearInterval: options.clearInterval };
      uptimeController = undefined;
      presenceTimer = undefined;
      reminderTimer = undefined;
      vxTwitterPreviewCleanupTimer = undefined;
      gameDealWatcher = undefined;
      steamExchangeRateUpdater = null;
      lolWatcher = null;
      youtubeVideoCacheMaintenance = null;
      youtubeWatcher = null;
      await stopRuntimeResources(resources);
    },
    isClosed: () => closed,
    scheduleTimeout(callback, delay) {
      if (closed) return;
      const schedule = options.setTimeout ?? setTimeout;
      const timer = schedule(() => {
        deferredTimers.delete(timer);
        if (!closed) callback();
      }, delay);
      deferredTimers.add(timer);
    },
    shutdown: () => shutdownPromise ??= (async () => {
      closed = true;
      try {
        await createRuntimeShutdown({
          uptimeController, presenceTimer, reminderTimer, vxTwitterPreviewCleanupTimer, gameDealWatcher, steamExchangeRateUpdater, lolWatcher, youtubeVideoCacheMaintenance, youtubeWatcher, japaneseWorker,
          vcTemp: options.vcTemp, client: options.client, clearInterval: options.clearInterval,
          clearTimeout: options.clearTimeout, deferredTimers, shutdownModerationFlows: options.shutdownModerationFlows,
        })();
      } finally {
        deferredTimers.clear();
      }
    })(),
  };
}
