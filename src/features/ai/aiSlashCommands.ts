import { ComponentCardBuilder, componentCardsPayload } from "../../core/componentCard.js";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  type ChatInputCommandInteraction,
  type GuildMember,
} from "discord.js";
import type { AiProviderRouter } from "./aiProviderRouter.js";
import type { CoreDeps } from "../../core/deps.js";
import { isAdmin } from "../../core/permission.js";
import { checkJapaneseWorkerHealth } from "../japaneseAnalysis/japaneseAnalysisClient.js";
import { AiQueryService, SHOW_PROMPT_APPLY_BUTTON_ID, readAiBasePromptFiles, type AiQueryServiceDeps } from "./aiQueryService.js";
import { AiRequestError } from "./aiRequestError.js";
import { getAiR18Enabled, setAiR18Enabled } from "./aiR18Settings.js";
import { sanitizeAiModelName } from "./modelDisplay.js";
import { QAttachmentError } from "./qAttachment.js";
import { getAiThinkingEnabled, setAiThinkingEnabled } from "./thinkingSettings.js";
import { canUseAi, markAiUse } from "./userCooldown.js";

const Q_COOLDOWN_MS = 15_000;
const Q_FAILED_MESSAGE = "AI への問い合わせに失敗しました。しばらくしてから再度お試しください。";
const inFlightQUsers = new Set<string>();

export async function handleThinkingCommand(
  interaction: ChatInputCommandInteraction,
  ctx: Pick<CoreDeps, "config" | "db">,
  member: GuildMember | null,
): Promise<void> {
  const target = interaction.options.getUser("user") ?? interaction.user;
  if (target.id !== interaction.user.id && (!member || !isAdmin(member, ctx.config))) {
    await interaction.reply({ content: "権限がありません。", flags: MessageFlags.Ephemeral });
    return;
  }
  const enabled = interaction.options.getBoolean("enabled", true);
  await setAiThinkingEnabled(ctx, interaction.guildId!, target.id, enabled);
  const targetLabel = target.id === interaction.user.id ? "あなた" : `<@${target.id}>`;
  await interaction.reply({
    content: `${targetLabel} のAI Thinkingを ${enabled ? "ON" : "OFF"} にしました。`,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

export async function handleR18Command(interaction: ChatInputCommandInteraction, ctx: Pick<CoreDeps, "db">): Promise<void> {
  const enabled = interaction.options.getBoolean("enabled", true);
  await setAiR18Enabled(ctx, interaction.guildId!, interaction.user.id, enabled);
  await interaction.reply({
    content: `R18モードを ${enabled ? "ON" : "OFF"} にしました。`,
    flags: MessageFlags.Ephemeral,
  });
}

export async function handleShowPromptCommand(interaction: ChatInputCommandInteraction, ctx: AiQueryServiceDeps): Promise<void> {
  const svc = new AiQueryService(ctx);
  const prompt = svc.loadUserPrompt(interaction.user.id, interaction.user.username);
  const card = new ComponentCardBuilder()
    .setTitle("現在の /q プロンプト")
    .setDescription(prompt.slice(0, 4000) || "プロンプトが空です。");
  if (prompt.length > 4000) {
    card.setFooter({ text: "プロンプトが長いため一部のみ表示しています。" });
  }
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(SHOW_PROMPT_APPLY_BUTTON_ID)
      .setLabel("このプロンプトをAIに適用する")
      .setStyle(ButtonStyle.Primary),
  );
  await interaction.reply({
    ...componentCardsPayload([card], [row]),
    allowedMentions: { parse: [] },
  });
}

export type HandleQCommandDeps = {
  getAiR18Enabled?: typeof getAiR18Enabled;
  createQueryService?: (ctx: AiQueryServiceDeps) => Pick<AiQueryService, "routeSlashInteraction">;
};

async function sendQFailureReply(
  interaction: ChatInputCommandInteraction,
  ctx: Pick<CoreDeps, "log">,
  content: string,
  options: { answerSent?: boolean } = {},
): Promise<void> {
  try {
    if (options.answerSent) {
      await interaction.followUp({
        content,
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
    } else if (interaction.deferred) {
      await interaction.editReply({
        content,
        embeds: [],
        components: [],
        allowedMentions: { parse: [] },
      });
    } else if (interaction.replied) {
      await interaction.followUp({
        content,
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
    } else {
      await interaction.reply({
        content,
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
    }
  } catch (replyErr) {
    ctx.log.warn({ err: replyErr }, "AI question failure reply failed");
  }
}

export async function handleQCommand(
  interaction: ChatInputCommandInteraction,
  ctx: AiQueryServiceDeps,
  deps: HandleQCommandDeps = {},
): Promise<void> {
  const raw = interaction.options.getString("text")?.trim() ?? "";
  if (!raw && !interaction.options.getAttachment("attachment")) {
    await interaction.reply({ content: "質問の本文か添付ファイルを指定してください。", flags: MessageFlags.Ephemeral });
    return;
  }
  const userId = interaction.user.id;
  if (inFlightQUsers.has(userId) || !canUseAi(userId, Q_COOLDOWN_MS)) {
    await interaction.reply({ content: "少し待ってから再度お試しください。", flags: MessageFlags.Ephemeral });
    return;
  }
  const resolveR18 = deps.getAiR18Enabled ?? getAiR18Enabled;
  const createQueryService = deps.createQueryService ?? ((c: AiQueryServiceDeps) => new AiQueryService(c));
  inFlightQUsers.add(userId);
  try {
    let r18: boolean;
    try {
      r18 = await resolveR18(ctx, interaction.guildId!, userId);
      await interaction.deferReply(r18 ? { flags: MessageFlags.Ephemeral } : undefined);
    } catch (e) {
      ctx.log.error({ err: e }, "AI question setup failed");
      await sendQFailureReply(interaction, ctx, Q_FAILED_MESSAGE);
      return;
    }
    let answerSent = false;
    const trackedInteraction = new Proxy(interaction, {
      get(target, prop, receiver) {
        if (prop === "editReply") {
          return async (...args: Parameters<ChatInputCommandInteraction["editReply"]>) => {
            const result = await target.editReply(...args);
            answerSent = true;
            return result;
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    try {
      const svc = createQueryService(ctx);
      await svc.routeSlashInteraction(trackedInteraction, {
        r18,
        editProgressReply: (opts) => interaction.editReply(opts),
      });
      markAiUse(userId);
    } catch (e) {
      const isConfigurationError = e instanceof AiRequestError && e.kind === "configuration";
      if (!(e instanceof QAttachmentError)) ctx.log.error({ err: e }, "AI question failed");
      if (!(e instanceof QAttachmentError) && !isConfigurationError) {
        markAiUse(userId);
      }
      const content = e instanceof QAttachmentError
        ? e.message
        : isConfigurationError
          ? "AIプロバイダーの設定が未完了です。管理者に .env のAPIキー設定を確認してください。"
          : Q_FAILED_MESSAGE;
      await sendQFailureReply(interaction, ctx, content, { answerSent });
    }
  } finally {
    inFlightQUsers.delete(userId);
  }
}

export function buildAiPingReply(
  result: { ms: number; provider: "openai" | "deepseek" | "openrouter"; model: string },
  thinking: boolean,
  workerLine: string,
): { content: string; allowedMentions: { parse: [] } } {
  const providerLabel = result.provider === "openai"
    ? "OpenAI"
    : result.provider === "openrouter"
      ? "OpenRouter"
      : "DeepSeek";
  return {
    content: [
      `AI応答時間: **${result.ms}** ms / Provider: **${providerLabel}** / Model: **${sanitizeAiModelName(result.model)}** / Thinking: **${thinking ? "ON" : "OFF"}**`,
      workerLine,
    ].join("\n").slice(0, 2000),
    allowedMentions: { parse: [] },
  };
}

export async function handlePingCommand(interaction: ChatInputCommandInteraction, ctx: Pick<CoreDeps, "config" | "db" | "log"> & { aiRouter: AiProviderRouter }): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const worker = ctx.config.JAPANESE_WORKER_ENABLED
    ? await checkJapaneseWorkerHealth({
      baseUrl: ctx.config.JAPANESE_WORKER_URL,
      timeoutMs: ctx.config.JAPANESE_WORKER_TIMEOUT_MS,
    })
    : null;
  const workerLine = worker === null
    ? "Go worker: **DISABLED**"
    : worker.ok
      ? `Go worker: **OK** (${worker.data.ms} ms / ${ctx.config.JAPANESE_WORKER_URL})`
      : `Go worker: **NG** (${worker.reason} / ${ctx.config.JAPANESE_WORKER_URL})`;

  try {
    const { resolved } = readAiBasePromptFiles(ctx.config);
    const thinking = await getAiThinkingEnabled(ctx, interaction.guildId!, interaction.user.id);
    const result = await ctx.aiRouter.chat(
      interaction.guildId!,
      "ping",
      [
        { role: "system", content: resolved },
        { role: "user", content: "ping" },
      ],
      { thinking },
    );
    await interaction.editReply(buildAiPingReply(result, thinking, workerLine));
  } catch (e) {
    ctx.log.error({ err: e }, "AI ping failed");
    await interaction.editReply({
      content: ["AI応答時間: **計測失敗**", workerLine].join("\n"),
      allowedMentions: { parse: [] },
    });
  }
}

function fallbackReasonLabel(reason: string | undefined): string {
  switch (reason) {
    case "manual_deepseek": return "手動でDeepSeekを選択中";
    case "budget_threshold": return "本日の安全しきい値に到達";
    case "usage_unavailable": return "OpenAI Usage APIを確認できないため安全退避";
    case "openai_unconfigured": return "OpenAI設定が未完了";
    case "openrouter_unconfigured": return "OpenRouter設定が未完了";
    case "openrouter_failed": return "OpenRouter障害による一時退避";
    case "openrouter_budget_threshold": return "OpenRouterの本日分トークン上限に到達";
    default: return reason ? "OpenAI障害による一時退避" : "なし";
  }
}

function openAiPreferenceLabel(preference: "gpt56" | "gpt54_mini"): string {
  return preference === "gpt56" ? "GPT-5.6 Terra" : "GPT-5.4 mini";
}

function effectiveRouteLabel(status: Awaited<ReturnType<AiProviderRouter["getStatus"]>>): string {
  if (status.effectiveProvider === "deepseek") return "DeepSeek";
  if (status.effectiveProvider === "openrouter") {
    return status.effectiveModel ? `OpenRouter (${status.effectiveModel})` : "OpenRouter";
  }
  if (status.effectiveModel === "gpt-5.6-terra") return "GPT-5.6 Terra";
  if (status.effectiveModel === "gpt-5.4-mini-2026-03-17") return "GPT-5.4 mini";
  return status.effectiveModel ? `OpenAI (${status.effectiveModel})` : "OpenAI";
}

export async function handleSwitch(
  interaction: ChatInputCommandInteraction,
  ctx: Pick<CoreDeps, "config"> & { aiRouter: AiProviderRouter },
  member: GuildMember | null,
): Promise<void> {
  if (!member || !isAdmin(member, ctx.config)) {
    await interaction.reply({ content: "権限がありません。", flags: MessageFlags.Ephemeral });
    return;
  }
  const selection = interaction.options.getString("provider", true);
  if (
    selection !== "openai_gpt56"
    && selection !== "openai_gpt54_mini"
    && selection !== "deepseek"
    && selection !== "openrouter"
  ) {
    await interaction.reply({ content: "プロバイダー指定が不正です。", flags: MessageFlags.Ephemeral });
    return;
  }
  // 未設定のまま保存すると /q が設定エラーになるため、切り替え自体を拒否する。
  if (selection === "openrouter" && !ctx.config.OPENROUTER_API_KEY.trim()) {
    await interaction.reply({
      content: "OPENROUTER_API_KEY が未設定です。.env に設定してから切り替えてください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const current = await ctx.aiRouter.getPreference(interaction.guildId!);
  const preference = selection === "openai_gpt56"
    ? { provider: "openai" as const, openAiModel: "gpt56" as const }
    : selection === "openai_gpt54_mini"
      ? { provider: "openai" as const, openAiModel: "gpt54_mini" as const }
      : selection === "openrouter"
        ? { provider: "openrouter" as const, openAiModel: current.openAiModel }
        : { provider: "deepseek" as const, openAiModel: current.openAiModel };
  await ctx.aiRouter.setPreference(interaction.guildId!, preference);
  const status = await ctx.aiRouter.getStatus(interaction.guildId!);
  const preferred = status.preferredProvider === "openai"
    ? openAiPreferenceLabel(status.preferredOpenAiModel)
    : status.preferredProvider === "openrouter"
      ? "OpenRouter"
      : "DeepSeek";
  const fallbackNote = status.preferredProvider === "openai" && status.preferredOpenAiModel === "gpt56"
    ? "Terra利用不能時: GPT-5.4 miniへ自動退避"
    : status.preferredProvider === "openrouter"
      ? "OpenRouterは /q のみに使用し、その他のAI機能はDeepSeekを使用"
      : null;
  await interaction.reply({
    content: [
      `希望: **${preferred}** / 次回実効: **${effectiveRouteLabel(status)}**`,
      fallbackNote,
      `退避理由: ${fallbackReasonLabel(status.fallbackReason)}`,
      `予算退避のUTC復帰時刻: ${status.resetAtUtc}`,
    ].filter(Boolean).join("\n"),
    flags: MessageFlags.Ephemeral,
  });
}
