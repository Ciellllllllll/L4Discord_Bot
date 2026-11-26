import type { BotContext } from "./context.js";
import type { createRuntimeResourceLifecycle } from "./runtimeLifecycle.js";
import type { RuntimeHandlerHandle } from "./runtimeLifecycle.js";
import type { UtilitiesMessageBundle } from "../features/utilities/utilitiesMessage.js";
import { respondToInteractionError } from "./interactionErrors.js";
import { initializeJapaneseRuntime } from "./clientReadyServices.js";
import { handleSlashCommand } from "../commands/slashHandlers.js";
import { getGuildSettingsData } from "../core/guildSettings.js";
import { getDetecterService } from "../features/detecter/detecterService.js";
import { startJapaneseWorkerIfEnabled } from "../features/japaneseAnalysis/japaneseWorkerProcess.js";
import { cancelPendingRepliesBySource, routeModmailGuildThreadMessage } from "../features/modmail/modmailStaffFlow.js";
import { handleModmailDmMessage } from "../features/modmail/modmailService.js";
import { handleAutoModerationMessage } from "../features/moderation/autoModerationMessage.js";
import { handleEmojiGuardMessage, handleEmojiGuardReaction } from "../features/moderation/emojiGuard.js";
import { handlePacchiMessage } from "../features/pacchi/pacchi.message-handler.js";
import { handleSenryuMessage } from "../features/senryu/senryu.message-handler.js";
import { initKuromojiTokenizer } from "../features/senryu/senryu.kuromoji.js";
import { trackStampMessage, trackStampReaction } from "../features/stamps/trackReaction.js";
import { runUtilitiesMessageChain, runUtilitiesMessageUpdate } from "../features/utilities/utilitiesMessage.js";
import { sendMemberLeaveEmbed } from "../features/utilities/leaveNotifier.js";
import { endOpenVcSessionForMemberPostgres, trackVoiceStateUpdatePostgres } from "../features/vc/voiceSessionTracker.js";
import { handleZigAutoReply } from "../features/zig/zigAutoReply.js";
import { routeButton, routeChannelSelectMenu, routeModal, routeStringSelectMenu } from "../interactions/handleComponents.js";
import { handlePrefixMessage } from "../message/prefixHandlers.js";
import { handleAiChatMonitorMessage } from "../features/ai/aiQueryHandlers.js";
import { hydrateMessageIfPartial, ingestMessageCreatePostgres, ingestMessageDeletePostgres, ingestMessageUpdatePostgres } from "../features/messageLog/messageLogsCore.js";
import { scheduleArchiveMessageAttachmentsPostgres } from "../features/messageLog/messageAttachmentArchive.js";

// Discord のイベントハンドラ登録。

export async function registerClientEventHandlers(
  ctx: BotContext,
  lifecycle: ReturnType<typeof createRuntimeResourceLifecycle>,
  utilitiesBundle: UtilitiesMessageBundle,
): Promise<RuntimeHandlerHandle> {
  const { config, log, client, db, messageLogPgPool, messageAttachmentPgPool, vcTimePgPool } = ctx;

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
      if (interaction.isRepliable()) {
        await respondToInteractionError(interaction, (error, method) => {
          log.warn({ err: error, interactionId: interaction.id, method }, "interaction error response failed");
        });
      }
    }
  });

  const getMessageLogOptions = async (guildId: string) => {
    const s = await getGuildSettingsData(db, guildId);
    return {
      targetGuildId: config.GUILD_ID,
      excludedChannelIds: s.message_log_excluded_channel_ids ?? [],
      botUserId: client.user?.id ?? "",
    };
  };

  const archiveAttachmentsIfEnabled = (message: Parameters<typeof scheduleArchiveMessageAttachmentsPostgres>[2]) => {
    if (!config.MESSAGE_ATTACHMENT_ARCHIVE_ENABLED) return;
    scheduleArchiveMessageAttachmentsPostgres(
      messageAttachmentPgPool,
      config.MESSAGE_ATTACHMENT_FILES_DIR,
      message,
      log,
    );
  };

  client.on("messageCreate", async (message) => {
    try {
      if (!message.guild && !message.author.bot) {
        if (await handleModmailDmMessage(ctx, message)) return;
      }
      if (message.guildId === config.GUILD_ID && !message.author.bot) {
        const messageLogOptions = await getMessageLogOptions(message.guildId);
        await ingestMessageCreatePostgres(messageLogPgPool, message, messageLogOptions);
        archiveAttachmentsIfEnabled(message);
        await trackStampMessage(message, ctx);
        if (await routeModmailGuildThreadMessage(message, ctx)) return;
      }
      if (await handlePrefixMessage(message, ctx)) return;
      if (await handleZigAutoReply(message, ctx)) return;
      if (await handlePacchiMessage(ctx, message)) return;
      await runUtilitiesMessageChain(utilitiesBundle, message);
      if (await handleSenryuMessage(ctx, message)) return;
      if (await handleAiChatMonitorMessage(message, ctx)) return;
      await handleAutoModerationMessage(message, ctx);
      await handleEmojiGuardMessage(message, ctx);
    } catch (err) {
      log.error({ err }, "messageCreate");
    }
  });

  client.on("messageUpdate", async (oldMessage, newMessage) => {
    void runUtilitiesMessageUpdate(utilitiesBundle, oldMessage, newMessage);
    try {
      const message = newMessage;
      if (!message.guildId || message.author?.bot) return;
      if (message.guildId !== config.GUILD_ID) return;
      const messageLogOptions = await getMessageLogOptions(message.guildId);
      await ingestMessageUpdatePostgres(messageLogPgPool, message, messageLogOptions);
      archiveAttachmentsIfEnabled(message);
    } catch (err) {
      log.error({ err }, "messageUpdate");
    }
  });

  client.on("messageDelete", async (message) => {
    void utilitiesBundle.expansions.onDelete(message).catch((err) => log.warn({ err }, "link expansion delete failed"));
    try {
      if (!message.guildId || message.guildId !== config.GUILD_ID) return;
      const messageLogOptions = await getMessageLogOptions(message.guildId);
      const target = await hydrateMessageIfPartial(message);
      await cancelPendingRepliesBySource(ctx, target.id);
      await ingestMessageDeletePostgres(messageLogPgPool, target, messageLogOptions);
      archiveAttachmentsIfEnabled(target);
    } catch (err) {
      log.error({ err }, "messageDelete");
    }
  });

  client.on("messageDeleteBulk", async (messages) => {
    await Promise.all([...messages.values()].map((message) =>
      utilitiesBundle.expansions.onDelete(message).catch((err) => log.warn({ err }, "link expansion bulk delete failed"))));
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
      void trackVoiceStateUpdatePostgres(vcTimePgPool, oldS, newS, config.GUILD_ID).catch((err) => {
        log.error({ err }, "voiceStateUpdate postgres tracking");
      });
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
      await endOpenVcSessionForMemberPostgres(vcTimePgPool, member.guild.id, member.id);
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

  return lifecycle;
}
