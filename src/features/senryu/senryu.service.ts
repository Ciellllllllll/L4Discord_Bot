import { ChannelType } from "discord.js";
import type { Message } from "discord.js";
import type { BotContext } from "../../bot/context.js";
import { analyzeSenryu } from "../japaneseAnalysis/japaneseAnalysisClient.js";
import { pickSenryuCandidate, senryuCandidate575MismatchScore } from "./senryu.detector.js";
import {
  expandUnknownKatakanaTokens,
  fetchKuromojiTokens,
  isKuromojiTokenizerReady,
} from "./senryu.kuromoji.js";
import {
  isChannelMutedBySettings,
  isChannelMutedForSenryu,
  muteChannelForSenryuPersisted,
} from "./senryu.filters.js";
import { getGuildSettingsData } from "../../core/guildSettings.js";
import { buildSenryuAiReviewUserBlock, reviewSenryuCandidateWithAi } from "./senryu.aiReview.js";
import { buildSenryuReviewContextExcerpt } from "./senryu.reviewContext.js";
import { senryuCandidateMatchesJsHaiku575 } from "./senryu.jsHaikuVerify.js";
import {
  containsDiscordTokens,
  containsSpoiler,
  normalizeSenryuText,
  replySenryu,
  stripSpoilerMarkers,
} from "./senryu.text.js";
import type { SenryuRepository } from "./senryu.repository.js";
import type { SenryuCandidate } from "./senryu.types.js";

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

async function isSenryuChannelMuted(ctx: BotContext, message: Message): Promise<boolean> {
  const channelIds = [message.channel.id];
  if (message.channel.isThread()) {
    const p = message.channel.parentId;
    if (p) channelIds.push(p);
  }
  if (channelIds.some((channelId) => isChannelMutedForSenryu(channelId))) return true;

  const guildId = message.guild?.id ?? message.guildId;
  if (!guildId || !("db" in ctx) || !ctx.db) return false;
  try {
    const settings = await getGuildSettingsData(ctx.db, guildId);
    return channelIds.some((channelId) => isChannelMutedBySettings(channelId, settings.senryu_muted_channel_ids));
  } catch (err) {
    ctx.log.warn({ err, guildId, channelId: message.channel.id }, "senryu muted channel settings load failed");
    return false;
  }
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
  if (await isSenryuChannelMuted(ctx, message)) {
    logSkip("channel_muted");
    return false;
  }
  if (containsDiscordTokens(content)) {
    logSkip("discord_tokens");
    return false;
  }

  const spoiler = containsSpoiler(content);
  const stripped = stripSpoilerMarkers(content);
  const normalized = normalizeSenryuText(stripped);

  async function detectWithKuromoji(): Promise<SenryuCandidate | null> {
    if (!isKuromojiTokenizerReady()) {
      log.warn(base, "senryu: kuromoji not ready");
      return null;
    }

    let tokens: import("./senryu.types.js").KuromojiToken[];
    try {
      tokens = await fetchKuromojiTokens(normalized);
    } catch (err) {
      log.error({ ...base, err }, "senryu tokenize failed");
      return null;
    }

    try {
      tokens = await expandUnknownKatakanaTokens(tokens, fetchKuromojiTokens);
    } catch (err) {
      log.error({ ...base, err }, "senryu expand unknown katakana failed");
      return null;
    }

    const moraTolerance = config.SENRYU_MORA_TOLERANCE === 1 ? 1 : 0;
    const kuromojiCandidate = pickSenryuCandidate(tokens, {
      moraTolerance,
      bestCandidate: config.SENRYU_BEST_CANDIDATE,
    });
    if (!kuromojiCandidate) {
      return null;
    }

    if (config.SENRYU_JS_HAIKU_VERIFY_ENABLED) {
      if (!senryuCandidateMatchesJsHaiku575(tokens, kuromojiCandidate)) {
        logSkip("js_haiku_mismatch");
        return null;
      }
    }

    if (config.SENRYU_AI_REVIEW_ENABLED) {
      // API 失敗・JSON 不正時は ai.ok が false のため reject せず、検出結果どおり通過する
      const contextExcerpt = buildSenryuReviewContextExcerpt(normalized, kuromojiCandidate);
      const reviewBlock = buildSenryuAiReviewUserBlock(contextExcerpt, tokens, kuromojiCandidate);
      const ai = await reviewSenryuCandidateWithAi(config, ctx.aiRouter, message.guildId!, log, reviewBlock);
      if (ai.ok && ai.verdict === "reject") {
        log.info(
          {
            ...base,
            candidateFormatted: kuromojiCandidate.formatted,
            aiReviewMs: ai.ms,
          },
          "senryu ai review rejected",
        );
        return null;
      }
    }

    return kuromojiCandidate;
  }

  async function detectWithWorker(): Promise<SenryuCandidate | null> {
    if (!config.JAPANESE_WORKER_ENABLED) {
      logSkip("japanese_worker_disabled");
      return config.SENRYU_WORKER_FALLBACK_ENABLED ? await detectWithKuromoji() : null;
    }
    const result = await analyzeSenryu(normalized, {
      baseUrl: config.JAPANESE_WORKER_URL,
      timeoutMs: config.JAPANESE_WORKER_TIMEOUT_MS,
    });
    if (!result.ok) {
      log.warn({ ...base, reason: result.reason, err: result.error }, "senryu worker failed");
      return config.SENRYU_WORKER_FALLBACK_ENABLED ? await detectWithKuromoji() : null;
    }
    if (!result.data.matched) {
      return config.SENRYU_WORKER_FALLBACK_ON_NO_MATCH ? await detectWithKuromoji() : null;
    }
    const phrases = result.data.phrases;
    if (phrases.length !== 3) {
      log.warn({ ...base, workerResponse: result.data }, "senryu worker invalid phrases");
      return config.SENRYU_WORKER_FALLBACK_ENABLED ? await detectWithKuromoji() : null;
    }
    if (config.SENRYU_JS_HAIKU_VERIFY_ENABLED) {
      log.info(base, "senryu worker mode skips js-haiku verify");
    }
    if (config.SENRYU_AI_REVIEW_ENABLED) {
      log.info(base, "senryu worker mode skips ai review");
    }
    return {
      kamigo: phrases[0]!,
      nakashichi: phrases[1]!,
      shimogo: phrases[2]!,
      formatted: result.data.text ?? phrases.join(" "),
      tokenSpan: { start: 0, end: 0 },
      moraUsed: [5, 7, 5],
    };
  }

  const candidate = config.SENRYU_DETECTOR_MODE === "go-worker"
    ? await detectWithWorker()
    : await detectWithKuromoji();

  if (!candidate) {
    return false;
  }

  const moraTolerance = config.SENRYU_DETECTOR_MODE === "go-worker"
    ? 0
    : config.SENRYU_MORA_TOLERANCE === 1 ? 1 : 0;

  log.info(
    {
      ...base,
      candidateFormatted: candidate.formatted,
      contentLength: content.length,
      senryuMoraTolerance: moraTolerance,
      senryuBestCandidate: config.SENRYU_BEST_CANDIDATE,
      senryu575MismatchScore: senryuCandidate575MismatchScore(candidate),
      senryuMoraUsed: candidate.moraUsed,
    },
    "senryu 575 detected",
  );

  let savedId: string | undefined;

  if (config.SENRYU_SAVE_ENABLED) {
    try {
      const rec = await repo.saveSenryu({
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
        await repo.deleteSenryu(savedId);
        log.info({ ...base, recordId: savedId }, "senryu rollback ok");
      } catch (rbErr) {
        log.error({ ...base, err: rbErr, recordId: savedId }, "senryu rollback failed");
      }
    }

    if (config.SENRYU_AUTO_MUTE_ON_PERMISSION_ERROR && isPermissionLikeDiscordError(err)) {
      await muteChannelForSenryuPersisted(ctx.db, message.guild!.id, message.channel.id).catch((persistErr) => {
        log.warn({ ...base, err: persistErr, channelId: message.channel.id }, "senryu auto-mute persist failed");
      });
      log.warn({ ...base, channelId: message.channel.id }, "senryu auto-muted channel after permission error");
    }

    return false;
  }
}
