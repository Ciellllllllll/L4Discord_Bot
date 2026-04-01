import { ChannelType } from "discord.js";
import type { Message } from "discord.js";
import type { BotContext } from "../../bot/context.js";
import { detectFirst575 } from "./senryu.detector.js";
import {
  expandUnknownKatakanaTokens,
  fetchKuromojiTokens,
  isKuromojiTokenizerReady,
} from "./senryu.kuromoji.js";
import {
  isChannelMutedForSenryu,
  isDetectionOptedOut,
  muteChannelForSenryu,
} from "./senryu.filters.js";
import { normalizeSenryuText } from "./senryu.normalizer.js";
import { containsDiscordTokens, containsSpoiler, stripSpoilerMarkers } from "./senryu.regex.js";
import { replySenryu } from "./senryu.reply.js";
import type { SenryuRepository } from "./senryu.repository.js";

function isPermissionLikeDiscordError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: number; message?: string };
  if (e.code === 50001 || e.code === 50013) return true;
  const m = e.message ?? "";
  if (/missing access/i.test(m)) return true;
  if (/missing permissions/i.test(m)) return true;
  if (/reply/i.test(m) && /permission/i.test(m)) return true;
  return false;
}

function isSenryuChannelMuted(message: Message): boolean {
  if (isChannelMutedForSenryu(message.channel.id)) return true;
  if (message.channel.isThread()) {
    const p = message.channel.parentId;
    if (p && isChannelMutedForSenryu(p)) return true;
  }
  return false;
}

export async function runSenryuPipeline(
  ctx: BotContext,
  message: Message,
  repo: SenryuRepository,
): Promise<boolean> {
  const { log, config } = ctx;
  const base = {
    guildId: message.guildId ?? "",
    channelId: message.channel.id,
    messageId: message.id,
    authorId: message.author.id,
  };

  const logSkip = (reason: string): void => {
    log.info(
      {
        ...base,
        reason,
        contentLength: message.content.length,
      },
      "senryu skipped",
    );
  };

  if (!message.author) {
    logSkip("no_author");
    return false;
  }
  if (message.author.bot) {
    logSkip("author_bot");
    return false;
  }
  if (
    message.channel.type === ChannelType.DM ||
    message.channel.type === ChannelType.GroupDM
  ) {
    logSkip("dm_or_group_dm");
    return false;
  }
  if (!config.SENRYU_ENABLED) {
    logSkip("senryu_disabled");
    return false;
  }
  if (!message.guild || message.guild.id !== config.GUILD_ID) {
    logSkip("guild_mismatch");
    return false;
  }

  const content = message.content;
  if (!content.trim()) {
    logSkip("empty_content");
    return false;
  }
  if (content.length > config.SENRYU_MAX_CONTENT_LENGTH) {
    logSkip("content_too_long");
    return false;
  }
  if (isSenryuChannelMuted(message)) {
    logSkip("channel_muted");
    return false;
  }
  if (await isDetectionOptedOut(message.guild.id, message.author.id)) {
    logSkip("user_opted_out");
    return false;
  }
  if (containsDiscordTokens(content)) {
    logSkip("discord_tokens");
    return false;
  }

  const spoiler = containsSpoiler(content);
  const stripped = stripSpoilerMarkers(content);
  const normalized = normalizeSenryuText(stripped);

  if (!isKuromojiTokenizerReady()) {
    log.warn(base, "senryu: kuromoji not ready");
    return false;
  }

  let tokens: import("./senryu.types.js").KuromojiToken[];
  try {
    tokens = await fetchKuromojiTokens(normalized);
  } catch (err) {
    log.error({ ...base, err }, "senryu tokenize failed");
    return false;
  }

  try {
    tokens = await expandUnknownKatakanaTokens(tokens, fetchKuromojiTokens);
  } catch (err) {
    log.error({ ...base, err }, "senryu expand unknown katakana failed");
    return false;
  }

  const candidate = detectFirst575(tokens);
  if (!candidate) {
    return false;
  }

  log.info(
    {
      ...base,
      candidateFormatted: candidate.formatted,
      contentLength: content.length,
    },
    "senryu 575 detected",
  );

  let savedId: string | undefined;

  if (config.SENRYU_SAVE_ENABLED) {
    try {
      const rec = repo.saveSenryu({
        guildId: message.guild!.id,
        channelId: message.channel.id,
        messageId: message.id,
        authorId: message.author.id,
        kamigo: candidate.kamigo,
        nakashichi: candidate.nakashichi,
        shimogo: candidate.shimogo,
        formatted: candidate.formatted,
        sourceContent: content,
        spoiler,
        detectedAt: new Date().toISOString(),
      });
      savedId = rec.id;
      log.info(
        { ...base, recordId: savedId, candidateFormatted: candidate.formatted },
        "senryu save ok",
      );
    } catch (err) {
      log.error({ ...base, err }, "senryu save failed");
      return false;
    }
  }

  if (!config.SENRYU_REPLY_ENABLED) {
    return true;
  }

  try {
    await replySenryu(message, candidate, spoiler);
    log.info({ ...base, candidateFormatted: candidate.formatted }, "senryu reply ok");
    return true;
  } catch (err) {
    log.error(
      {
        ...base,
        err,
        errorCode: (err as { code?: number }).code,
        candidateFormatted: candidate.formatted,
      },
      "senryu reply failed",
    );

    if (savedId) {
      try {
        repo.deleteSenryu(savedId);
        log.info({ ...base, recordId: savedId }, "senryu rollback ok");
      } catch (rbErr) {
        log.error({ ...base, err: rbErr, recordId: savedId }, "senryu rollback failed");
      }
    }

    if (config.SENRYU_AUTO_MUTE_ON_PERMISSION_ERROR && isPermissionLikeDiscordError(err)) {
      muteChannelForSenryu(message.channel.id);
      log.warn({ ...base, channelId: message.channel.id }, "senryu auto-muted channel after permission error");
    }

    return false;
  }
}
