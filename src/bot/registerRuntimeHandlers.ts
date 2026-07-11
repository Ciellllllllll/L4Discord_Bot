import { MessageFlags } from "discord.js";
import type { BotContext } from "./context.js";
import { startPresenceRotation } from "./presence.js";
import { syncGuildApplicationCommands } from "./syncCommands.js";
import { handleSlashCommand } from "../commands/slashHandlers.js";
import { getGuildSettingsData } from "../core/guildSettings.js";
import { getDetecterService } from "../features/detecter/detecterService.js";
import { reconcileExecutionFlows, shutdownExecutionFlowRuntime } from "../features/execution/executionFlow.js";
import { reconcileTimeoutExtendFlows, shutdownTimeoutExtendFlowRuntime } from "../features/execution/timeoutExtendFlow.js";
import { startGameDealWatcher, type GameDealWatcherController } from "../features/gameDeals/gameDealWatcher.js";
import { startJapaneseWorkerIfEnabled, type JapaneseWorkerController } from "../features/japaneseAnalysis/japaneseWorkerProcess.js";
import { startLolWatcher } from "../features/lolWatcher/lolWatcher.watcher.js";
import { cancelPendingRepliesBySource, routeModmailGuildThreadMessage } from "../features/modmail/modmailStaffFlow.js";
import { handleModmailDmMessage } from "../features/modmail/modmailService.js";
import { restoreModmailUiState } from "../features/modmail/modmailRestore.js";
import { handleAutoModerationMessage } from "../features/moderation/autoModerationMessage.js";
import { handleEmojiGuardMessage, handleEmojiGuardReaction } from "../features/moderation/emojiGuard.js";
import { reconcilePanelsForGuild } from "../features/panels/panelService.js";
import { handlePacchiMessage } from "../features/pacchi/pacchi.message-handler.js";
import { startReminderScheduler } from "../features/reminders/reminderScheduler.js";
import { handleSenryuMessage } from "../features/senryu/senryu.message-handler.js";
import { initKuromojiTokenizer } from "../features/senryu/senryu.kuromoji.js";
import { trackStampMessage, trackStampReaction } from "../features/stamps/trackReaction.js";
import { createUtilitiesMessageHandlers, runUtilitiesMessageChain } from "../features/utilities/utilitiesMessage.js";
import { sendMemberLeaveEmbed } from "../features/utilities/leaveNotifier.js";
import { endOpenVcSessionForMember, endOpenVcSessionForMemberPostgres, reconcileVcTimeSessionsAtReady, reconcileVcTimeSessionsAtReadyPostgres, trackVoiceStateUpdate, trackVoiceStateUpdatePostgres } from "../features/vc/voiceSessionTracker.js";
import { reconcileWerewolfGames } from "../features/werewolf/werewolfGame.js";
import { handleZigAutoReply } from "../features/zig/zigAutoReply.js";
import { routeButton, routeChannelSelectMenu, routeModal, routeStringSelectMenu } from "../interactions/handleComponents.js";
import { handleExtendedAutoReplies } from "../message/extendedAutoReply.js";
import { handlePrefixMessage } from "../message/prefixHandlers.js";
import { handleAiChatMonitorMessage } from "../features/ai/aiQueryService.js";
import { hydrateMessageIfPartial, ingestMessageCreate, ingestMessageCreatePostgres, ingestMessageDelete, ingestMessageDeletePostgres, ingestMessageUpdate, ingestMessageUpdatePostgres } from "../features/messageLog/index.js";
import { scheduleArchiveMessageAttachments, scheduleArchiveMessageAttachmentsPostgres } from "../features/messageLog/messageAttachmentArchive.js";

export type RuntimeHandlerHandle = { shutdown(): Promise<void> };

type RuntimeResources = {
  presenceTimer?: NodeJS.Timeout;
  reminderTimer?: NodeJS.Timeout;
  gameDealWatcher?: GameDealWatcherController;
  clearInterval?: (timer: NodeJS.Timeout) => void;
  clearTimeout?: (timer: NodeJS.Timeout) => void;
  deferredTimers?: Iterable<NodeJS.Timeout>;
  lolWatcher?: { stop(): void | Promise<void> } | null;
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
  if (options.reminderTimer) await stop(() => clear(options.reminderTimer!));
  if (options.gameDealWatcher) await stop(() => options.gameDealWatcher!.stop());
  if (options.lolWatcher) await stop(() => options.lolWatcher!.stop());
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
export function shutdownModerationFlowRuntimes(): void {
  shutdownExecutionFlowRuntime();
  shutdownTimeoutExtendFlowRuntime();
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
    presenceTimer?: NodeJS.Timeout;
    reminderTimer?: NodeJS.Timeout;
    gameDealWatcher?: GameDealWatcherController;
    lolWatcher?: { stop(): void | Promise<void> } | null;
  }): Promise<void>;
  setJapaneseWorker(worker: { stop(): Promise<void> } | null): Promise<void>;
  stopClientReadyResources(): Promise<void>;
  isClosed(): boolean;
  scheduleTimeout(callback: () => void, delay: number): void;
} {
  let presenceTimer: NodeJS.Timeout | undefined;
  let reminderTimer: NodeJS.Timeout | undefined;
  let gameDealWatcher: GameDealWatcherController | undefined;
  let lolWatcher: { stop(): void | Promise<void> } | null = null;
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
      presenceTimer = resources.presenceTimer;
      reminderTimer = resources.reminderTimer;
      gameDealWatcher = resources.gameDealWatcher;
      lolWatcher = resources.lolWatcher ?? null;
    },
    async setJapaneseWorker(worker) {
      if (closed) {
        if (worker) await stopRuntimeResources({ japaneseWorker: worker });
        return;
      }
      japaneseWorker = worker;
    },
    async stopClientReadyResources() {
      const resources = { presenceTimer, reminderTimer, gameDealWatcher, lolWatcher, clearInterval: options.clearInterval };
      presenceTimer = undefined;
      reminderTimer = undefined;
      gameDealWatcher = undefined;
      lolWatcher = null;
      await stopRuntimeResources(resources);
    },
    isClosed: () => closed,
    scheduleTimeout(callback, delay) {
      if (closed) return;
      let timer: NodeJS.Timeout | undefined;
      const schedule = options.setTimeout ?? setTimeout;
      timer = schedule(() => {
        if (timer) deferredTimers.delete(timer);
        if (!closed) callback();
      }, delay);
      deferredTimers.add(timer);
    },
    shutdown: () => shutdownPromise ??= (async () => {
      closed = true;
      try {
        await createRuntimeShutdown({
          presenceTimer, reminderTimer, gameDealWatcher, lolWatcher, japaneseWorker,
          vcTemp: options.vcTemp, client: options.client, clearInterval: options.clearInterval,
          clearTimeout: options.clearTimeout, deferredTimers, shutdownModerationFlows: options.shutdownModerationFlows,
        })();
      } finally {
        deferredTimers.clear();
      }
    })(),
  };
}

export async function startClientReadyBackgroundServices(options: {
  lifecycle: ReturnType<typeof createRuntimeResourceLifecycle>;
  startPresence(): NodeJS.Timeout;
  startReminder(): NodeJS.Timeout;
  startGameDeal(): GameDealWatcherController;
  startLolWatcher(): Promise<{ stop(): void | Promise<void> } | null>;
  logError(error: unknown, message: string): void;
}): Promise<boolean> {
  if (options.lifecycle.isClosed()) return false;
  const presenceTimer = options.startPresence();
  const reminderTimer = options.startReminder();
  const gameDealWatcher = options.startGameDeal();
  await options.lifecycle.setClientReadyResources({ presenceTimer, reminderTimer, gameDealWatcher });
  if (options.lifecycle.isClosed()) return false;
  try {
    const lolWatcher = await options.startLolWatcher();
    await options.lifecycle.setClientReadyResources({ presenceTimer, reminderTimer, gameDealWatcher, lolWatcher });
    if (options.lifecycle.isClosed()) return false;
    return true;
  } catch (error) {
    options.logError(error, "lol watcher startup failed; startup timers stopped");
    try {
      await options.lifecycle.stopClientReadyResources();
    } catch (cleanupError) {
      options.logError(cleanupError, "startup timer cleanup after lol watcher failure failed");
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

export async function registerRuntimeHandlers(ctx: BotContext, options: { vcTimePgPool?: import("pg").Pool } = {}): Promise<RuntimeHandlerHandle> {
  const { config, log, client, db, messageLogPgPool, messageLogSqlite, messageAttachmentPgPool, messageAttachmentStoreSqlite, vcTimeSqlite } = ctx;
  const { vcTimePgPool } = options;
  const utilitiesBundle = createUtilitiesMessageHandlers(ctx);
  const debounceMs = config.COMMAND_SYNC_DEBOUNCE_MS;
  const lifecycle = createRuntimeResourceLifecycle({ vcTemp: ctx.vcTemp, client, shutdownModerationFlows: shutdownModerationFlowRuntimes });

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
      try {
        await reconcilePanelsForGuild(ctx, g.id);
        log.info({ guildId: g.id }, "panel reconcile on startup completed");
      } catch (err) {
        log.error({ err, guildId: g.id }, "panel reconcile on startup failed");
      }
      if (lifecycle.isClosed()) return;
      try {
        await restoreModmailUiState(ctx);
        log.info({ guildId: g.id }, "modmail UI restore on startup completed");
      } catch (err) {
        log.warn({ err, guildId: g.id }, "modmail UI restore on startup failed");
      }
      if (lifecycle.isClosed()) return;
      try {
        await reconcileExecutionFlows(ctx);
        log.info({ guildId: g.id }, "execution flows reconciled at startup");
      } catch (err) {
        log.error({ err, guildId: g.id }, "execution flow reconcile at startup failed");
      }
      if (lifecycle.isClosed()) return;
      try {
        await reconcileTimeoutExtendFlows(ctx);
        log.info({ guildId: g.id }, "timeout-extend flows reconciled at startup");
      } catch (err) {
        log.error({ err, guildId: g.id }, "timeout-extend flow reconcile at startup failed");
      }
      if (lifecycle.isClosed()) return;
      try {
        await reconcileWerewolfGames(ctx);
        log.info({ guildId: g.id }, "werewolf games reconciled at startup");
      } catch (err) {
        log.error({ err, guildId: g.id }, "werewolf reconcile at startup failed");
      }
      if (lifecycle.isClosed()) return;
      try {
        if (vcTimePgPool) {
          await reconcileVcTimeSessionsAtReadyPostgres(client, vcTimePgPool, config.GUILD_ID);
        } else {
          reconcileVcTimeSessionsAtReady(client, vcTimeSqlite!, config.GUILD_ID);
        }
        log.info({ guildId: g.id }, "vc_time sessions reconciled at startup");
      } catch (err) {
        log.error({ err, guildId: g.id }, "vc_time reconcile at startup failed");
      }
      if (lifecycle.isClosed()) return;
      try {
        await ctx.vcTemp.restoreFromDatabase(g.id);
        log.info({ guildId: g.id }, "temporary VC tracking restored from database");
      } catch (err) {
        log.error({ err, guildId: g.id }, "temporary VC restore from database failed");
      }
      if (lifecycle.isClosed()) return;
      ctx.vcTemp.startSweep();
    }
    if (lifecycle.isClosed()) return;
    const runSync = () => {
      void syncGuildApplicationCommands(config, log);
    };
    if (debounceMs > 0) {
      log.info({ debounceMs }, "guild slash command sync scheduled");
      lifecycle.scheduleTimeout(runSync, debounceMs);
    } else {
      void runSync();
    }
    const started = await startClientReadyBackgroundServices({
      lifecycle,
      startPresence: () => startPresenceRotation(client, log, config.BOT_VERSION),
      startReminder: () => startReminderScheduler(ctx),
      startGameDeal: () => startGameDealWatcher(ctx),
      startLolWatcher: () => startLolWatcher(ctx),
      logError: (err, message) => log.error({ err, guildId: config.GUILD_ID }, message),
    });
    if (!started) return;
    log.info("startup tasks from clientReady finished (sync may still be in flight)");
  });

  client.on("interactionCreate", async (interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        const command = interaction.commandName;
        const userId = interaction.user.id;
        log.info({ command, userId, interactionId: interaction.id }, "slash command received");
        try {
          await handleSlashCommand(interaction, ctx);
          log.info({ command, userId, interactionId: interaction.id }, "slash command completed");
        } catch (cmdErr) {
          log.error({ err: cmdErr, command, userId, interactionId: interaction.id }, "slash command failed");
          throw cmdErr;
        }
        return;
      }
      if (interaction.isButton()) {
        log.debug(
          { customId: interaction.customId, userId: interaction.user.id, interactionId: interaction.id },
          "button interaction",
        );
        await routeButton(interaction, ctx);
        log.debug({ customId: interaction.customId }, "button interaction completed");
        return;
      }
      if (interaction.isModalSubmit()) {
        log.debug(
          { customId: interaction.customId, userId: interaction.user.id, interactionId: interaction.id },
          "modal submit",
        );
        await routeModal(interaction, ctx);
        log.debug({ customId: interaction.customId }, "modal submit completed");
        return;
      }
      if (interaction.isStringSelectMenu()) {
        log.debug(
          { customId: interaction.customId, userId: interaction.user.id, interactionId: interaction.id },
          "string select menu",
        );
        await routeStringSelectMenu(interaction, ctx);
        log.debug({ customId: interaction.customId }, "string select menu completed");
        return;
      }
      if (interaction.isChannelSelectMenu()) {
        log.debug(
          { customId: interaction.customId, userId: interaction.user.id, interactionId: interaction.id },
          "channel select menu",
        );
        await routeChannelSelectMenu(interaction, ctx);
        log.debug({ customId: interaction.customId }, "channel select menu completed");
        return;
      }
    } catch (err) {
      log.error(
        { err, id: interaction.id, type: interaction.type },
        "interaction handler error",
      );
      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        await interaction
          .reply({ content: "エラーが発生しました。", flags: MessageFlags.Ephemeral })
          .catch(() => undefined);
      }
    }
  });

  client.on("messageCreate", async (message) => {
    try {
      if (!message.guild && !message.author.bot) {
        if (await handleModmailDmMessage(ctx, message)) return;
      }
      if (message.guildId === config.GUILD_ID && !message.author.bot) {
        const s = await getGuildSettingsData(db, message.guildId);
        const ex = s.message_log_excluded_channel_ids ?? [];
        const messageLogOptions = {
          targetGuildId: config.GUILD_ID,
          excludedChannelIds: ex,
          botUserId: client.user?.id ?? "",
        };
        if (messageLogPgPool) {
          await ingestMessageCreatePostgres(messageLogPgPool, message, messageLogOptions);
        } else {
          ingestMessageCreate(messageLogSqlite!, message, messageLogOptions);
        }
        if (config.MESSAGE_ATTACHMENT_ARCHIVE_ENABLED) {
          if (messageAttachmentPgPool) {
            scheduleArchiveMessageAttachmentsPostgres(
              messageAttachmentPgPool,
              config.MESSAGE_ATTACHMENT_FILES_DIR,
              message,
              log,
            );
          } else {
            scheduleArchiveMessageAttachments(
              messageAttachmentStoreSqlite,
              config.MESSAGE_ATTACHMENT_FILES_DIR,
              message,
              log,
            );
          }
        }
        await trackStampMessage(message, ctx);
        if (await routeModmailGuildThreadMessage(message, ctx)) return;
      }
      if (await handlePrefixMessage(message, ctx)) return;
      if (await handleZigAutoReply(message, ctx)) return;
      if (await handlePacchiMessage(ctx, message)) return;
      await runUtilitiesMessageChain(utilitiesBundle, message);
      if (await handleSenryuMessage(ctx, message)) return;
      if (await handleExtendedAutoReplies(message, ctx)) return;
      if (await handleAiChatMonitorMessage(message, ctx)) return;
      await handleAutoModerationMessage(message, ctx);
      await handleEmojiGuardMessage(message, ctx);
    } catch (err) {
      log.error({ err }, "messageCreate");
    }
  });

  client.on("messageUpdate", async (_oldMessage, newMessage) => {
    try {
      const message = newMessage;
      if (!message.guildId || message.author?.bot) return;
      if (message.guildId !== config.GUILD_ID) return;
      const s = await getGuildSettingsData(db, message.guildId);
      const ex = s.message_log_excluded_channel_ids ?? [];
      const messageLogOptions = {
        targetGuildId: config.GUILD_ID,
        excludedChannelIds: ex,
        botUserId: client.user?.id ?? "",
      };
      if (messageLogPgPool) {
        await ingestMessageUpdatePostgres(messageLogPgPool, message, messageLogOptions);
      } else {
        ingestMessageUpdate(messageLogSqlite!, message, messageLogOptions);
      }
      if (config.MESSAGE_ATTACHMENT_ARCHIVE_ENABLED) {
        if (messageAttachmentPgPool) {
          scheduleArchiveMessageAttachmentsPostgres(
            messageAttachmentPgPool,
            config.MESSAGE_ATTACHMENT_FILES_DIR,
            message,
            log,
          );
        } else {
          scheduleArchiveMessageAttachments(
            messageAttachmentStoreSqlite,
            config.MESSAGE_ATTACHMENT_FILES_DIR,
            message,
            log,
          );
        }
      }
    } catch (err) {
      log.error({ err }, "messageUpdate");
    }
  });

  client.on("messageDelete", async (message) => {
    try {
      if (!message.guildId || message.guildId !== config.GUILD_ID) return;
      const s = await getGuildSettingsData(db, message.guildId);
      const ex = s.message_log_excluded_channel_ids ?? [];
      const target = await hydrateMessageIfPartial(message);
      await cancelPendingRepliesBySource(ctx, target.id);
      const messageLogOptions = {
        targetGuildId: config.GUILD_ID,
        excludedChannelIds: ex,
        botUserId: client.user?.id ?? "",
      };
      if (messageLogPgPool) {
        await ingestMessageDeletePostgres(messageLogPgPool, target, messageLogOptions);
      } else {
        ingestMessageDelete(messageLogSqlite!, target, messageLogOptions);
      }
      if (config.MESSAGE_ATTACHMENT_ARCHIVE_ENABLED) {
        if (messageAttachmentPgPool) {
          scheduleArchiveMessageAttachmentsPostgres(
            messageAttachmentPgPool,
            config.MESSAGE_ATTACHMENT_FILES_DIR,
            target,
            log,
          );
        } else {
          scheduleArchiveMessageAttachments(
            messageAttachmentStoreSqlite,
            config.MESSAGE_ATTACHMENT_FILES_DIR,
            target,
            log,
          );
        }
      }
    } catch (err) {
      log.error({ err }, "messageDelete");
    }
  });

  client.on("messageReactionAdd", async (reaction, user) => {
    try {
      const u = user.partial ? await user.fetch() : user;
      await handleEmojiGuardReaction(reaction, u, ctx);
      await trackStampReaction(reaction, u, ctx);
    } catch (err) {
      log.error({ err }, "messageReactionAdd");
    }
  });

  client.on("voiceStateUpdate", (oldS, newS) => {
    try {
      if (vcTimePgPool) {
        void trackVoiceStateUpdatePostgres(vcTimePgPool, oldS, newS, config.GUILD_ID).catch((err) => {
          log.error({ err }, "voiceStateUpdate postgres tracking");
        });
      } else {
        trackVoiceStateUpdate(vcTimeSqlite!, oldS, newS, config.GUILD_ID);
      }
      ctx.vcTemp.onVoiceStateUpdate(oldS, newS);
    } catch (err) {
      log.error({ err }, "voiceStateUpdate");
    }
  });

  client.on("guildBanAdd", async (ban) => {
    try {
      await getDetecterService(ctx).onGuildBanAdd(ban);
    } catch (err) {
      log.error({ err }, "guildBanAdd");
    }
  });

  client.on("guildMemberUpdate", async (before, after) => {
    try {
      await getDetecterService(ctx).onGuildMemberUpdate(before, after);
    } catch (err) {
      log.error({ err }, "guildMemberUpdate");
    }
  });

  client.on("guildMemberRemove", async (member) => {
    try {
      if (member.guild.id !== config.GUILD_ID) return;
      await getDetecterService(ctx).onGuildMemberRemove(member);
      if (vcTimePgPool) {
        await endOpenVcSessionForMemberPostgres(vcTimePgPool, member.guild.id, member.id);
      } else {
        endOpenVcSessionForMember(vcTimeSqlite!, member.guild.id, member.id);
      }
      await sendMemberLeaveEmbed(ctx, member);
    } catch (err) {
      log.error({ err }, "guildMemberRemove");
    }
  });

  await initializeJapaneseRuntime({
    lifecycle,
    initTokenizer: async () => {
      if (config.SENRYU_ENABLED) await initKuromojiTokenizer(config.SENRYU_KUROMOJI_DICT_PATH, log);
    },
    startWorker: () => startJapaneseWorkerIfEnabled(config, log),
    logError: (error, message) => log.error({ err: error }, message),
  });

  log.info(
    {
      events: [
        "interactionCreate",
        "messageCreate",
        "messageUpdate",
        "messageDelete",
        "messageReactionAdd",
        "voiceStateUpdate",
        "guildBanAdd",
        "guildMemberUpdate",
        "guildMemberRemove",
      ],
    },
    "discord client event listeners registered",
  );

  return lifecycle;
}
