import type { Message } from "discord.js";
import type { BotContext } from "../../bot/context.js";
import { analyzeMorph, analyzeSenryu } from "../japaneseAnalysis/japaneseAnalysisClient.js";
import { pacchiAiFinalCheck } from "./pacchi.aiFinalCheck.js";
import { extractPhrase, extractWords, isLearnableMessage } from "./pacchi.filters.js";
import { buildPacchiGeneratedReply } from "./pacchi.generator.js";
import { buildSentencePattern, toLearnableLexiconTokens } from "./pacchi.japaneseLearning.js";
import { createPacchiRepositoryForContext, type PacchiRepositoryLike } from "./pacchi.repository.js";
import { appendRandomEmojiAtEnd, buildPacchiReply, formatDuration, janken, RATE_CONFIG } from "./pacchi.reply.js";
import { isUnsafeForPacchiLearning } from "./pacchi.safety.js";
import {
  extractJanken,
  extractNaturalPoem,
  extractTermQuestion,
  isWorkEnd,
  isWorkStart,
} from "./pacchi.triggers.js";
import { handleWorkEnd, handleWorkStart } from "./pacchi.prefix.js";
import { buildVerifiedPacchiPoem, pacchiVerifiedPoemFailureMessage } from "./pacchi.poem.js";
import type { PacchiLearnedEmoji } from "./pacchi.types.js";

const lastSpokeByChannel = new Map<string, number>();
const lastAutoReplyUserByChannel = new Map<string, string>();
const WIKIPEDIA_RANDOM_REPLY_CHANCE = 0.01;

type WikipediaSummary = {
  title?: string;
  extract?: string;
  content_urls?: {
    desktop?: {
      page?: string;
    };
    mobile?: {
      page?: string;
    };
  };
};

function isSelfAuthoredMessage(ctx: BotContext, message: Message): boolean {
  return message.author.bot || message.author.id === ctx.client.user?.id || Boolean(message.webhookId) || message.system;
}

async function sendPacchiReply(message: Message, content: string, emoji: string | null): Promise<void> {
  await message.reply({ content: appendRandomEmojiAtEnd(content, emoji), allowedMentions: { parse: [] } });
}

function canSpeak(channelId: string, cooldownSeconds: number): boolean {
  const last = lastSpokeByChannel.get(channelId) ?? 0;
  return Date.now() - last >= cooldownSeconds * 1000;
}

function markSpoke(channelId: string): void {
  lastSpokeByChannel.set(channelId, Date.now());
}

function wikipediaSummaryBaseUrl(ctx: BotContext): string {
  return ctx.config.PACCHI_WIKIPEDIA_API_BASE_URL.replace(/\/+$/, "");
}

function wikipediaRandomSummaryUrl(ctx: BotContext): string {
  const baseUrl = wikipediaSummaryBaseUrl(ctx);
  if (baseUrl.endsWith("/page/summary")) {
    return `${baseUrl.slice(0, -"/page/summary".length)}/page/random/summary`;
  }
  return `${baseUrl}/random`;
}

function formatWikipediaSummary(data: WikipediaSummary, fallbackTitle: string): string {
  const extract = data.extract?.replace(/\s+/g, " ").trim();
  if (!extract) return "ぱっちぃにはわからん";
  const short = extract.split("。").filter(Boolean).slice(0, 2).join("。");
  const link = data.content_urls?.desktop?.page ?? data.content_urls?.mobile?.page;
  return [
    `${data.title ?? fallbackTitle}: ${short}${short ? "。" : ""}`,
    link ? `記事: ${link}` : null,
  ].filter((line): line is string => Boolean(line)).join("\n");
}

async function fetchWikipediaSummary(url: string): Promise<WikipediaSummary | null> {
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) return null;
  return await response.json() as WikipediaSummary;
}

async function explainTerm(ctx: BotContext, term: string): Promise<string> {
  const baseUrl = ctx.config.PACCHI_WIKIPEDIA_API_BASE_URL.replace(/\/+$/, "");
  const url = `${baseUrl}/${encodeURIComponent(term)}`;
  try {
    const data = await fetchWikipediaSummary(url);
    if (!data) return "ぱっちぃにはわからん";
    return formatWikipediaSummary(data, term);
  } catch {
    return "ぱっちぃにはわからん";
  }
}

async function randomWikipediaReply(ctx: BotContext): Promise<string | null> {
  try {
    const data = await fetchWikipediaSummary(wikipediaRandomSummaryUrl(ctx));
    if (!data) return null;
    return `ぱっちぃ、これ見つけた\n${formatWikipediaSummary(data, data.title ?? "Wikipedia")}`;
  } catch {
    return null;
  }
}

function extractGuildSafeEmojis(message: Message): PacchiLearnedEmoji[] {
  const out = new Map<string, PacchiLearnedEmoji>();
  const customEmojiPattern = /<a?:([A-Za-z0-9_~]+):(\d+)>/g;
  for (const match of message.content.matchAll(customEmojiPattern)) {
    const id = match[2];
    const display = match[0];
    if (!id || !display) continue;
    if (!message.guild?.emojis.cache.has(id)) continue;
    out.set(`custom:${id}`, { key: `custom:${id}`, kind: "custom", display });
  }

  const unicodeMatches = message.content.match(/\p{Emoji_Presentation}|\p{Extended_Pictographic}/gu) ?? [];
  for (const display of unicodeMatches) {
    out.set(`unicode:${display}`, { key: `unicode:${display}`, kind: "unicode", display });
  }

  for (const sticker of message.stickers.values()) {
    if (!message.guild?.stickers.cache.has(sticker.id)) continue;
    out.set(`sticker:${sticker.id}`, { key: `sticker:${sticker.id}`, kind: "sticker", display: sticker.name });
  }

  return [...out.values()].slice(0, 10);
}

function isReplyEmojiAvailable(message: Message, emoji: string | null): boolean {
  if (!emoji) return false;
  const customMatch = emoji.match(/^<a?:[A-Za-z0-9_~]+:(\d+)>$/);
  if (!customMatch) return true;
  const id = customMatch[1];
  return Boolean(id && message.guild?.emojis.cache.has(id));
}

async function maybeAiCheckedPacchiReply(
  ctx: BotContext,
  repo: PacchiRepositoryLike,
  guildId: string,
  reply: string,
): Promise<string> {
  if (!ctx.config.PACCHI_AI_FINAL_CHECK_ENABLED) return reply;
  const accepted = await pacchiAiFinalCheck(ctx.aiRouter, guildId, ctx.log, reply);
  if (accepted) return reply;
  return buildPacchiReply(await repo.pickWord(guildId));
}

function extractPacchiSenryuSubmission(content: string): string | null {
  const trimmed = content.trim();
  const match = trimmed.match(/^ぱっちぃ\s*(?:575|川柳)\s*\n([\s\S]+)$/);
  if (!match) return null;
  const body = match[1]?.trim();
  if (!body) return null;
  return body;
}

async function tryHandlePacchiSenryuSubmission(
  ctx: BotContext,
  message: Message,
  repo: PacchiRepositoryLike,
  content: string,
  replyEmoji: string | null,
): Promise<boolean> {
  const submission = extractPacchiSenryuSubmission(content);
  if (!submission) return false;
  if (!ctx.config.JAPANESE_WORKER_ENABLED) {
    return false;
  }
  const result = await analyzeSenryu(submission, {
    baseUrl: ctx.config.JAPANESE_WORKER_URL,
    timeoutMs: ctx.config.JAPANESE_WORKER_TIMEOUT_MS,
  });
  if (!result.ok) {
    ctx.log.warn({ reason: result.reason, err: result.error }, "pacchi 575 worker failed");
    await sendPacchiReply(message, "575、いま数えられないかも", replyEmoji);
    return true;
  }
  if (!result.data.matched) {
    await sendPacchiReply(message, "575じゃないかも…ぼくの数えまちがいかも", replyEmoji);
    return true;
  }
  const phrases = result.data.phrases;
  await repo.saveSenryuSubmission({
    guildId: message.guildId!,
    channelId: message.channelId,
    messageId: message.id,
    authorId: message.author.id,
    kamigo: phrases[0]!,
    nakashichi: phrases[1]!,
    shimogo: phrases[2]!,
    formatted: result.data.text ?? phrases.join(" "),
    sourceContent: submission,
  });
  await sendPacchiReply(message, "575…できてる。たぶんすごい", replyEmoji);
  return true;
}

export async function handlePacchiMessage(ctx: BotContext, message: Message): Promise<boolean> {
  if (isSelfAuthoredMessage(ctx, message)) return false;
  if (!message.guildId || message.guildId !== ctx.config.GUILD_ID) return false;

  const content = message.content.trim();
  if (!isExplicitPacchiTrigger(content)) {
    return false;
  }

  const repo = createPacchiRepositoryForContext(ctx);
  const settings = await repo.getSettings(message.guildId);
  const channel = await repo.getChannelSettings(message.guildId, message.channelId);
  const learnable = isLearnableMessage(content, message.attachments.size > 0);

  try {
    if (settings.enabled && channel.learnEnabled && !content.startsWith("!") && !content.startsWith("/")) {
      await repo.learnEmojis(message.guildId, extractGuildSafeEmojis(message));
    }

    if (settings.enabled && channel.learnEnabled && learnable) {
      if (
        ctx.config.JAPANESE_WORKER_ENABLED &&
        ctx.config.PACCHI_LEARNING_ANALYZER === "go-worker" &&
        !isUnsafeForPacchiLearning(content)
      ) {
        const morph = await analyzeMorph(content, {
          baseUrl: ctx.config.JAPANESE_WORKER_URL,
          timeoutMs: ctx.config.JAPANESE_WORKER_TIMEOUT_MS,
        });
        if (morph.ok) {
          const lexiconTokens = toLearnableLexiconTokens(morph.data);
          await repo.learnMorph(message.guildId, lexiconTokens);
          if (ctx.config.PACCHI_PATTERN_LEARNING_ENABLED) {
            const pattern = buildSentencePattern(content, morph.data);
            if (pattern) await repo.learnSentencePattern(message.guildId, pattern);
          }
        } else {
          ctx.log.warn({ reason: morph.reason, err: morph.error }, "pacchi morph learning skipped");
        }
      } else {
        const words = extractWords(content);
        const phrase = extractPhrase(content);
        if (words.length > 0 || phrase) await repo.learn(message.guildId, words, phrase);
      }
    }

    const cooldownSeconds = settings.cooldownSeconds || RATE_CONFIG[settings.speakRate].cooldownSeconds;
    const pickedEmoji = await repo.pickEmoji(message.guildId);
    const replyEmoji = isReplyEmojiAvailable(message, pickedEmoji) ? pickedEmoji : null;

    if (!settings.enabled || !channel.talkEnabled) return false;

    if (await tryHandlePacchiSenryuSubmission(ctx, message, repo, content, replyEmoji)) {
      markSpoke(message.channelId);
      await repo.touchSpoke(message.guildId);
      await repo.logReply(message.guildId, message.channelId, message.author.id, "senryu_submit", "575");
      return true;
    }

    const jankenHand = extractJanken(content);
    if (jankenHand && canSpeak(message.channelId, cooldownSeconds)) {
      const reply = janken(jankenHand);
      await sendPacchiReply(message, reply, replyEmoji);
      markSpoke(message.channelId);
      await repo.touchSpoke(message.guildId);
      await repo.logReply(message.guildId, message.channelId, message.author.id, "janken", reply);
      return true;
    }

    if (content.includes("おやすみ") && canSpeak(message.channelId, cooldownSeconds)) {
      await repo.startSleep(message.guildId, message.author.id);
      const reply = "おやすみ。ぱっちぃが覚えた";
      await sendPacchiReply(message, reply, replyEmoji);
      markSpoke(message.channelId);
      await repo.touchSpoke(message.guildId);
      await repo.logReply(message.guildId, message.channelId, message.author.id, "sleep_start", reply);
      return true;
    }

    if (content.includes("おはよう") && canSpeak(message.channelId, cooldownSeconds)) {
      const sleep = await repo.endSleep(message.guildId, message.author.id);
      let reply = "いつ寝たかわからん";
      if (sleep) {
        if (sleep.durationSeconds < 300) reply = `寝てないやん。${formatDuration(sleep.durationSeconds)}`;
        else if (sleep.durationSeconds > 86_400) reply = `寝すぎかもしれない。${formatDuration(sleep.durationSeconds)}`;
        else reply = `おはよう。${formatDuration(sleep.durationSeconds)} 寝てた`;
      }
      await sendPacchiReply(message, reply, replyEmoji);
      markSpoke(message.channelId);
      await repo.touchSpoke(message.guildId);
      await repo.logReply(message.guildId, message.channelId, message.author.id, "sleep_end", reply);
      return true;
    }

    const term = extractTermQuestion(content);
    if (term && canSpeak(message.channelId, cooldownSeconds)) {
      const reply = await explainTerm(ctx, term);
      await sendPacchiReply(message, reply.slice(0, 1200), replyEmoji);
      markSpoke(message.channelId);
      await repo.touchSpoke(message.guildId);
      await repo.logReply(message.guildId, message.channelId, message.author.id, "term", reply.slice(0, 1200));
      return true;
    }

    const poemPattern = extractNaturalPoem(content);
    if (poemPattern && canSpeak(message.channelId, cooldownSeconds)) {
      const result = ctx.config.JAPANESE_WORKER_ENABLED
        ? await buildVerifiedPacchiPoem(poemPattern, (await repo.randomWords(message.guildId, 40)).map((w) => w.word), {
          baseUrl: ctx.config.JAPANESE_WORKER_URL,
          timeoutMs: ctx.config.JAPANESE_WORKER_TIMEOUT_MS,
        })
        : { ok: false as const, reason: "worker_failed" as const, workerReason: undefined, error: undefined };
      if (!result.ok && result.reason === "worker_failed") {
        ctx.log.warn({ reason: result.workerReason, err: result.error }, "pacchi 575 generation worker failed");
      }
      const reply = result.ok ? result.poem : pacchiVerifiedPoemFailureMessage(result);
      await sendPacchiReply(message, reply, replyEmoji);
      markSpoke(message.channelId);
      await repo.touchSpoke(message.guildId);
      await repo.logReply(message.guildId, message.channelId, message.author.id, "poem", reply);
      return true;
    }

    if (isWorkStart(content)) {
      return await handleWorkStart(message, ctx, "");
    }
    if (isWorkEnd(content)) {
      return await handleWorkEnd(message, ctx, "");
    }

    const called = content.includes("ぱっちぃ");
    if (called && canSpeak(message.channelId, cooldownSeconds)) {
      const generated = await buildPacchiGeneratedReply(repo, message.guildId, ctx.config.PACCHI_GENERATION_MODE, true);
      const reply = await maybeAiCheckedPacchiReply(ctx, repo, message.guildId, generated);
      await sendPacchiReply(message, reply, replyEmoji);
      markSpoke(message.channelId);
      await repo.touchSpoke(message.guildId);
      await repo.logReply(message.guildId, message.channelId, message.author.id, "called", reply);
      return true;
    }

    if (
      !called &&
      learnable &&
      settings.speakRate !== "silent" &&
      canSpeak(message.channelId, cooldownSeconds) &&
      Math.random() < WIKIPEDIA_RANDOM_REPLY_CHANCE
    ) {
      const reply = await randomWikipediaReply(ctx);
      if (!reply) return false;
      await sendPacchiReply(message, reply.slice(0, 1200), replyEmoji);
      markSpoke(message.channelId);
      lastAutoReplyUserByChannel.set(message.channelId, message.author.id);
      await repo.touchSpoke(message.guildId);
      await repo.logReply(message.guildId, message.channelId, message.author.id, "wikipedia_random", reply.slice(0, 1200));
      return true;
    }

    if (!called && learnable && settings.speakRate !== "silent" && canSpeak(message.channelId, cooldownSeconds)) {
      const chance = RATE_CONFIG[settings.speakRate].chance;
      const sameUser = lastAutoReplyUserByChannel.get(message.channelId) === message.author.id;
      const lengthFactor = content.length < 6 ? 0.25 : 1;
      if (!sameUser && Math.random() < chance * lengthFactor) {
        const generated = await buildPacchiGeneratedReply(repo, message.guildId, ctx.config.PACCHI_GENERATION_MODE);
        const reply = await maybeAiCheckedPacchiReply(ctx, repo, message.guildId, generated);
        await sendPacchiReply(message, reply, replyEmoji);
        markSpoke(message.channelId);
        lastAutoReplyUserByChannel.set(message.channelId, message.author.id);
        await repo.touchSpoke(message.guildId);
        await repo.logReply(message.guildId, message.channelId, message.author.id, "backchannel", reply);
        return true;
      }
    }
  } catch (err) {
    ctx.log.error({ err }, "pacchi message handler failed");
  }

  return false;
}

function isExplicitPacchiTrigger(content: string): boolean {
  return Boolean(
    extractPacchiSenryuSubmission(content) ||
    extractJanken(content) ||
    content.includes("おやすみ") ||
    content.includes("おはよう") ||
    extractTermQuestion(content) ||
    extractNaturalPoem(content) ||
    isWorkStart(content) ||
    isWorkEnd(content) ||
    content.includes("ぱっちぃ"),
  );
}
