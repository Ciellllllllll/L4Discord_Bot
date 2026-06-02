import { AttachmentBuilder, EmbedBuilder, type Message, type MessageMentionOptions } from "discord.js";
import { z } from "zod";
import type { BotContext } from "../../bot/context.js";
import { isAdmin } from "../../core/permission.js";
import { createPacchiRepository } from "./pacchi.repository.js";
import { buildPoem, formatDuration, RATE_CONFIG } from "./pacchi.reply.js";
import { parseLimit, sanitizeForReply } from "./pacchi.filters.js";
import type { PacchiExportData, PacchiRate } from "./pacchi.types.js";

const ADMIN_ONLY = "このコマンドは管理者のみ使用できます。";
const SAFE_REPLY: MessageMentionOptions = { parse: [] };

const importSchema = z.object({
  version: z.literal(1),
  exportedAt: z.string(),
  words: z.array(z.object({ word: z.string().min(1).max(40), count: z.number().int().min(1).max(1_000_000) })).max(1000),
  phrases: z.array(z.object({ phrase: z.string().min(1).max(80), count: z.number().int().min(1).max(1_000_000) })).max(1000),
  emojis: z.array(z.object({
    key: z.string().min(1).max(80),
    kind: z.enum(["unicode", "custom", "sticker"]),
    display: z.string().min(1).max(120),
    count: z.number().int().min(1).max(1_000_000),
  })).max(1000).default([]),
  settings: z.object({
    enabled: z.boolean(),
    defaultTalkEnabled: z.boolean(),
    defaultLearnEnabled: z.boolean(),
    speakRate: z.enum(["silent", "low", "normal", "high", "unlimited"]),
    cooldownSeconds: z.number().int().min(0).max(3600),
  }).nullable(),
  ngWords: z.array(z.string()).max(1000),
});

function isPacchiRate(input: string): input is PacchiRate {
  return input === "silent" || input === "low" || input === "normal" || input === "high" || input === "unlimited";
}

function requireAdmin(message: Message, ctx: BotContext): boolean {
  return Boolean(message.member && isAdmin(message.member, ctx.config));
}

async function replySafe(message: Message, content: string): Promise<void> {
  await message.reply({ content, allowedMentions: SAFE_REPLY });
}

export async function handlePacchiPrefixMessage(
  message: Message,
  ctx: BotContext,
  lower: string,
  args: string[],
): Promise<boolean> {
  const repo = createPacchiRepository(ctx.sqlite);
  const guildId = message.guildId;
  if (!guildId) return false;

  try {
    switch (lower) {
      case "pacchi_on":
        if (!requireAdmin(message, ctx)) return void await replySafe(message, ADMIN_ONLY), true;
        if (args[0] === "server") {
          repo.setEnabled(guildId, true);
          await replySafe(message, "ぱっちぃ機能をサーバー全体で有効にしました。");
          return true;
        }
        if (!args[0] || args[0] === "channel") {
          repo.setChannelSettings(guildId, message.channelId, true, true);
          await replySafe(message, "このチャンネルのぱっちぃ機能を有効にしました。");
          return true;
        }
        await replySafe(message, "使い方: `!pacchi_on` / `!pacchi_on server` / `!pacchi_on channel`");
        return true;

      case "pacchi_off":
        if (!requireAdmin(message, ctx)) return void await replySafe(message, ADMIN_ONLY), true;
        if (args[0] === "server") {
          repo.setEnabled(guildId, false);
          await replySafe(message, "ぱっちぃ機能をサーバー全体で無効にしました。");
          return true;
        }
        if (!args[0] || args[0] === "channel") {
          repo.setChannelSettings(guildId, message.channelId, false, false);
          await replySafe(message, "このチャンネルのぱっちぃ機能を無効にしました。");
          return true;
        }
        await replySafe(message, "使い方: `!pacchi_off` / `!pacchi_off server` / `!pacchi_off channel`");
        return true;

      case "pacchi_channel":
        return await handleChannel(message, ctx, args);
      case "pacchi_rate":
        return await handleRate(message, ctx, args);
      case "pacchi_status":
        return await handleStatus(message, ctx);
      case "pacchi_memory":
        return await handleMemory(message, ctx, args);
      case "pacchi_words":
        return await handleWords(message, ctx, args);
      case "pacchi_forget":
        return await handleForget(message, ctx, args);
      case "pacchi_poem":
        return await handlePoem(message, ctx, args);
      case "pacchi_work_start":
        return await handleWorkStart(message, ctx, args.join(" "));
      case "pacchi_work_end":
        return await handleWorkEnd(message, ctx, args.join(" "));
      case "pacchi_sleep":
        return await handleSleep(message, ctx);
      case "pacchi_export":
        return await handleExport(message, ctx);
      case "pacchi_import":
        return await handleImport(message, ctx);
      default:
        if (lower.startsWith("pacchi_")) {
          await replySafe(message, "`/pacchi_help` で使い方を確認できます。");
          return true;
        }
        return false;
    }
  } catch (err) {
    ctx.log.error({ err, command: lower }, "pacchi prefix command failed");
    await replySafe(message, "ぱっちぃは今ちょっと壊れた");
    return true;
  }
}

async function handleChannel(message: Message, ctx: BotContext, args: string[]): Promise<boolean> {
  if (!requireAdmin(message, ctx)) return void await replySafe(message, ADMIN_ONLY), true;
  const repo = createPacchiRepository(ctx.sqlite);
  const current = repo.getChannelSettings(message.guildId!, message.channelId);
  let learn = current.learnEnabled;
  let talk = current.talkEnabled;
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if ((key !== "learn" && key !== "talk") || (value !== "on" && value !== "off")) {
      await replySafe(message, "使い方: `!pacchi_channel learn on talk off`");
      return true;
    }
    if (key === "learn") learn = value === "on";
    if (key === "talk") talk = value === "on";
  }
  repo.setChannelSettings(message.guildId!, message.channelId, talk, learn);
  await replySafe(message, `このチャンネルの設定: 学習 ${learn ? "ON" : "OFF"} / 発話 ${talk ? "ON" : "OFF"}`);
  return true;
}

async function handleRate(message: Message, ctx: BotContext, args: string[]): Promise<boolean> {
  if (!requireAdmin(message, ctx)) return void await replySafe(message, ADMIN_ONLY), true;
  const rate = args[0];
  if (!rate || !isPacchiRate(rate)) {
    await replySafe(message, "使い方: `!pacchi_rate silent|low|normal|high|unlimited`");
    return true;
  }
  createPacchiRepository(ctx.sqlite).setRate(message.guildId!, rate);
  await replySafe(message, `自然発話頻度を ${rate} にしました。クールダウンは ${RATE_CONFIG[rate].cooldownSeconds} 秒です。`);
  return true;
}

async function handleStatus(message: Message, ctx: BotContext): Promise<boolean> {
  if (!requireAdmin(message, ctx)) return void await replySafe(message, ADMIN_ONLY), true;
  const repo = createPacchiRepository(ctx.sqlite);
  const settings = repo.getSettings(message.guildId!);
  const channel = repo.getChannelSettings(message.guildId!, message.channelId);
  const stats = repo.stats(message.guildId!);
  const embed = new EmbedBuilder()
    .setTitle("ぱっちぃ 状態")
    .setColor(0x5865f2)
    .addFields(
      { name: "機能全体", value: settings.enabled ? "ON" : "OFF", inline: true },
      { name: "学習", value: channel.learnEnabled ? "ON" : "OFF", inline: true },
      { name: "発話", value: channel.talkEnabled ? "ON" : "OFF", inline: true },
      { name: "頻度", value: settings.speakRate, inline: true },
      { name: "クールダウン", value: `${settings.cooldownSeconds}秒`, inline: true },
      { name: "単語", value: String(stats.wordCount), inline: true },
      { name: "短文", value: String(stats.phraseCount), inline: true },
      { name: "絵文字", value: String(stats.emojiCount), inline: true },
      { name: "睡眠記録", value: String(stats.sleepLogCount), inline: true },
      { name: "日報記録", value: String(stats.dailyReportCount), inline: true },
      { name: "最終発話", value: settings.lastSpokeAt ?? "-", inline: true },
      { name: "最終学習", value: settings.lastLearnedAt ?? "-", inline: true },
    );
  await message.reply({ embeds: [embed], allowedMentions: SAFE_REPLY });
  return true;
}

async function handleMemory(message: Message, ctx: BotContext, args: string[]): Promise<boolean> {
  if (!requireAdmin(message, ctx)) return void await replySafe(message, ADMIN_ONLY), true;
  const repo = createPacchiRepository(ctx.sqlite);
  const limit = parseLimit(args[0], 10, 50);
  const stats = repo.stats(message.guildId!);
  const words = repo.topWords(message.guildId!, limit);
  const embed = new EmbedBuilder()
    .setTitle("ぱっちぃ 記憶")
    .setColor(0x5865f2)
    .setDescription(`単語: ${stats.wordCount}\n短文: ${stats.phraseCount}\n絵文字: ${stats.emojiCount}`)
    .addFields({ name: "よく使われる単語", value: words.map((w, i) => `${i + 1}. ${w.word} (${w.count})`).join("\n") || "まだありません" });
  await message.reply({ embeds: [embed], allowedMentions: SAFE_REPLY });
  return true;
}

async function handleWords(message: Message, ctx: BotContext, args: string[]): Promise<boolean> {
  if (!requireAdmin(message, ctx)) return void await replySafe(message, ADMIN_ONLY), true;
  const words = createPacchiRepository(ctx.sqlite).topWords(message.guildId!, parseLimit(args[0], 10, 50));
  const embed = new EmbedBuilder()
    .setTitle("ぱっちぃ 単語ランキング")
    .setColor(0x5865f2)
    .setDescription(words.map((w, i) => `${i + 1}. ${w.word} (${w.count})`).join("\n") || "まだありません");
  await message.reply({ embeds: [embed], allowedMentions: SAFE_REPLY });
  return true;
}

async function handleForget(message: Message, ctx: BotContext, args: string[]): Promise<boolean> {
  if (!requireAdmin(message, ctx)) return void await replySafe(message, ADMIN_ONLY), true;
  const repo = createPacchiRepository(ctx.sqlite);
  const [kind, ...rest] = args;
  const target = rest.join(" ").trim();
  if (kind === "word" && target) {
    await replySafe(message, `削除件数: ${repo.forgetWord(message.guildId!, target)}`);
    return true;
  }
  if (kind === "phrase" && target) {
    await replySafe(message, `削除件数: ${repo.forgetPhrase(message.guildId!, target)}`);
    return true;
  }
  if (kind === "all" && rest[0] === "confirm") {
    await replySafe(message, `削除件数: ${repo.forgetAll(message.guildId!)}`);
    return true;
  }
  await replySafe(message, "使い方: `!pacchi_forget word 単語` / `!pacchi_forget phrase 短文` / `!pacchi_forget all confirm`");
  return true;
}

async function handlePoem(message: Message, ctx: BotContext, args: string[]): Promise<boolean> {
  const pattern = args[0] ?? "";
  const repo = createPacchiRepository(ctx.sqlite);
  const poem = buildPoem(pattern, repo.topWords(message.guildId!, 20).map((w) => w.word));
  await replySafe(message, poem ?? "使い方: `!pacchi_poem 575`");
  return true;
}

export async function handleWorkStart(message: Message, ctx: BotContext, goalText: string): Promise<boolean> {
  const safeGoal = sanitizeForReply(goalText) ?? "";
  const ok = createPacchiRepository(ctx.sqlite).startReport(message.guildId!, message.author.id, message.channelId, safeGoal);
  await replySafe(message, ok ? "日報を開始しました。" : "既に日報を開始中です。先に `!pacchi_work_end` してください。");
  return true;
}

export async function handleWorkEnd(message: Message, ctx: BotContext, progressText: string): Promise<boolean> {
  const safeProgress = sanitizeForReply(progressText) ?? "";
  const report = createPacchiRepository(ctx.sqlite).endReport(message.guildId!, message.author.id, safeProgress);
  await replySafe(message, report ? report.reportText : "開始中の日報がありません。");
  return true;
}

async function handleSleep(message: Message, ctx: BotContext): Promise<boolean> {
  const latest = createPacchiRepository(ctx.sqlite).latestSleep(message.guildId!, message.author.id);
  if (!latest) {
    await replySafe(message, "睡眠記録がありません。");
    return true;
  }
  await replySafe(message, `直近の睡眠: ${formatDuration(latest.duration_seconds)} (${latest.sleep_at} - ${latest.wake_at})`);
  return true;
}

async function handleExport(message: Message, ctx: BotContext): Promise<boolean> {
  if (!requireAdmin(message, ctx)) return void await replySafe(message, ADMIN_ONLY), true;
  const json = JSON.stringify(createPacchiRepository(ctx.sqlite).exportData(message.guildId!), null, 2);
  const file = new AttachmentBuilder(Buffer.from(json, "utf8"), { name: "pacchi-memory.json" });
  await message.reply({ content: "ぱっちぃの学習データです。", files: [file], allowedMentions: SAFE_REPLY });
  return true;
}

async function handleImport(message: Message, ctx: BotContext): Promise<boolean> {
  if (!requireAdmin(message, ctx)) return void await replySafe(message, ADMIN_ONLY), true;
  const attachment = message.attachments.first();
  if (!attachment) {
    await replySafe(message, "JSONファイルを添付してください。");
    return true;
  }
  const response = await fetch(attachment.url);
  const parsed = importSchema.safeParse(JSON.parse(await response.text()));
  if (!parsed.success) {
    await replySafe(message, "JSONの形式が不正です。");
    return true;
  }
  const data: PacchiExportData = parsed.data;
  const result = createPacchiRepository(ctx.sqlite).importData(message.guildId!, data);
  await replySafe(message, `インポートしました。単語 ${result.words} 件 / 短文 ${result.phrases} 件 / 絵文字 ${result.emojis} 件`);
  return true;
}
