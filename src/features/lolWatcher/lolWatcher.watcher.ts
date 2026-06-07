import type { Client, GuildTextBasedChannel } from "discord.js";
import type { BotContext } from "../../bot/context.js";
import { sqliteTimestamp } from "../../core/db/sqliteTimestamp.js";
import { buildLolWatcherCompletedEmbed, buildLolWatcherStartEmbed } from "./lolWatcher.embeds.js";
import { buildDeepLolDetailUrl, LolWatcherDeepLolScraper, LolWatcherRiotClient } from "./lolWatcher.client.js";
import { ensureLolWatcherSchema, LolWatcherRepository } from "./lolWatcher.repository.js";
import type {
  LolWatcherActiveGame,
  LolWatcherApiAccount,
  LolWatcherCompletedGame,
  LolWatcherLiveGame,
  LolWatcherScanResult,
} from "./lolWatcher.types.js";

const STARTUP_SCAN_DELAY_MS = 8_000;
const DEEPLOL_RETRY_DELAY_MS = 5 * 60 * 1000;

type ThreadResult =
  | { ok: true; channel: GuildTextBasedChannel }
  | { ok: false; error: string };

export type LolWatcherController = {
  scanNow(): Promise<{ started: true; result: LolWatcherScanResult } | { started: false; reason: string }>;
  stop(): void;
  isRunning(): boolean;
};

let currentController: LolWatcherController | null = null;

function emptyScanResult(): LolWatcherScanResult {
  return {
    scannedAccounts: 0,
    failedAccounts: 0,
    startedGames: 0,
    completedGames: 0,
    staleGames: 0,
    deepLolEnrichedGames: 0,
    errors: [],
  };
}

function appendError(result: LolWatcherScanResult, error: string): void {
  result.errors.push(error.slice(0, 500));
}

function legacyNumericGameId(gameId: string): string | null {
  const separatorIndex = gameId.indexOf("_");
  if (separatorIndex < 0 || separatorIndex === gameId.length - 1) return null;
  const suffix = gameId.slice(separatorIndex + 1);
  return /^\d+$/.test(suffix) ? suffix : null;
}

function findActiveGameForCompleted(
  repo: LolWatcherRepository,
  accountKeyNorm: string,
  completedGameId: string,
): LolWatcherActiveGame | null {
  const active = repo.getActiveGame(accountKeyNorm, completedGameId);
  if (active) return active;
  const legacyId = legacyNumericGameId(completedGameId);
  return legacyId ? repo.getActiveGame(accountKeyNorm, legacyId) : null;
}

function validateLolWatcherEnv(ctx: BotContext, repo: LolWatcherRepository): boolean {
  const missing: string[] = [];
  if (!ctx.config.RIOT_API_KEY.trim()) missing.push("RIOT_API_KEY");
  if (missing.length === 0) return true;
  const message = `missing required env: ${missing.join(", ")}`;
  ctx.log.error({ missing }, "lol watcher disabled because required env is missing");
  try {
    repo.setStatus("startup_error", message);
  } catch (err) {
    ctx.log.error({ err }, "lol watcher status save failed");
  }
  return false;
}

export function validateAndPrepareLolWatcher(ctx: BotContext): boolean {
  if (!ctx.config.DEEPLOL_WATCHER_ENABLED) return false;
  const repo = new LolWatcherRepository(ctx.sqlite);
  try {
    ensureLolWatcherSchema(ctx.sqlite);
  } catch (err) {
    ctx.log.error({ err }, "lol watcher schema ensure failed");
    return false;
  }
  return validateLolWatcherEnv(ctx, repo);
}

async function fetchLolWatcherChannel(client: Client, channelId: string): Promise<ThreadResult> {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) return { ok: false, error: "channel fetch failed" };
  if (!("guildId" in channel) || !channel.isTextBased() || channel.isDMBased()) {
    return { ok: false, error: "channel is not a guild text channel" };
  }
  if (channel.isThread() && channel.archived) return { ok: false, error: "thread is archived" };
  if (channel.isThread() && channel.locked) return { ok: false, error: "thread is locked" };
  if (!channel.isSendable()) return { ok: false, error: "channel is not sendable" };
  return { ok: true, channel };
}

async function postStartEmbed(
  ctx: BotContext,
  repo: LolWatcherRepository,
  thread: GuildTextBasedChannel,
  accountKeyNorm: string,
  account: LolWatcherApiAccount,
  game: LolWatcherLiveGame,
): Promise<boolean> {
  const sent = await thread
    .send({ embeds: [buildLolWatcherStartEmbed(account, game)], allowedMentions: { parse: [] } })
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.warn({ err, accountKeyNorm, gameId: game.gameId }, "lol watcher start post failed");
      repo.upsertActiveGame({
        accountKeyNorm,
        gameId: game.gameId,
        messageId: null,
        startedAt: game.startedAt,
        status: "error",
        errorMessage: message,
      });
      repo.setStatus(`post_error:${accountKeyNorm}:${game.gameId}`, message);
      return null;
    });
  if (!sent) return false;
  repo.upsertActiveGame({
    accountKeyNorm,
    gameId: game.gameId,
    messageId: sent.id,
    startedAt: game.startedAt,
    status: "active",
  });
  ctx.log.info({ accountKeyNorm, gameId: game.gameId, messageId: sent.id }, "lol watcher start posted");
  return true;
}

async function postCompletedEmbed(
  ctx: BotContext,
  repo: LolWatcherRepository,
  thread: GuildTextBasedChannel,
  input: {
    accountKeyNorm: string;
    account: LolWatcherApiAccount;
    game: LolWatcherCompletedGame;
    notificationType: "completed_without_start" | "completed_after_edit_failure";
    errorMessage?: string | null;
  },
): Promise<boolean> {
  const sent = await thread
    .send({ embeds: [buildLolWatcherCompletedEmbed(input.account, input.game)], allowedMentions: { parse: [] } })
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.warn({ err, accountKeyNorm: input.accountKeyNorm, gameId: input.game.gameId }, "lol watcher completed post failed");
      repo.saveNotification({
        accountKeyNorm: input.accountKeyNorm,
        gameId: input.game.gameId,
        messageId: null,
        notificationType: input.notificationType,
        status: "failed",
        errorMessage: message,
      });
      repo.setStatus(`post_error:${input.accountKeyNorm}:${input.game.gameId}`, message);
      return null;
    });
  if (!sent) return false;
  repo.saveNotification({
    accountKeyNorm: input.accountKeyNorm,
    gameId: input.game.gameId,
    messageId: sent.id,
    notificationType: input.notificationType,
    status: "posted",
    errorMessage: input.errorMessage ?? null,
  });
  repo.markCompleted(input.accountKeyNorm, input.game.gameId);
  ctx.log.info(
    { accountKeyNorm: input.accountKeyNorm, gameId: input.game.gameId, messageId: sent.id },
    "lol watcher completed posted",
  );
  return true;
}

function withDeepLolDetailUrl(
  ctx: BotContext,
  input: {
    accountKey: string;
    accountKeyNorm: string;
    account: LolWatcherApiAccount;
    game: LolWatcherCompletedGame;
  },
): LolWatcherCompletedGame {
  if (input.game.detailUrl) return input.game;
  const detail = buildDeepLolDetailUrl(ctx.config, input);
  if (detail.ok) return { ...input.game, detailUrl: detail.url };
  ctx.log.warn(
    {
      accountKeyNorm: input.accountKeyNorm,
      gameId: input.game.gameId,
      templateName: detail.templateName,
      generatedUrl: detail.url,
      error: detail.error,
    },
    "lol watcher deeplol detail url build failed",
  );
  return input.game;
}

async function updateCompletedEmbedWithDeepLol(
  ctx: BotContext,
  repo: LolWatcherRepository,
  thread: GuildTextBasedChannel,
  input: {
    accountKey: string;
    accountKeyNorm: string;
    account: LolWatcherApiAccount;
    game: LolWatcherCompletedGame;
    retryCount: number;
  },
): Promise<boolean> {
  const notification = repo.getNotification(input.accountKeyNorm, input.game.gameId);
  if (!notification?.messageId || notification.deepLolStatus === "enriched") return false;
  const scraped = await new LolWatcherDeepLolScraper(ctx.config).scrapeCompleted(input.accountKey, input.account, input.game);
  if (!scraped.ok) {
    repo.updateDeepLolStatus({
      accountKeyNorm: input.accountKeyNorm,
      gameId: input.game.gameId,
      status: input.retryCount >= 1 ? "failed" : "pending",
      retryCount: input.retryCount,
      errorMessage: scraped.error,
    });
    ctx.log.warn(
      {
        accountKeyNorm: input.accountKeyNorm,
        gameId: input.game.gameId,
        httpStatus: scraped.httpStatus,
        error: scraped.error,
        templateName: scraped.templateName,
        generatedUrl: scraped.detailUrl,
      },
      "lol watcher deeplol scrape failed",
    );
    return false;
  }
  if (scraped.aiScore === null) {
    repo.updateDeepLolStatus({
      accountKeyNorm: input.accountKeyNorm,
      gameId: input.game.gameId,
      status: input.retryCount >= 1 ? "not_found" : "pending",
      retryCount: input.retryCount,
      errorMessage: "AI score not found",
    });
    return false;
  }
  const message = await thread.messages.fetch(notification.messageId).catch((err) => {
    ctx.log.warn({ err, accountKeyNorm: input.accountKeyNorm, gameId: input.game.gameId }, "lol watcher deeplol message fetch failed");
    return null;
  });
  if (!message) {
    repo.updateDeepLolStatus({
      accountKeyNorm: input.accountKeyNorm,
      gameId: input.game.gameId,
      status: "failed",
      retryCount: input.retryCount,
      errorMessage: "message fetch failed",
    });
    return false;
  }
  const enrichedGame = { ...input.game, aiScore: scraped.aiScore, detailUrl: scraped.detailUrl ?? input.game.detailUrl };
  const edited = await message
    .edit({ embeds: [buildLolWatcherCompletedEmbed(input.account, enrichedGame)] })
    .then(() => true)
    .catch((err) => {
      ctx.log.warn({ err, accountKeyNorm: input.accountKeyNorm, gameId: input.game.gameId }, "lol watcher deeplol edit failed");
      return false;
    });
  repo.updateDeepLolStatus({
    accountKeyNorm: input.accountKeyNorm,
    gameId: input.game.gameId,
    status: edited ? "enriched" : "failed",
    retryCount: input.retryCount,
    errorMessage: edited ? null : "DeepLOL enriched edit failed",
  });
  if (edited) {
    ctx.log.info({ accountKeyNorm: input.accountKeyNorm, gameId: input.game.gameId }, "lol watcher deeplol enriched");
  }
  return edited;
}

async function editCompletedEmbed(
  ctx: BotContext,
  repo: LolWatcherRepository,
  thread: GuildTextBasedChannel,
  active: LolWatcherActiveGame,
  accountKey: string,
  account: LolWatcherApiAccount,
  game: LolWatcherCompletedGame,
): Promise<boolean> {
  if (!active.messageId) return false;
  const message = await thread.messages.fetch(active.messageId).catch((err) => {
    ctx.log.warn(
      { err, accountKeyNorm: active.accountKeyNorm, gameId: active.gameId, messageId: active.messageId },
      "lol watcher start message fetch failed",
    );
    return null;
  });
  if (!message) return false;
  const linkedGame = withDeepLolDetailUrl(ctx, {
    accountKey,
    accountKeyNorm: active.accountKeyNorm,
    account,
    game,
  });
  const edited = await message
    .edit({ embeds: [buildLolWatcherCompletedEmbed(account, linkedGame)], components: [] })
    .then(() => true)
    .catch((err) => {
      const text = err instanceof Error ? err.message : String(err);
      ctx.log.warn(
        { err, accountKeyNorm: active.accountKeyNorm, gameId: active.gameId, messageId: active.messageId },
        "lol watcher completed edit failed",
      );
      repo.setStatus(`edit_error:${active.accountKeyNorm}:${active.gameId}`, text);
      return false;
    });
  if (!edited) return false;
  repo.saveNotification({
    accountKeyNorm: active.accountKeyNorm,
    gameId: game.gameId,
    messageId: active.messageId,
    notificationType: "edited_from_start",
    status: "edited",
  });
  repo.markCompleted(active.accountKeyNorm, active.gameId);
  ctx.log.info(
    {
      accountKeyNorm: active.accountKeyNorm,
      activeGameId: active.gameId,
      completedGameId: game.gameId,
      messageId: active.messageId,
    },
    "lol watcher completed edited",
  );
  return true;
}

async function handleCompletedGame(
  ctx: BotContext,
  repo: LolWatcherRepository,
  thread: GuildTextBasedChannel,
  accountKey: string,
  accountKeyNorm: string,
  account: LolWatcherApiAccount,
  game: LolWatcherCompletedGame,
  scheduleDeepLol: (input: {
    accountKey: string;
    accountKeyNorm: string;
    account: LolWatcherApiAccount;
    game: LolWatcherCompletedGame;
  }) => void,
): Promise<boolean> {
  if (repo.hasNotification(accountKeyNorm, game.gameId)) return false;
  const active = findActiveGameForCompleted(repo, accountKeyNorm, game.gameId);
  let completed = false;
  if (active) {
    const linkedGame = withDeepLolDetailUrl(ctx, { accountKey, accountKeyNorm, account, game });
    const edited = await editCompletedEmbed(ctx, repo, thread, active, accountKey, account, linkedGame);
    if (edited) completed = true;
    else completed = await postCompletedEmbed(ctx, repo, thread, {
      accountKeyNorm,
      account,
      game: linkedGame,
      notificationType: "completed_after_edit_failure",
      errorMessage: "edit failed",
    });
    if (completed && active.gameId !== game.gameId) {
      repo.markCompleted(active.accountKeyNorm, active.gameId);
    }
  } else {
    const linkedGame = withDeepLolDetailUrl(ctx, { accountKey, accountKeyNorm, account, game });
    completed = await postCompletedEmbed(ctx, repo, thread, {
      accountKeyNorm,
      account,
      game: linkedGame,
      notificationType: "completed_without_start",
    });
  }
  if (completed) scheduleDeepLol({ accountKey, accountKeyNorm, account, game });
  return completed;
}

function updateMissingAndStale(repo: LolWatcherRepository, accountKeyNorm: string, liveGameId: string | null, completedIds: Set<string>, staleMs: number): number {
  let staleCount = 0;
  for (const game of repo.listOpenActiveGames(accountKeyNorm)) {
    if (game.status === "completed") continue;
    if (game.gameId === liveGameId || completedIds.has(game.gameId)) continue;
    if (!game.missingSince && game.status !== "stale") {
      repo.markMissing(game);
      continue;
    }
    const missingSince = game.missingSince ? Date.parse(game.missingSince) : Date.parse(game.updatedAt);
    if (Number.isFinite(missingSince) && Date.now() - missingSince > staleMs && game.status !== "stale") {
      repo.markStale(game);
      staleCount += 1;
    }
  }
  return staleCount;
}

export async function scanLolWatcher(
  ctx: BotContext,
  scheduleDeepLol: (input: {
    accountKey: string;
    accountKeyNorm: string;
    account: LolWatcherApiAccount;
    game: LolWatcherCompletedGame;
  }) => void = () => undefined,
): Promise<LolWatcherScanResult> {
  const result = emptyScanResult();
  const repo = new LolWatcherRepository(ctx.sqlite);
  if (!ctx.config.DEEPLOL_WATCHER_ENABLED) {
    appendError(result, "lol watcher disabled");
    return result;
  }
  if (!ctx.config.RIOT_API_KEY.trim()) {
    appendError(result, "missing required env");
    repo.setStatus("scan_error", "missing required env");
    return result;
  }
  const notificationChannelId = repo.getNotificationChannelId();
  if (!notificationChannelId) {
    appendError(result, "notification channel is not set");
    repo.setStatus("channel_error", "notification channel is not set");
    return result;
  }
  const channelResult = await fetchLolWatcherChannel(ctx.client, notificationChannelId);
  if (!channelResult.ok) {
    appendError(result, channelResult.error);
    repo.setStatus("channel_error", channelResult.error);
    return result;
  }

  const client = new LolWatcherRiotClient(ctx.config);
  for (const watchAccount of repo.listAccounts()) {
    result.scannedAccounts += 1;
    const fetched = await client.fetchState(watchAccount.accountKey);
    if (!fetched.ok) {
      result.failedAccounts += 1;
      const message = fetched.httpStatus ? `${fetched.error} (${fetched.httpStatus})` : fetched.error;
      appendError(result, `${watchAccount.accountKeyNorm}: ${message}`);
      repo.setStatus(`account_error:${watchAccount.accountKeyNorm}`, message);
      ctx.log.warn(
        { accountKeyNorm: watchAccount.accountKeyNorm, httpStatus: fetched.httpStatus, error: fetched.error },
        "lol watcher account scan failed",
      );
      continue;
    }

    const completedIds = new Set(fetched.state.completedGames.map((game) => game.gameId));
    for (const completed of fetched.state.completedGames) {
      if (
        await handleCompletedGame(
          ctx,
          repo,
          channelResult.channel,
          watchAccount.accountKey,
          watchAccount.accountKeyNorm,
          fetched.state.account,
          completed,
          scheduleDeepLol,
        )
      ) {
        result.completedGames += 1;
      }
    }

    if (fetched.state.liveGame) {
      const game = fetched.state.liveGame;
      if (repo.hasNotification(watchAccount.accountKeyNorm, game.gameId)) {
        continue;
      }
      const active = repo.getActiveGame(watchAccount.accountKeyNorm, game.gameId);
      if (active) {
        repo.markActiveSeen(watchAccount.accountKeyNorm, game.gameId);
      } else if (await postStartEmbed(ctx, repo, channelResult.channel, watchAccount.accountKeyNorm, fetched.state.account, game)) {
        result.startedGames += 1;
      }
    }

    result.staleGames += updateMissingAndStale(
      repo,
      watchAccount.accountKeyNorm,
      fetched.state.liveGame?.gameId ?? null,
      completedIds,
      ctx.config.DEEPLOL_ACTIVE_STALE_MS,
    );
    repo.setStatus(`account_success:${watchAccount.accountKeyNorm}`, sqliteTimestamp());
  }
  repo.setStatus("last_scan_result", JSON.stringify(result));
  return result;
}

export function startLolWatcher(ctx: BotContext): LolWatcherController | null {
  if (!validateAndPrepareLolWatcher(ctx)) return null;
  let timer: NodeJS.Timeout | undefined;
  const deepLolTimers = new Set<NodeJS.Timeout>();
  let stopped = false;
  let running = false;

  const scheduleDeepLol = (input: {
    accountKey: string;
    accountKeyNorm: string;
    account: LolWatcherApiAccount;
    game: LolWatcherCompletedGame;
  }) => {
    const delayMs =
      ctx.config.DEEPLOL_SCRAPE_DELAY_MIN_MS
      + Math.floor(Math.random() * Math.max(1, ctx.config.DEEPLOL_SCRAPE_DELAY_MAX_MS - ctx.config.DEEPLOL_SCRAPE_DELAY_MIN_MS));
    const scheduleAttempt = (attemptDelayMs: number, retryCount: number) => {
      if (stopped) return;
      const handle = setTimeout(() => {
        deepLolTimers.delete(handle);
        void (async () => {
          const repo = new LolWatcherRepository(ctx.sqlite);
          const notificationChannelId = repo.getNotificationChannelId();
          if (!notificationChannelId) {
            repo.setStatus("deeplol_channel_error", "notification channel is not set");
            return;
          }
          const channelResult = await fetchLolWatcherChannel(ctx.client, notificationChannelId);
          if (!channelResult.ok) {
            repo.setStatus("deeplol_channel_error", channelResult.error);
            return;
          }
          const enriched = await updateCompletedEmbedWithDeepLol(ctx, repo, channelResult.channel, {
            ...input,
            retryCount,
          });
          if (!enriched && retryCount < 1) {
            scheduleAttempt(DEEPLOL_RETRY_DELAY_MS, retryCount + 1);
          }
        })();
      }, attemptDelayMs);
      deepLolTimers.add(handle);
    };
    scheduleAttempt(delayMs, 0);
  };

  const runOnce = async (): Promise<LolWatcherScanResult | null> => {
    if (running) return null;
    running = true;
    try {
      return await scanLolWatcher(ctx, scheduleDeepLol);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.warn({ err }, "lol watcher scan failed");
      try {
        new LolWatcherRepository(ctx.sqlite).setStatus("scan_error", message);
      } catch (statusErr) {
        ctx.log.error({ err: statusErr }, "lol watcher status save failed");
      }
      return null;
    } finally {
      running = false;
    }
  };

  const schedule = (delayMs: number) => {
    if (stopped) return;
    timer = setTimeout(() => {
      void (async () => {
        await runOnce();
        schedule(ctx.config.DEEPLOL_POLL_INTERVAL_MS);
      })();
    }, delayMs);
  };

  const controller: LolWatcherController = {
    async scanNow() {
      if (running) return { started: false, reason: "実行中です。" };
      const scan = await runOnce();
      return { started: true, result: scan ?? emptyScanResult() };
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      for (const handle of deepLolTimers) clearTimeout(handle);
      deepLolTimers.clear();
      currentController = null;
      ctx.log.info("lol watcher stopped");
    },
    isRunning() {
      return running;
    },
  };

  currentController = controller;
  ctx.log.info({ intervalMs: ctx.config.DEEPLOL_POLL_INTERVAL_MS }, "lol watcher started");
  schedule(STARTUP_SCAN_DELAY_MS);
  return controller;
}

export function getLolWatcherController(): LolWatcherController | null {
  return currentController;
}
