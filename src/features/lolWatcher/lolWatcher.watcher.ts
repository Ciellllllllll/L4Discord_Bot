import type { Client, GuildTextBasedChannel } from "discord.js";
import type { CoreDeps } from "../../core/deps.js";
import { componentCardsPayload } from "../../core/componentCard.js";
import { nowIso } from "../../core/db/nowIso.js";
import { buildLolWatcherCompletedEmbed, buildLolWatcherStartEmbed } from "./lolWatcher.embeds.js";
import { buildDeepLolDetailUrl, LolWatcherRiotClient } from "./lolWatcher.client.js";
import { createLolWatcherRepository, ensurePostgresLolWatcherSchema, type LolWatcherRepositoryLike } from "./lolWatcher.repository.js";
import type {
  LolWatcherActiveGame,
  LolWatcherApiAccount,
  LolWatcherCompletedGame,
  LolWatcherLiveGame,
  LolWatcherScanResult,
} from "./lolWatcher.types.js";

const STARTUP_SCAN_DELAY_MS = 8_000;

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

async function findActiveGameForCompleted(
  repo: LolWatcherRepositoryLike,
  accountKeyNorm: string,
  completedGameId: string,
): Promise<LolWatcherActiveGame | null> {
  const active = await repo.getActiveGame(accountKeyNorm, completedGameId);
  if (active) return active;
  const legacyId = legacyNumericGameId(completedGameId);
  return legacyId ? await repo.getActiveGame(accountKeyNorm, legacyId) : null;
}

type LolWatcherDeps = Pick<CoreDeps, "config" | "log" | "client" | "mainPgPool">;

async function validateLolWatcherEnv(ctx: LolWatcherDeps, repo: LolWatcherRepositoryLike): Promise<boolean> {
  const missing: string[] = [];
  if (!ctx.config.RIOT_API_KEY.trim()) missing.push("RIOT_API_KEY");
  if (missing.length === 0) return true;
  const message = `missing required env: ${missing.join(", ")}`;
  ctx.log.error({ missing }, "lol watcher disabled because required env is missing");
  try {
    await repo.setStatus("startup_error", message);
  } catch (err) {
    ctx.log.error({ err }, "lol watcher status save failed");
  }
  return false;
}

export async function validateAndPrepareLolWatcher(ctx: LolWatcherDeps): Promise<boolean> {
  if (!ctx.config.DEEPLOL_WATCHER_ENABLED) return false;
  const repo = createLolWatcherRepository(ctx);
  try {
    await ensurePostgresLolWatcherSchema(ctx.mainPgPool);
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
  ctx: LolWatcherDeps,
  repo: LolWatcherRepositoryLike,
  thread: GuildTextBasedChannel,
  accountKeyNorm: string,
  account: LolWatcherApiAccount,
  game: LolWatcherLiveGame,
): Promise<boolean> {
  const sent = await thread
    .send({ ...componentCardsPayload([buildLolWatcherStartEmbed(account, game)]), allowedMentions: { parse: [] } })
    .catch(async (err) => {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.warn({ err, accountKeyNorm, gameId: game.gameId }, "lol watcher start post failed");
      await repo.upsertActiveGame({
        accountKeyNorm,
        gameId: game.gameId,
        messageId: null,
        startedAt: game.startedAt,
        status: "error",
        errorMessage: message,
      });
      await repo.setStatus(`post_error:${accountKeyNorm}:${game.gameId}`, message);
      return null;
    });
  if (!sent) return false;
  await repo.upsertActiveGame({
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
  ctx: LolWatcherDeps,
  repo: LolWatcherRepositoryLike,
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
    .send({ ...componentCardsPayload([buildLolWatcherCompletedEmbed(input.account, input.game)]), allowedMentions: { parse: [] } })
    .catch(async (err) => {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.warn({ err, accountKeyNorm: input.accountKeyNorm, gameId: input.game.gameId }, "lol watcher completed post failed");
      await repo.saveNotification({
        accountKeyNorm: input.accountKeyNorm,
        gameId: input.game.gameId,
        messageId: null,
        notificationType: input.notificationType,
        status: "failed",
        errorMessage: message,
      });
      await repo.setStatus(`post_error:${input.accountKeyNorm}:${input.game.gameId}`, message);
      return null;
    });
  if (!sent) return false;
  await repo.saveNotification({
    accountKeyNorm: input.accountKeyNorm,
    gameId: input.game.gameId,
    messageId: sent.id,
    notificationType: input.notificationType,
    status: "posted",
    errorMessage: input.errorMessage ?? null,
  });
  await repo.markCompleted(input.accountKeyNorm, input.game.gameId);
  ctx.log.info(
    { accountKeyNorm: input.accountKeyNorm, gameId: input.game.gameId, messageId: sent.id },
    "lol watcher completed posted",
  );
  return true;
}

function withDeepLolDetailUrl(
  ctx: LolWatcherDeps,
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

async function editCompletedEmbed(
  ctx: LolWatcherDeps,
  repo: LolWatcherRepositoryLike,
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
    .edit(componentCardsPayload([buildLolWatcherCompletedEmbed(account, linkedGame)]))
    .then(() => true)
    .catch(async (err) => {
      const text = err instanceof Error ? err.message : String(err);
      ctx.log.warn(
        { err, accountKeyNorm: active.accountKeyNorm, gameId: active.gameId, messageId: active.messageId },
        "lol watcher completed edit failed",
      );
      await repo.setStatus(`edit_error:${active.accountKeyNorm}:${active.gameId}`, text);
      return false;
    });
  if (!edited) return false;
  await repo.saveNotification({
    accountKeyNorm: active.accountKeyNorm,
    gameId: game.gameId,
    messageId: active.messageId,
    notificationType: "edited_from_start",
    status: "edited",
  });
  await repo.markCompleted(active.accountKeyNorm, active.gameId);
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
  ctx: LolWatcherDeps,
  repo: LolWatcherRepositoryLike,
  thread: GuildTextBasedChannel,
  accountKey: string,
  accountKeyNorm: string,
  account: LolWatcherApiAccount,
  game: LolWatcherCompletedGame,
): Promise<boolean> {
  if (await repo.hasNotification(accountKeyNorm, game.gameId)) return false;
  const active = await findActiveGameForCompleted(repo, accountKeyNorm, game.gameId);
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
      await repo.markCompleted(active.accountKeyNorm, active.gameId);
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
  return completed;
}

async function updateMissingAndStale(repo: LolWatcherRepositoryLike, accountKeyNorm: string, liveGameId: string | null, completedIds: Set<string>, staleMs: number): Promise<number> {
  let staleCount = 0;
  for (const game of await repo.listOpenActiveGames(accountKeyNorm)) {
    if (game.status === "completed") continue;
    if (game.gameId === liveGameId || completedIds.has(game.gameId)) continue;
    if (!game.missingSince && game.status !== "stale") {
      await repo.markMissing(game);
      continue;
    }
    const missingSince = game.missingSince ? Date.parse(game.missingSince) : Date.parse(game.updatedAt);
    if (Number.isFinite(missingSince) && Date.now() - missingSince > staleMs && game.status !== "stale") {
      await repo.markStale(game);
      staleCount += 1;
    }
  }
  return staleCount;
}

export async function scanLolWatcher(
  ctx: LolWatcherDeps,
): Promise<LolWatcherScanResult> {
  const result = emptyScanResult();
  const repo = createLolWatcherRepository(ctx);
  if (!ctx.config.DEEPLOL_WATCHER_ENABLED) {
    appendError(result, "lol watcher disabled");
    return result;
  }
  if (!ctx.config.RIOT_API_KEY.trim()) {
    appendError(result, "missing required env");
    await repo.setStatus("scan_error", "missing required env");
    return result;
  }
  const notificationChannelId = await repo.getNotificationChannelId();
  if (!notificationChannelId) {
    appendError(result, "notification channel is not set");
    await repo.setStatus("channel_error", "notification channel is not set");
    return result;
  }
  const channelResult = await fetchLolWatcherChannel(ctx.client, notificationChannelId);
  if (!channelResult.ok) {
    appendError(result, channelResult.error);
    await repo.setStatus("channel_error", channelResult.error);
    return result;
  }

  const client = new LolWatcherRiotClient(ctx.config);
  for (const watchAccount of await repo.listAccounts()) {
    result.scannedAccounts += 1;
    const fetched = await client.fetchState(watchAccount.accountKey);
    if (!fetched.ok) {
      result.failedAccounts += 1;
      const message = fetched.httpStatus ? `${fetched.error} (${fetched.httpStatus})` : fetched.error;
      appendError(result, `${watchAccount.accountKeyNorm}: ${message}`);
      await repo.setStatus(`account_error:${watchAccount.accountKeyNorm}`, message);
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
        )
      ) {
        result.completedGames += 1;
      }
    }

    if (fetched.state.liveGame) {
      const game = fetched.state.liveGame;
      if (await repo.hasNotification(watchAccount.accountKeyNorm, game.gameId)) {
        continue;
      }
      const active = await repo.getActiveGame(watchAccount.accountKeyNorm, game.gameId);
      if (active) {
        await repo.markActiveSeen(watchAccount.accountKeyNorm, game.gameId);
      } else if (await postStartEmbed(ctx, repo, channelResult.channel, watchAccount.accountKeyNorm, fetched.state.account, game)) {
        result.startedGames += 1;
      }
    }

    result.staleGames += await updateMissingAndStale(
      repo,
      watchAccount.accountKeyNorm,
      fetched.state.liveGame?.gameId ?? null,
      completedIds,
      ctx.config.DEEPLOL_ACTIVE_STALE_MS,
    );
    await repo.setStatus(`account_success:${watchAccount.accountKeyNorm}`, nowIso());
  }
  await repo.setStatus("last_scan_result", JSON.stringify(result));
  return result;
}

export async function startLolWatcher(ctx: LolWatcherDeps): Promise<LolWatcherController | null> {
  if (!(await validateAndPrepareLolWatcher(ctx))) return null;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let running = false;

  const runOnce = async (): Promise<LolWatcherScanResult | null> => {
    if (running) return null;
    running = true;
    try {
      return await scanLolWatcher(ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.log.warn({ err }, "lol watcher scan failed");
      try {
        await createLolWatcherRepository(ctx).setStatus("scan_error", message);
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
      currentController = null;
      ctx.log.info("lol watcher stopped");
    },
    isRunning() {
      return running;
    },
  };

  currentController = controller;
  ctx.log.debug({ intervalMs: ctx.config.DEEPLOL_POLL_INTERVAL_MS }, "lol watcher started");
  schedule(STARTUP_SCAN_DELAY_MS);
  return controller;
}

export function getLolWatcherController(): LolWatcherController | null {
  return currentController;
}
