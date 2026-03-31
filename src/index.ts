import { execSync } from "node:child_process";
import "dotenv/config";

if (process.platform === "win32") {
  try {
    execSync("cmd /c chcp 65001>nul", { stdio: "ignore", windowsHide: true });
  } catch {
    /* ignore */
  }
}
import { createDiscordClient } from "./bot/createClient.js";
import type { BotContext } from "./bot/context.js";
import { startPresenceRotation } from "./bot/presence.js";
import { syncGuildApplicationCommands } from "./bot/syncCommands.js";
import { handleSlashCommand } from "./commands/slashHandlers.js";
import { loadConfig } from "./core/config.js";
import { getReleaseBundleForLog } from "./core/releaseVersions.js";
import { getGuildSettingsData } from "./core/guildSettings.js";
import { createKysely } from "./core/db/kysely.js";
import { applyPendingSqliteMigrations, getSqliteUserVersion } from "./core/db/sqliteMigrations.js";
import { createSqliteDatabase } from "./core/db/sqlite.js";
import { createLogger } from "./core/logger.js";
import { getDetecterService } from "./features/detecter/detecterService.js";
import { handleEmojiGuardMessage, handleEmojiGuardReaction } from "./features/moderation/emojiGuard.js";
import { trackStampReaction } from "./features/stamps/trackReaction.js";
import {
  routeButton,
  routeChannelSelectMenu,
  routeModal,
  routeStringSelectMenu,
} from "./interactions/handleComponents.js";
import { SqliteVcRankingRepository } from "./adapters/legacyDb/sqliteVcRankingRepository.js";
import {
  hydrateMessageIfPartial,
  ingestMessageCreate,
  ingestMessageDelete,
  ingestMessageUpdate,
  prepareMessageLogsDatabase,
} from "./features/messageLog/index.js";
import { reconcilePanelsForGuild } from "./features/panels/panelService.js";
import { startReminderScheduler } from "./features/reminders/reminderScheduler.js";
import { VcTemporaryChannelManager } from "./features/vc/vcTemporaryChannelManager.js";
import { ensureVcTimeSchema } from "./features/vc/vcTimeSchema.js";
import {
  endOpenVcSessionForMember,
  reconcileVcTimeSessionsAtReady,
  trackVoiceStateUpdate,
} from "./features/vc/voiceSessionTracker.js";
import { handleAutoReply } from "./message/autoReply.js";
import { handleExtendedAutoReplies } from "./message/extendedAutoReply.js";
import {
  resolveAiHistoryAdminChannelId,
  sendOrReconnectAiHistoryAdminPanel,
} from "./features/ai/aiHistoryAdminPanel.js";
import { handleAiChatMonitorMessage } from "./features/ai/aiQueryService.js";
import { restoreModmailUiState } from "./features/modmail/modmailRestore.js";
import { cancelPendingRepliesBySource, routeModmailGuildThreadMessage } from "./features/modmail/modmailStaffFlow.js";
import { handleModmailDmMessage } from "./features/modmail/modmailService.js";
import { handlePrefixMessage } from "./message/prefixHandlers.js";

let mainStarted = false;

async function main(): Promise<void> {
  if (mainStarted) {
    console.error("main() は既に起動済みです。二重起動を無視します。");
    return;
  }
  mainStarted = true;

  const log = createLogger();
  const config = loadConfig();
  log.info(
    {
      effectiveBotVersion: config.BOT_VERSION,
      guildId: config.GUILD_ID,
      databasePath: config.DATABASE_PATH,
      messageLogDbPath: config.MESSAGE_LOG_DB_PATH,
      vcTimeDbPath: config.VC_TIME_DATABASE_PATH,
      release: getReleaseBundleForLog(),
    },
    "config loaded (BOT_VERSION = code default or env override; release bundle from TypeScript)",
  );

  const sqlite = createSqliteDatabase(config.DATABASE_PATH);
  const messageLogSqlite = createSqliteDatabase(config.MESSAGE_LOG_DB_PATH);
  const vcTimeSqlite = createSqliteDatabase(config.VC_TIME_DATABASE_PATH);
  ensureVcTimeSchema(vcTimeSqlite);
  prepareMessageLogsDatabase(messageLogSqlite);
  const db = createKysely(sqlite);

  try {
    sqlite.prepare("SELECT 1").get();
    messageLogSqlite.prepare("SELECT 1").get();
    vcTimeSqlite.prepare("SELECT 1").get();
    log.info(
      {
        main: config.DATABASE_PATH,
        messageLog: config.MESSAGE_LOG_DB_PATH,
        vcTime: config.VC_TIME_DATABASE_PATH,
      },
      "sqlite connection ok",
    );
  } catch (e) {
    log.error({ err: e }, "database ping failed");
    process.exit(1);
  }

  try {
    const beforeV = getSqliteUserVersion(sqlite);
    const applied = applyPendingSqliteMigrations(sqlite);
    const afterV = getSqliteUserVersion(sqlite);
    if (applied.length > 0) {
      log.info({ applied, userVersion: afterV, previousVersion: beforeV }, "sqlite migrations applied");
    } else {
      log.info({ userVersion: afterV }, "sqlite schema up to date (no pending migrations)");
    }
  } catch (e) {
    log.error({ err: e }, "sqlite migration failed");
    process.exit(1);
  }

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
  const vcTemp = new VcTemporaryChannelManager(db, log, client, config);
  const ctx: BotContext = {
    config,
    db,
    sqlite,
    messageLogSqlite,
    vcTimeSqlite,
    log,
    client,
    vcRanking: new SqliteVcRankingRepository(vcTimeSqlite),
    vcTemp,
  };
  log.info("repositories: message log (message.db), VC ranking (vc_time.db)");

  const debounceMs = config.COMMAND_SYNC_DEBOUNCE_MS;
  let presenceTimer: NodeJS.Timeout | undefined;
  let reminderTimer: NodeJS.Timeout | undefined;

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
      try {
        await restoreModmailUiState(ctx);
        log.info({ guildId: g.id }, "modmail UI restore on startup completed");
      } catch (err) {
        log.warn({ err, guildId: g.id }, "modmail UI restore on startup failed");
      }
      if (resolveAiHistoryAdminChannelId(config)) {
        try {
          await sendOrReconnectAiHistoryAdminPanel(ctx);
          log.info({ guildId: g.id }, "ai query history admin panel reconciled");
        } catch (err) {
          log.warn({ err, guildId: g.id }, "ai query history admin panel failed");
        }
      }
      try {
        reconcileVcTimeSessionsAtReady(client, vcTimeSqlite, config.GUILD_ID);
        log.info({ guildId: g.id }, "vc_time sessions reconciled at startup");
      } catch (err) {
        log.error({ err, guildId: g.id }, "vc_time reconcile at startup failed");
      }
      vcTemp.startSweep();
    }
    const runSync = () => {
      void syncGuildApplicationCommands(config, log);
    };
    if (debounceMs > 0) {
      log.info({ debounceMs }, "guild slash command sync scheduled");
      setTimeout(runSync, debounceMs);
    } else {
      void runSync();
    }
    presenceTimer = startPresenceRotation(client, log, config.BOT_VERSION);
    reminderTimer = startReminderScheduler(ctx);
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
        await interaction.reply({ content: "エラーが発生しました。", ephemeral: true }).catch(() => undefined);
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
        ingestMessageCreate(messageLogSqlite, message, {
          targetGuildId: config.GUILD_ID,
          excludedChannelIds: ex,
          botUserId: client.user?.id ?? "",
        });
        if (await routeModmailGuildThreadMessage(message, ctx)) return;
      }
      if (await handlePrefixMessage(message, ctx)) return;
      if (await handleAutoReply(message, ctx)) return;
      if (await handleExtendedAutoReplies(message, ctx)) return;
      if (await handleAiChatMonitorMessage(message, ctx)) return;
      await handleEmojiGuardMessage(message, ctx);
    } catch (err) {
      log.error({ err }, "messageCreate");
    }
  });

  client.on("messageUpdate", async (_old, message) => {
    try {
      if (!message.guildId || message.author?.bot) return;
      if (message.guildId !== config.GUILD_ID) return;
      const s = await getGuildSettingsData(db, message.guildId);
      const ex = s.message_log_excluded_channel_ids ?? [];
      ingestMessageUpdate(messageLogSqlite, message, {
        targetGuildId: config.GUILD_ID,
        excludedChannelIds: ex,
        botUserId: client.user?.id ?? "",
      });
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
      ingestMessageDelete(messageLogSqlite, target, {
        targetGuildId: config.GUILD_ID,
        excludedChannelIds: ex,
        botUserId: client.user?.id ?? "",
      });
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
      trackVoiceStateUpdate(vcTimeSqlite, oldS, newS, config.GUILD_ID);
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
      endOpenVcSessionForMember(vcTimeSqlite, member.guild.id, member.id);
      const s = await getGuildSettingsData(db, member.guild.id);
      const chId = s.member_leave_channel_id as string | undefined;
      if (!chId) return;
      const ch = await member.guild.channels.fetch(chId).catch(() => null);
      if (ch?.isTextBased()) {
        await ch.send({
          embeds: [
            {
              title: "メンバーが退出しました",
              description: `${member.user.tag} (${member.id})`,
              color: 0x888888,
            },
          ],
        });
      }
    } catch (err) {
      log.error({ err }, "guildMemberRemove");
    }
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

  log.info("connecting to Discord (login)…");
  await client.login(config.DISCORD_TOKEN);
  log.info("discord login call returned (awaiting clientReady for full readiness)");

  const shutdown = async () => {
    log.info("shutting down");
    if (presenceTimer) clearInterval(presenceTimer);
    if (reminderTimer) clearInterval(reminderTimer);
    ctx.vcTemp.stopSweep();
    client.destroy();
    await db.destroy();
    messageLogSqlite.close();
    vcTimeSqlite.close();
    sqlite.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
