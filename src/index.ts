import "dotenv/config";
import { createDiscordClient } from "./bot/createClient.js";
import type { BotContext } from "./bot/context.js";
import { startPresenceRotation } from "./bot/presence.js";
import { syncGuildApplicationCommands } from "./bot/syncCommands.js";
import { handleSlashCommand } from "./commands/slashHandlers.js";
import { loadConfig } from "./core/config.js";
import { getGuildSettingsData } from "./core/guildSettings.js";
import { createKysely } from "./core/db/kysely.js";
import { createSqliteDatabase } from "./core/db/sqlite.js";
import { createLogger } from "./core/logger.js";
import { handleAuditLogEntry } from "./features/detecter/auditHandler.js";
import { handleEmojiGuardMessage, handleEmojiGuardReaction } from "./features/moderation/emojiGuard.js";
import { trackStampReaction } from "./features/stamps/trackReaction.js";
import { routeButton, routeModal } from "./interactions/handleComponents.js";
import { NoOpMessageLogRepository } from "./adapters/legacyDb/messageLogRepository.js";
import { NoOpVcRankingRepository } from "./adapters/legacyDb/vcRankingRepository.js";
import { handleAutoReply } from "./message/autoReply.js";
import { handleExtendedAutoReplies } from "./message/extendedAutoReply.js";
import { handlePrefixMessage } from "./message/prefixHandlers.js";

async function main(): Promise<void> {
  const log = createLogger();
  const config = loadConfig();
  const sqlite = createSqliteDatabase(config.DATABASE_PATH);
  const db = createKysely(sqlite);

  try {
    sqlite.prepare("SELECT 1").get();
  } catch (e) {
    log.error({ err: e }, "database ping failed");
    process.exit(1);
  }

  const client = createDiscordClient();
  const ctx: BotContext = {
    config,
    db,
    log,
    client,
    messageLog: new NoOpMessageLogRepository(),
    vcRanking: new NoOpVcRankingRepository(),
  };

  const debounceMs = config.COMMAND_SYNC_DEBOUNCE_MS;
  let presenceTimer: NodeJS.Timeout | undefined;

  client.once("ready", async () => {
    log.info({ tag: client.user?.tag }, "ready");
    const g = client.guilds.cache.get(config.GUILD_ID);
    if (!g) {
      log.error("Bot is not in GUILD_ID");
      if (config.GUILD_MISMATCH_POLICY !== "warn") {
        process.exit(1);
        return;
      }
    }
    const runSync = () => {
      syncGuildApplicationCommands(config).then(
        () => log.info("guild commands synced"),
        (err) => log.error({ err }, "command sync failed"),
      );
    };
    if (debounceMs > 0) {
      setTimeout(runSync, debounceMs);
    } else {
      runSync();
    }
    presenceTimer = startPresenceRotation(client, log, config.BOT_VERSION);
  });

  client.on("interactionCreate", async (interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        await handleSlashCommand(interaction, ctx);
        return;
      }
      if (interaction.isButton()) {
        await routeButton(interaction, ctx);
        return;
      }
      if (interaction.isModalSubmit()) {
        await routeModal(interaction, ctx);
        return;
      }
    } catch (err) {
      log.error({ err, id: interaction.id }, "interaction handler error");
      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "エラーが発生しました。", ephemeral: true }).catch(() => undefined);
      }
    }
  });

  client.on("messageCreate", async (message) => {
    try {
      if (await handlePrefixMessage(message, ctx)) return;
      if (await handleAutoReply(message, ctx)) return;
      if (await handleExtendedAutoReplies(message, ctx)) return;
      await handleEmojiGuardMessage(message, ctx);
    } catch (err) {
      log.error({ err }, "messageCreate");
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

  await client.login(config.DISCORD_TOKEN);

  const shutdown = async () => {
    log.info("shutting down");
    if (presenceTimer) clearInterval(presenceTimer);
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
