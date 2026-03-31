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
import { getGuildSettingsData } from "./core/guildSettings.js";
import { createKysely } from "./core/db/kysely.js";
import { applyPendingSqliteMigrations, getSqliteUserVersion } from "./core/db/sqliteMigrations.js";
import { createSqliteDatabase } from "./core/db/sqlite.js";
import { createLogger } from "./core/logger.js";
import { handleAuditLogEntry } from "./features/detecter/auditHandler.js";
import { handleEmojiGuardMessage, handleEmojiGuardReaction } from "./features/moderation/emojiGuard.js";
import { trackStampReaction } from "./features/stamps/trackReaction.js";
import {
  routeButton,
  routeChannelSelectMenu,
  routeModal,
  routeStringSelectMenu,
} from "./interactions/handleComponents.js";
import { SqliteMessageLogRepository } from "./adapters/legacyDb/sqliteMessageLogRepository.js";
import { SqliteVcRankingRepository } from "./adapters/legacyDb/sqliteVcRankingRepository.js";
import { ingestMessageCreate, ingestMessageDelete, ingestMessageUpdate } from "./features/messageLog/ingest.js";
import { reconcilePanelsForGuild } from "./features/panels/panelService.js";
import { handleReactionRoleAdd } from "./features/reactionRoles/reactionRoleRoute.js";
import { startReminderScheduler } from "./features/reminders/reminderScheduler.js";
import { trackVoiceStateUpdate } from "./features/vc/voiceSessionTracker.js";
import { handleAutoReply } from "./message/autoReply.js";
import { handleExtendedAutoReplies } from "./message/extendedAutoReply.js";
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
    { botVersion: config.BOT_VERSION, guildId: config.GUILD_ID, databasePath: config.DATABASE_PATH },
    "config loaded",
  );

  const sqlite = createSqliteDatabase(config.DATABASE_PATH);
  const db = createKysely(sqlite);

  try {
    sqlite.prepare("SELECT 1").get();
    log.info({ path: config.DATABASE_PATH }, "sqlite connection ok");
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
      ],
    },
    "discord client created",
  );
  const ctx: BotContext = {
    config,
    db,
    sqlite,
    log,
    client,
    messageLog: new SqliteMessageLogRepository(sqlite),
    vcRanking: new SqliteVcRankingRepository(sqlite),
  };
  log.info("repositories: message log (sqlite), VC ranking (sqlite)");

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
      if (message.guildId === config.GUILD_ID && !message.author.bot) {
        const s = await getGuildSettingsData(db, message.guildId);
        const ex = s.message_log_excluded_channel_ids ?? [];
        ingestMessageCreate(sqlite, message, config.GUILD_ID, ex);
      }
      if (await handlePrefixMessage(message, ctx)) return;
      if (await handleAutoReply(message, ctx)) return;
      if (await handleExtendedAutoReplies(message, ctx)) return;
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
      ingestMessageUpdate(sqlite, message, config.GUILD_ID, ex);
    } catch (err) {
      log.error({ err }, "messageUpdate");
    }
  });

  client.on("messageDelete", async (message) => {
    try {
      if (!message.guildId || message.guildId !== config.GUILD_ID) return;
      const s = await getGuildSettingsData(db, message.guildId);
      const ex = s.message_log_excluded_channel_ids ?? [];
      ingestMessageDelete(sqlite, message, config.GUILD_ID, ex);
    } catch (err) {
      log.error({ err }, "messageDelete");
    }
  });

  client.on("messageReactionAdd", async (reaction, user) => {
    try {
      const u = user.partial ? await user.fetch() : user;
      await handleReactionRoleAdd(reaction, u, ctx);
      await handleEmojiGuardReaction(reaction, u, ctx);
      await trackStampReaction(reaction, u, ctx);
    } catch (err) {
      log.error({ err }, "messageReactionAdd");
    }
  });

  client.on("voiceStateUpdate", (oldS, newS) => {
    try {
      trackVoiceStateUpdate(sqlite, oldS, newS, config.GUILD_ID);
    } catch (err) {
      log.error({ err }, "voiceStateUpdate");
    }
  });

  client.on("guildAuditLogEntryCreate", async (entry, guild) => {
    try {
      await handleAuditLogEntry(entry, guild, client, ctx);
    } catch (err) {
      log.error({ err }, "guildAuditLogEntryCreate");
    }
  });

  client.on("guildMemberRemove", async (member) => {
    try {
      if (member.guild.id !== config.GUILD_ID) return;
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
        "guildAuditLogEntryCreate",
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
    client.destroy();
    await db.destroy();
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
