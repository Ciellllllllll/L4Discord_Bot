import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type GuildMember,
  type Message,
  type TextBasedChannel,
} from "discord.js";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AppConfig } from "../../core/config.js";
import type { BotContext } from "../../bot/context.js";
import { sqliteTimestamp } from "../../core/db/sqliteTimestamp.js";
import { deepseekChat, type ChatMessage } from "./deepseek.js";
import { classifyUserIntent } from "./queryJudge.js";
import { runAiSlashCommand } from "./aiCommandExecution.js";
import { sendOrReconnectAiHistoryAdminPanel } from "./aiHistoryAdminPanel.js";

// DiscordBOTv2 AI_Query.js と同じ customId 接頭辞

export const HISTORY_CLEAR_Q_PREFIX = "chatgpt_history_clear_q:";
export const SHOW_PROMPT_APPLY_BUTTON_ID = "ai_show_prompt:apply";

function safeStrip(text: string): string {
  return String(text || "").trim();
}

// prompt.txt 等。ユーザー用ファイルの初期コピー元と /ping の system に使う

export function readAiBasePromptFiles(config: AppConfig): { template: string; resolved: string } {
  const file = path.resolve(config.PROMPT_FILE_PATH);
  let template = "You are a helpful assistant. 簡潔に日本語で答えてください。";
  try {
    if (fs.existsSync(file)) {
      const r = fs.readFileSync(file, "utf8");
      if (safeStrip(r)) template = r;
    }
  } catch {}
  const resolved = safeStrip(template) || "You are a helpful assistant.";
  return { template, resolved };
}

function sanitizePromptFileUserName(userName: string): string {
  const base = safeStrip(userName)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ");
  const cleaned = base.replace(/[. ]+$/g, "");
  if (!cleaned) return "user";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(cleaned)) {
    return `${cleaned}_user`;
  }
  return cleaned;
}

function sanitizePromptFileUserId(userId: string): string {
  const trimmed = safeStrip(userId);
  if (/^\d+$/.test(trimmed)) return trimmed;
  return sanitizePromptFileUserName(trimmed || "user");
}

function asChatMessage(role: "system" | "user" | "assistant", content: string): ChatMessage {
  return { role, content };
}

export class AiQueryService {
  private readonly userPromptPaths = new Map<string, string>();
  private basePromptTemplate: string;
  private basePromptResolved: string;
  private readonly optimizingUsers = new Set<string>();

  constructor(private readonly ctx: BotContext) {
    const dir = path.resolve(this.ctx.config.USER_PROMPT_DIR);
    fs.mkdirSync(dir, { recursive: true });
    const { template, resolved } = this.refreshBasePromptFromFile();
    this.basePromptTemplate = template;
    this.basePromptResolved = resolved;
  }

  private refreshBasePromptFromFile(): { template: string; resolved: string } {
    const latest = readAiBasePromptFiles(this.ctx.config);
    this.basePromptTemplate = latest.template;
    this.basePromptResolved = latest.resolved;
    return latest;
  }

  resolveUserName(userId: string, userName: string): string {
    const fromArg = safeStrip(userName);
    if (fromArg) return fromArg;
    const fromCache = safeStrip(this.ctx.client.users.cache.get(userId)?.username ?? "");
    if (fromCache) return fromCache;
    return `user_${userId}`;
  }

  private userPromptPath(userId: string): string {
    const fileName = `${sanitizePromptFileUserId(userId)}_prompt.txt`;
    return path.join(path.resolve(this.ctx.config.USER_PROMPT_DIR), fileName);
  }

  private legacyUserPromptPath(userName: string): string {
    const fileName = `${sanitizePromptFileUserName(userName)}_prompt.txt`;
    return path.join(path.resolve(this.ctx.config.USER_PROMPT_DIR), fileName);
  }

  private ensureUserPromptFile(userId: string, userName: string): string {
    this.refreshBasePromptFromFile();
    const uid = String(userId);
    const resolvedUserName = this.resolveUserName(uid, userName);
    const nextPath = this.userPromptPath(uid);
    const prevPath = this.userPromptPaths.get(uid);
    const legacyPath = this.legacyUserPromptPath(resolvedUserName);

    if (prevPath && prevPath !== nextPath && fs.existsSync(prevPath) && !fs.existsSync(nextPath)) {
      try {
        fs.copyFileSync(prevPath, nextPath);
      } catch {}
    } else if (legacyPath !== nextPath && fs.existsSync(legacyPath) && !fs.existsSync(nextPath)) {
      try {
        fs.copyFileSync(legacyPath, nextPath);
      } catch {}
    }

    if (!fs.existsSync(nextPath)) {
      try {
        fs.writeFileSync(nextPath, this.basePromptTemplate, "utf8");
      } catch {}
    }

    this.userPromptPaths.set(uid, nextPath);
    return nextPath;
  }

  loadUserPrompt(userId: string, userName: string): string {
    const p = this.ensureUserPromptFile(userId, userName);
    try {
      const text = fs.readFileSync(p, "utf8");
      return safeStrip(text) || this.basePromptResolved;
    } catch {
      return this.basePromptResolved;
    }
  }

  saveUserPrompt(userId: string, userName: string, promptText: string): void {
    const p = this.ensureUserPromptFile(userId, userName);
    const text = safeStrip(promptText) || this.basePromptResolved;
    try {
      fs.writeFileSync(p, text, "utf8");
    } catch {}
  }

  // `/change_prompt` のモーダル送信からのみ呼ぶ。
  // ベース prompt のコピーや `ensureUserPromptFile` は使わず、本文をそのまま UTF-8 で書き換える。

  replaceUserPromptFromChangePromptCommand(userId: string, _userName: string, fullPromptText: string): void {
    const uid = String(userId);
    const dir = path.resolve(this.ctx.config.USER_PROMPT_DIR);
    fs.mkdirSync(dir, { recursive: true });
    const p = this.userPromptPath(uid);
    const text = safeStrip(fullPromptText);
    if (!text) {
      return;
    }
    try {
      fs.writeFileSync(p, text, "utf8");
    } catch {}
    this.userPromptPaths.set(uid, p);
  }

  private async countHistoryRows(guildId: string, userId: string): Promise<number> {
    const r = await this.ctx.aiHistoryDb
      .selectFrom("ai_history")
      .select((eb) => eb.fn.count<number>("id").as("c"))
      .where("guild_id", "=", guildId)
      .where("user_id", "=", userId)
      .executeTakeFirst();
    return Number(r?.c ?? 0);
  }

  private shouldOptimizePrompt(historyRowCount: number): boolean {
    const cfg = this.ctx.config;
    if (!cfg.PROMPT_OPTIMIZER_ENABLED) {
      return false;
    }
    if (!Number.isFinite(historyRowCount) || historyRowCount < cfg.PROMPT_OPTIMIZER_MIN_MESSAGES) {
      return false;
    }
    return historyRowCount % cfg.PROMPT_OPTIMIZER_INTERVAL_MESSAGES === 0;
  }

  private async loadHistoryWindowForOptimizer(
    guildId: string,
    userId: string,
  ): Promise<{ role: string; content: string }[]> {
    const maxRows = this.ctx.config.PROMPT_OPTIMIZER_MAX_HISTORY;
    const rows = await this.ctx.aiHistoryDb
      .selectFrom("ai_history")
      .select(["role", "content"])
      .where("guild_id", "=", guildId)
      .where("user_id", "=", userId)
      .orderBy("created_at", "desc")
      .limit(maxRows)
      .execute();
    return [...rows].reverse();
  }

  private async optimizeUserPromptFromHistory(
    guildId: string,
    userId: string,
    userName: string,
  ): Promise<void> {
    const uid = String(userId);
    if (this.optimizingUsers.has(uid)) {
      return;
    }

    const historyCount = await this.countHistoryRows(guildId, uid);
    if (!this.shouldOptimizePrompt(historyCount)) {
      return;
    }

    this.optimizingUsers.add(uid);
    try {
      const resolvedUserName = this.resolveUserName(uid, userName);
      const { resolved: basePrompt } = this.refreshBasePromptFromFile();
      const currentPrompt = this.loadUserPrompt(uid, resolvedUserName);
      const historyWindow = await this.loadHistoryWindowForOptimizer(guildId, uid);
      const valid = historyWindow.filter(
        (x) => x && (x.role === "user" || x.role === "assistant") && typeof x.content === "string",
      );

      const optimizerMessages: ChatMessage[] = [
        asChatMessage(
          "system",
          "You are Chat Monitor AI. Rewrite a user-specific system prompt for another assistant. Keep the base prompt intent and safety constraints, personalize tone and phrasing from dialogue history, and return plain prompt text only.",
        ),
        asChatMessage(
          "user",
          [
            "Update the prompt using the history JSON below.",
            "Output only the full rewritten prompt text. No markdown, no code fences.",
            "",
            "[BasePrompt]",
            basePrompt,
            "",
            "[CurrentUserPrompt]",
            currentPrompt,
            "",
            "[ConversationHistoryJSON]",
            JSON.stringify(valid, null, 2),
          ].join("\n"),
        ),
      ];

      const { content: optimized } = await deepseekChat(this.ctx.config, optimizerMessages, {
        temperature: this.ctx.config.PROMPT_OPTIMIZER_TEMPERATURE,
        sanitizeOutput: false,
      });

      if (!safeStrip(optimized)) {
        return;
      }

      this.saveUserPrompt(uid, resolvedUserName, optimized);
    } catch (err) {
      this.ctx.log.warn({ err: String(err) }, "prompt optimizer failed");
    } finally {
      this.optimizingUsers.delete(uid);
    }
  }

  private touchHistoryAdminPanel(): void {
    void sendOrReconnectAiHistoryAdminPanel(this.ctx);
  }

  private async loadHistoryMessages(guildId: string, userId: string): Promise<ChatMessage[]> {
    const max = this.ctx.config.AI_HISTORY_MAX_MESSAGES;
    const rows = await this.ctx.aiHistoryDb
      .selectFrom("ai_history")
      .select(["role", "content"])
      .where("guild_id", "=", guildId)
      .where("user_id", "=", userId)
      .orderBy("created_at", "asc")
      .execute();

    const out: ChatMessage[] = [];
    for (const r of rows) {
      if (r.role === "user" || r.role === "assistant") {
        out.push({ role: r.role, content: r.content });
      }
    }
    return out.slice(-max);
  }

  private async appendHistoryPair(guildId: string, userId: string, userContent: string, assistantContent: string): Promise<void> {
    const now = sqliteTimestamp() as unknown as Date;
    const meta = JSON.stringify({}) as unknown as Record<string, unknown>;
    await this.ctx.aiHistoryDb
      .insertInto("ai_history")
      .values({
        id: randomUUID(),
        guild_id: guildId,
        user_id: userId,
        role: "user",
        content: userContent.slice(0, 4000),
        meta,
        created_at: now,
      })
      .execute();
    await this.ctx.aiHistoryDb
      .insertInto("ai_history")
      .values({
        id: randomUUID(),
        guild_id: guildId,
        user_id: userId,
        role: "assistant",
        content: assistantContent.slice(0, 4000),
        meta,
        created_at: now,
      })
      .execute();
  }

  async clearHistory(guildId: string, userId: string): Promise<void> {
    await this.ctx.aiHistoryDb
      .deleteFrom("ai_history")
      .where("guild_id", "=", guildId)
      .where("user_id", "=", userId)
      .execute();
  }

  private async askQuestion(
    guildId: string,
    userId: string,
    userName: string,
    question: string,
  ): Promise<string> {
    const history = await this.loadHistoryMessages(guildId, userId);
    const { resolved: basePrompt } = this.refreshBasePromptFromFile();
    const userPrompt = this.loadUserPrompt(userId, userName);
    const messages: ChatMessage[] = [
      { role: "system", content: basePrompt },
      { role: "system", content: userPrompt },
      ...history,
      { role: "user", content: question },
    ];
    const { content: answer } = await deepseekChat(this.ctx.config, messages);
    await this.appendHistoryPair(guildId, userId, question, answer);
    void this.optimizeUserPromptFromHistory(guildId, userId, userName).catch(() => undefined);
    this.touchHistoryAdminPanel();
    return answer;
  }

  async routeSlashInteraction(interaction: ChatInputCommandInteraction): Promise<void> {
    const guildId = interaction.guildId!;
    const text = safeStrip(interaction.options.getString("text", true));
    const userId = interaction.user.id;
    const userName = interaction.user.username;
    const noMentions = { parse: [] as const };

    const replyQuestion = async (answer: string) => {
      const embed = new EmbedBuilder()
        .setTitle("回答")
        .setDescription(answer.slice(0, 4000))
        .setColor(0x2ecc71);
      if (answer.length > 4000) {
        embed.setFooter({ text: "回答が長いため一部のみ表示しています。" });
      }
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`${HISTORY_CLEAR_Q_PREFIX}${guildId}:${userId}`)
          .setLabel("この会話履歴を削除")
          .setStyle(ButtonStyle.Secondary),
      );
      await interaction.editReply({ embeds: [embed], components: [row], allowedMentions: noMentions });
    };

    const replyCommand = async (userMessage: string, embeds?: EmbedBuilder[]) => {
      const safe = userMessage.slice(0, 4000);
      if (embeds && embeds.length > 0) {
        await interaction.editReply({ embeds: embeds.slice(0, 10), components: [], allowedMentions: noMentions });
      } else {
        await interaction.editReply({ content: safe.slice(0, 2000), components: [], allowedMentions: noMentions });
      }
    };

    const runQuestionFlow = async () => {
      const answer = await this.askQuestion(guildId, userId, userName, text);
      await replyQuestion(answer);
    };

    if (!this.ctx.config.AI_JUDGE_ENABLED) {
      await runQuestionFlow();
      return;
    }

    const classification = await classifyUserIntent(this.ctx.config, text, this.ctx.log);

    if (classification.kind === "question") {
      await runQuestionFlow();
      return;
    }

    const member: GuildMember | null =
      interaction.member && "roles" in interaction.member
        ? (interaction.member as GuildMember)
        : null;

    const execResult = await runAiSlashCommand(this.ctx, {
      guild: interaction.guild,
      channel: interaction.channel as TextBasedChannel,
      member,
      userId,
      action: classification.action,
      args: classification.args,
    });

    if (this.ctx.config.AI_LOG_COMMANDS_TO_HISTORY) {
      await this.appendHistoryPair(guildId, userId, text, execResult.userMessage);
      void this.optimizeUserPromptFromHistory(guildId, userId, userName).catch(() => undefined);
      this.touchHistoryAdminPanel();
    }

    await replyCommand(execResult.userMessage, execResult.embeds);
  }

  // メンション／Bot 返信時（CHAT_MONITOR_ENABLED）

  async routeMonitorMessage(message: Message, text: string): Promise<void> {
    const guild = message.guild;
    if (!guild) return;
    const guildId = guild.id;
    const userId = message.author.id;
    const userName = message.author.username;
    const member = message.member;

    const replyQuestion = async (answer: string) => {
      await message.reply({
        content: answer.slice(0, 2000),
        allowedMentions: { parse: [], repliedUser: false },
      });
    };

    const replyCommand = async (userMessage: string, embeds?: EmbedBuilder[]) => {
      if (embeds && embeds.length > 0) {
        await message.reply({
          embeds: embeds.slice(0, 10),
          allowedMentions: { parse: [], repliedUser: false },
        });
      } else {
        await message.reply({
          content: userMessage.slice(0, 2000),
          allowedMentions: { parse: [], repliedUser: false },
        });
      }
    };

    const runQuestionFlow = async () => {
      const answer = await this.askQuestion(guildId, userId, userName, text);
      await replyQuestion(answer);
    };

    if (!this.ctx.config.AI_JUDGE_ENABLED) {
      await runQuestionFlow();
      return;
    }

    const classification = await classifyUserIntent(this.ctx.config, text, this.ctx.log);
    if (classification.kind === "question") {
      await runQuestionFlow();
      return;
    }

    const execResult = await runAiSlashCommand(this.ctx, {
      guild,
      channel: message.channel as TextBasedChannel,
      member,
      userId,
      action: classification.action,
      args: classification.args,
    });

    if (this.ctx.config.AI_LOG_COMMANDS_TO_HISTORY) {
      await this.appendHistoryPair(guildId, userId, text, execResult.userMessage);
      void this.optimizeUserPromptFromHistory(guildId, userId, userName).catch(() => undefined);
      this.touchHistoryAdminPanel();
    }

    await replyCommand(execResult.userMessage, execResult.embeds);
  }
}

// メンションまたは Bot への返信で /q と同じルートへ（CHAT_MONITOR_ENABLED 時）

export async function handleAiChatMonitorMessage(message: Message, ctx: BotContext): Promise<boolean> {
  if (!ctx.config.CHAT_MONITOR_ENABLED) {
    return false;
  }
  if (message.author.bot || !message.guild || message.guildId !== ctx.config.GUILD_ID) {
    return false;
  }
  const botId = ctx.client.user?.id;
  if (!botId) {
    return false;
  }

  const mentioned = message.mentions.users.has(botId);
  let repliedToBot = false;
  if (message.reference?.messageId) {
    repliedToBot = await message.channel.messages
      .fetch(message.reference.messageId)
      .then((m) => m.author?.id === botId)
      .catch(() => false);
  }

  if (!mentioned && !repliedToBot) {
    return false;
  }

  const content = safeStrip(message.content.replace(new RegExp(`<@!?${botId}>`, "g"), "").trim());
  if (!content) {
    return false;
  }

  try {
    const svc = new AiQueryService(ctx);
    await svc.routeMonitorMessage(message, content);
  } catch (e) {
    ctx.log.warn({ err: e }, "chat monitor reply failed");
  }
  return true;
}

export async function handleAiHistoryClearButton(interaction: ButtonInteraction, ctx: BotContext): Promise<boolean> {
  if (!interaction.customId.startsWith(HISTORY_CLEAR_Q_PREFIX)) {
    return false;
  }

  const rest = interaction.customId.slice(HISTORY_CLEAR_Q_PREFIX.length);
  const parts = rest.split(":");
  if (parts.length !== 2) {
    return false;
  }
  const [guildId, ownerId] = parts;
  if (!/^\d+$/.test(guildId) || !/^\d+$/.test(ownerId)) {
    return false;
  }

  if (interaction.user.id !== ownerId) {
    await interaction.reply({ content: "この履歴は /q 実行ユーザーのみ削除できます。", flags: MessageFlags.Ephemeral });
    return true;
  }

  if (interaction.guildId !== guildId) {
    await interaction.reply({ content: "このボタンは別サーバー用です。", flags: MessageFlags.Ephemeral });
    return true;
  }

  const svc = new AiQueryService(ctx);
  await svc.clearHistory(guildId, ownerId);
  void sendOrReconnectAiHistoryAdminPanel(ctx).catch(() => undefined);
  await interaction.reply({ content: "あなたの会話履歴を削除しました。", flags: MessageFlags.Ephemeral });
  return true;
}

export async function handleShowPromptApplyButton(interaction: ButtonInteraction, ctx: BotContext): Promise<boolean> {
  if (interaction.customId !== SHOW_PROMPT_APPLY_BUTTON_ID) {
    return false;
  }

  const embed = interaction.message.embeds[0];
  const prompt = safeStrip(embed?.description ?? "");
  if (!prompt || prompt === "プロンプトが空です。") {
    await interaction.reply({ content: "適用できるプロンプトが見つかりません。", flags: MessageFlags.Ephemeral });
    return true;
  }
  if (embed?.footer?.text?.includes("一部のみ表示")) {
    await interaction.reply({
      content: "このプロンプトは表示上限で省略されているため適用できません。",
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  const svc = new AiQueryService(ctx);
  svc.replaceUserPromptFromChangePromptCommand(interaction.user.id, interaction.user.username, prompt);
  await interaction.reply({ content: "このプロンプトをあなたの /q に適用しました。", flags: MessageFlags.Ephemeral });
  return true;
}
