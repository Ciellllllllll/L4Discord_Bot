import { ComponentCardBuilder, componentCardsPayload } from "../features/panels/componentCard.js";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  MessageFlags,
  type ChatInputCommandInteraction,
  type GuildMember,
  PermissionFlagsBits,
} from "discord.js";
import { sql } from "kysely";
import type { BotContext } from "../bot/context.js";
import { getGuildSettingsData, upsertGuildSettingsData } from "../core/guildSettings.js";
import { isAdmin } from "../core/permission.js";
import { isVersionAllowed, versionBlockedMessage } from "../core/semverGate.js";
import { SLASH_META } from "./slashMeta.js";
import { AiQueryService, SHOW_PROMPT_APPLY_BUTTON_ID, readAiBasePromptFiles } from "../features/ai/aiQueryService.js";
import { QAttachmentError } from "../features/ai/qAttachment.js";
import { buildChangePromptModal } from "../features/ai/changePromptModal.js";
import { showCreatePromptModal } from "../features/ai/createPrompt.js";
import { canUseAi, markAiUse } from "../features/ai/userCooldown.js";
import { getAiThinkingEnabled, setAiThinkingEnabled } from "../features/ai/thinkingSettings.js";
import { getAiR18Enabled, setAiR18Enabled } from "../features/ai/aiR18Settings.js";
import { sanitizeAiModelName } from "../features/ai/modelDisplay.js";
import { startExecutionFlow } from "../features/execution/executionFlow.js";
import { startTimeoutExtendFlow } from "../features/execution/timeoutExtendFlow.js";
import { muteChannelForSenryuPersisted } from "../features/senryu/senryu.filters.js";
import { listTicketUsageSummaries } from "../features/tickets/ticketUsageStats.js";
import { startAfkDisconnectCommand } from "../features/vc/afkDisconnect.js";
import { handlePacchiHelp } from "../features/pacchi/pacchi.slash.js";
import { handleBoketeSlash } from "../features/bokete/bokete.slash.js";
import { handleBokeruSlash } from "../features/bokeru/bokeru.js";
import { checkJapaneseWorkerHealth } from "../features/japaneseAnalysis/japaneseAnalysisClient.js";
import {
  handleGameNow,
  handleGameOff,
  handleGameOn,
  handleGameSub,
  handleGameSubList,
} from "../features/gameDeals/gameDealCommands.js";
import {
  handleLolAdminAddCommand,
  handleLolAdminRemoveCommand,
  handleLolWatchCommand,
} from "../features/lolWatcher/lolWatcher.commands.js";
import { handleAdhdCommand } from "../features/youtubeWatcher/youtubeWatcher.commands.js";
import { handleWerewolfCreate, handleWerewolfEnd } from "../features/werewolf/werewolfGame.js";
import { maybePromptAnonymousSurvey, promptAnonymousSurvey } from "../features/anonymousSurvey/surveyGate.js";
import { handleAnonymousSurveyViewCommand } from "../features/anonymousSurvey/surveyView.js";
import {
  GIF_AUTO_REPLY_URL_MAX_LENGTH,
  parseGifAutoReplySetting,
  parseGifAutoReplyUrl,
} from "../features/utilities/gifAutoReply.js";
const Q_COOLDOWN_MS = 15_000;
const Q_FAILED_MESSAGE = "AI への問い合わせに失敗しました。しばらくしてから再度お試しください。";
const STUB = "この機能は準備中です。";

function metaFor(name: string) {
  return SLASH_META[name];
}

async function ensureVersion(interaction: ChatInputCommandInteraction, ctx: BotContext): Promise<boolean> {
  if (ctx.config.BOT_PROFILE === "debug") return true;
  const m = metaFor(interaction.commandName);
  if (!m) return true;
  if (!isVersionAllowed(ctx.config.BOT_VERSION, m.introducedIn)) {
    await interaction.reply({ content: versionBlockedMessage(), flags: MessageFlags.Ephemeral });
    return false;
  }
  return true;
}

export async function handleSlashCommand(
  interaction: ChatInputCommandInteraction,
  ctx: BotContext,
  options: { skipSurvey?: boolean } = {},
): Promise<void> {
  if (!interaction.inGuild() || interaction.guildId !== ctx.config.GUILD_ID) {
    ctx.log.warn(
      { command: interaction.commandName, guildId: interaction.guildId, expectedGuildId: ctx.config.GUILD_ID },
      "slash command rejected (wrong guild)",
    );
    await interaction.reply({ content: "このサーバーでは利用できません。", flags: MessageFlags.Ephemeral });
    return;
  }

  if (!(await ensureVersion(interaction, ctx))) {
    ctx.log.info({ command: interaction.commandName, userId: interaction.user.id }, "slash command blocked by version gate");
    return;
  }

  const member: GuildMember | null =
    interaction.member && "roles" in interaction.member ? (interaction.member as GuildMember) : null;

  if (interaction.commandName === "survey") {
    return handleDebugSurvey(interaction, ctx, member);
  }

  if (!options.skipSurvey && await maybePromptAnonymousSurvey(interaction, ctx, member)) {
    return;
  }

  switch (interaction.commandName) {
    case "q":
      return handleQ(interaction, ctx);
    case "change_prompt":
      return handleChangePrompt(interaction, ctx);
    case "create_prompt":
      return handleCreatePrompt(interaction);
    case "show_prompt":
      return handleShowPrompt(interaction, ctx);
    case "thinking":
      return handleThinking(interaction, ctx, member);
    case "r18":
      return handleR18(interaction, ctx);
    case "ping":
      return handlePing(interaction, ctx);
    case "view":
      return handleAnonymousSurveyViewCommand(interaction, ctx, member);
    case "switch":
      return handleSwitch(interaction, ctx, member);
    case "pacchi_help":
      return handlePacchiHelp(interaction, ctx);
    case "bokete":
      return handleBoketeSlash(interaction, ctx);
    case "bokeru":
      return handleBokeruSlash(interaction, ctx);
    case "gif":
      return handleGif(interaction, ctx, member);
    case "member_count_setup":
      return handleMemberCountSetup(interaction, ctx, member);
    case "vc_rank":
      return handleVcRank(interaction, ctx);
    case "afk":
      return startAfkDisconnectCommand(interaction, ctx);
    case "create_werewolf":
      return handleWerewolfCreate(interaction, ctx, member);
    case "end_werewolf":
      return handleWerewolfEnd(interaction, ctx, member);
    case "処刑":
      return handleExecutionSlash(interaction, ctx, member);
    case "タイムアウト延長":
      return handlePollSlash(interaction, ctx, member);
    case "disable_emoji":
      return handleDisableEmoji(interaction, ctx, member);
    case "enable_emoji":
      return handleEnableEmoji(interaction, ctx, member);
    case "stamp_rank":
      return handleStampRanking(interaction, ctx);
    case "ticket_users":
      return handleTicketUsers(interaction, ctx, member);
    case "mute":
      return handleSenryuMute(interaction, ctx, member);
    case "game_on":
      return handleGameOn(interaction, ctx, member);
    case "game_now":
      return handleGameNow(interaction, ctx, member);
    case "game_off":
      return handleGameOff(interaction, ctx, member);
    case "sub":
      return handleGameSub(interaction, ctx);
    case "sub_list":
      return handleGameSubList(interaction, ctx);
    case "lol_watch":
      return handleLolWatchCommand(interaction, ctx, member);
    case "lol_add":
      return handleLolAdminAddCommand(interaction, ctx, member);
    case "lol_remove":
      return handleLolAdminRemoveCommand(interaction, ctx, member);
    case "adhd":
      return handleAdhdCommand(interaction, ctx, member);
    default:
      ctx.log.warn({ command: interaction.commandName }, "slash command not implemented (stub reply)");
      await interaction.reply({ content: STUB, flags: MessageFlags.Ephemeral });
  }
}

async function handleGif(
  interaction: ChatInputCommandInteraction,
  ctx: BotContext,
  member: GuildMember | null,
): Promise<void> {
  if (!member || !isAdmin(member, ctx.config)) {
    await interaction.reply({ content: "権限がありません。", flags: MessageFlags.Ephemeral });
    return;
  }

  const subcommand = interaction.options.getSubcommand();
  const guildId = interaction.guildId!;
  if (subcommand === "set") {
    const triggerUrl = parseGifAutoReplyUrl(interaction.options.getString("trigger_url", true));
    const responseUrl = parseGifAutoReplyUrl(interaction.options.getString("response_url", true));
    if (!triggerUrl || !responseUrl) {
      await interaction.reply({
        content: `検知URLと返信URLはHTTP(S) URLを${GIF_AUTO_REPLY_URL_MAX_LENGTH}文字以内で指定してください。`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await upsertGuildSettingsData(ctx.db, guildId, {
      gif_auto_reply: { trigger_url: triggerUrl, response_url: responseUrl },
    });
    await interaction.reply({
      content: ["GIF自動返信を設定しました。", `検知: <${triggerUrl}>`, `返信: <${responseUrl}>`].join("\n"),
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
    return;
  }

  if (subcommand === "clear") {
    await upsertGuildSettingsData(ctx.db, guildId, { gif_auto_reply: undefined });
    await interaction.reply({ content: "GIF自動返信設定を解除しました。", flags: MessageFlags.Ephemeral });
    return;
  }

  const setting = parseGifAutoReplySetting((await getGuildSettingsData(ctx.db, guildId)).gif_auto_reply);
  await interaction.reply(setting ? {
    content: ["現在のGIF自動返信設定", `検知: <${setting.trigger_url}>`, `返信: <${setting.response_url}>`].join("\n"),
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  } : {
    content: "GIF自動返信は設定されていません。`/gif set` で設定できます。",
    flags: MessageFlags.Ephemeral,
  });
}

async function handleDebugSurvey(
  interaction: ChatInputCommandInteraction,
  ctx: BotContext,
  member: GuildMember | null,
): Promise<void> {
  if (ctx.config.BOT_PROFILE !== "debug") {
    await interaction.reply({ content: "このコマンドはdebug profileでのみ利用できます。", flags: MessageFlags.Ephemeral });
    return;
  }
  if (await promptAnonymousSurvey(interaction, ctx, member, { ignoreAdmin: true, ignoreCooldown: true })) {
    return;
  }
  await interaction.reply({ content: "Anonymous Surveyを表示できませんでした。", flags: MessageFlags.Ephemeral });
}

async function handleCreatePrompt(interaction: ChatInputCommandInteraction): Promise<void> {
  try {
    await showCreatePromptModal(interaction);
  } catch {
    if (!interaction.replied && !interaction.deferred) {
      await interaction
        .reply({
          content: "モーダルを表示できませんでした。しばらくしてから再度お試しください。",
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => undefined);
    }
  }
}

async function handleThinking(
  interaction: ChatInputCommandInteraction,
  ctx: BotContext,
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

async function handleR18(interaction: ChatInputCommandInteraction, ctx: BotContext): Promise<void> {
  const enabled = interaction.options.getBoolean("enabled", true);
  await setAiR18Enabled(ctx, interaction.guildId!, interaction.user.id, enabled);

  await interaction.reply({
    content: `R18モードを ${enabled ? "ON" : "OFF"} にしました。`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleChangePrompt(interaction: ChatInputCommandInteraction, _ctx: BotContext): Promise<void> {
  try {
    await interaction.showModal(buildChangePromptModal());
  } catch {
    if (!interaction.replied && !interaction.deferred) {
      await interaction
        .reply({
          content: "モーダルを表示できませんでした。しばらくしてから再度お試しください。",
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => undefined);
    }
  }
}

async function handleShowPrompt(interaction: ChatInputCommandInteraction, ctx: BotContext): Promise<void> {
  const svc = new AiQueryService(ctx);
  const prompt = svc.loadUserPrompt(interaction.user.id, interaction.user.username);
  const embed = new ComponentCardBuilder()
    .setTitle("現在の /q プロンプト")
    .setDescription(prompt.slice(0, 4000) || "プロンプトが空です。")
  if (prompt.length > 4000) {
    embed.setFooter({ text: "プロンプトが長いため一部のみ表示しています。" });
  }
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(SHOW_PROMPT_APPLY_BUTTON_ID)
      .setLabel("このプロンプトをAIに適用する")
      .setStyle(ButtonStyle.Primary),
  );
  await interaction.reply({
    ...componentCardsPayload([embed], [row]),
    allowedMentions: { parse: [] },
  });
}

async function handleQ(interaction: ChatInputCommandInteraction, ctx: BotContext): Promise<void> {
  const raw = interaction.options.getString("text")?.trim() ?? "";
  if (!raw && !interaction.options.getAttachment("attachment")) {
    await interaction.reply({ content: "質問の本文か添付ファイルを指定してください。", flags: MessageFlags.Ephemeral });
    return;
  }
  if (!canUseAi(interaction.user.id, Q_COOLDOWN_MS)) {
    await interaction.reply({ content: "少し待ってから再度お試しください。", flags: MessageFlags.Ephemeral });
    return;
  }
  const r18 = await getAiR18Enabled(ctx, interaction.guildId!, interaction.user.id);
  await interaction.deferReply(r18 ? { flags: MessageFlags.Ephemeral } : undefined);
  try {
    const svc = new AiQueryService(ctx);
    await svc.routeSlashInteraction(interaction, { r18 });
    markAiUse(interaction.user.id);
  } catch (e) {
    if (!(e instanceof QAttachmentError)) ctx.log.error({ err: e }, "AI question failed");
    await interaction.editReply({
      content: e instanceof QAttachmentError ? e.message : Q_FAILED_MESSAGE,
      embeds: [],
      components: [],
      allowedMentions: { parse: [] },
    });
  }
}

export function buildAiPingReply(
  result: { ms: number; provider: "openai" | "deepseek"; model: string },
  thinking: boolean,
  workerLine: string,
): { content: string; allowedMentions: { parse: [] } } {
  return {
    content: [
      `AI応答時間: **${result.ms}** ms / Provider: **${result.provider === "openai" ? "OpenAI" : "DeepSeek"}** / Model: **${sanitizeAiModelName(result.model)}** / Thinking: **${thinking ? "ON" : "OFF"}**`,
      workerLine,
    ].join("\n").slice(0, 2000),
    allowedMentions: { parse: [] },
  };
}

async function handlePing(interaction: ChatInputCommandInteraction, ctx: BotContext): Promise<void> {
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
    default: return reason ? "OpenAI障害による一時退避" : "なし";
  }
}

function openAiPreferenceLabel(preference: "gpt56" | "gpt54_mini"): string {
  return preference === "gpt56" ? "GPT-5.6 Terra" : "GPT-5.4 mini";
}

function effectiveRouteLabel(status: Awaited<ReturnType<BotContext["aiRouter"]["getStatus"]>>): string {
  if (status.effectiveProvider === "deepseek") return "DeepSeek";
  if (status.effectiveModel === "gpt-5.6-terra") return "GPT-5.6 Terra";
  if (status.effectiveModel === "gpt-5.4-mini-2026-03-17") return "GPT-5.4 mini";
  return status.effectiveModel ? `OpenAI (${status.effectiveModel})` : "OpenAI";
}

export async function handleSwitch(
  interaction: ChatInputCommandInteraction,
  ctx: BotContext,
  member: GuildMember | null,
): Promise<void> {
  if (!member || !isAdmin(member, ctx.config)) {
    await interaction.reply({ content: "権限がありません。", flags: MessageFlags.Ephemeral });
    return;
  }
  const selection = interaction.options.getString("provider", true);
  if (selection !== "openai_gpt56" && selection !== "openai_gpt54_mini" && selection !== "deepseek") {
    await interaction.reply({ content: "プロバイダー指定が不正です。", flags: MessageFlags.Ephemeral });
    return;
  }
  const current = await ctx.aiRouter.getPreference(interaction.guildId!);
  const preference = selection === "openai_gpt56"
    ? { provider: "openai" as const, openAiModel: "gpt56" as const }
    : selection === "openai_gpt54_mini"
      ? { provider: "openai" as const, openAiModel: "gpt54_mini" as const }
      : { provider: "deepseek" as const, openAiModel: current.openAiModel };
  await ctx.aiRouter.setPreference(interaction.guildId!, preference);
  const status = await ctx.aiRouter.getStatus(interaction.guildId!);
  const preferred = status.preferredProvider === "openai"
    ? openAiPreferenceLabel(status.preferredOpenAiModel)
    : "DeepSeek";
  const fallbackNote = status.preferredProvider === "openai" && status.preferredOpenAiModel === "gpt56"
    ? "Terra利用不能時: GPT-5.4 miniへ自動退避"
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

async function handleMemberCountSetup(
  interaction: ChatInputCommandInteraction,
  ctx: BotContext,
  member: GuildMember | null,
): Promise<void> {
  if (!member || !isAdmin(member, ctx.config)) {
    await interaction.reply({ content: "権限がありません。", flags: MessageFlags.Ephemeral });
    return;
  }
  const guild = interaction.guild;
  if (!guild?.members.me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
    await interaction.reply({ content: "BOTにチャンネル管理権限が必要です。", flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const name = "Member Count";
  const cat = await guild.channels.create({
    name,
    type: ChannelType.GuildCategory,
    reason: "member_count_setup",
  });
  await guild.channels.create({
    name: "総メンバー数",
    type: ChannelType.GuildVoice,
    parent: cat.id,
    reason: "member_count_setup",
  });
  await interaction.editReply(`カテゴリとボイスチャンネルを作成しました: ${cat.name}`);
}

async function handleVcRank(interaction: ChatInputCommandInteraction, ctx: BotContext): Promise<void> {
  await interaction.deferReply();
  const period = interaction.options.getString("period", true) as "day" | "week" | "month" | "all";
  const rows = await ctx.vcRanking.getRanking(interaction.guildId!, period);
  if (rows.length === 0) {
    const empty =
      period === "all"
        ? "VCランキングデータがありません。"
        : "この期間に該当するデータがありません。累計は「全期間」を選ぶか、記録開始後の期間で試してください。";
    await interaction.editReply({ content: empty });
    return;
  }

  const lines = rows.slice(0, 10).map((r, i) => {
    const totalSec = Math.max(0, Math.floor(Number(r.seconds)));
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const sec = totalSec % 60;
    return `${i + 1}. <@${r.userId}> - ${h}\u6642\u9593${m}\u5206${sec}\u79d2`;
  });

  const embed = new ComponentCardBuilder()
    .setTitle("\u0056\u0043\u6ede\u5728\u30e9\u30f3\u30ad\u30f3\u30b0\u0020\u0054\u004f\u0050\u0031\u0030")
    .setDescription(lines.join("\n"));
  await interaction.editReply({
    ...componentCardsPayload([embed]),
    allowedMentions: { parse: ["users"] },
  });
}
async function handleExecutionSlash(
  interaction: ChatInputCommandInteraction,
  ctx: BotContext,
  _member: GuildMember | null,
): Promise<void> {
  await startExecutionFlow(interaction, ctx);
}

async function handlePollSlash(
  interaction: ChatInputCommandInteraction,
  ctx: BotContext,
  _member: GuildMember | null,
): Promise<void> {
  await startTimeoutExtendFlow(interaction, ctx);
}

async function handleDisableEmoji(
  interaction: ChatInputCommandInteraction,
  ctx: BotContext,
  member: GuildMember | null,
): Promise<void> {
  if (!member || !isAdmin(member, ctx.config)) {
    await interaction.reply({ content: "権限がありません。", flags: MessageFlags.Ephemeral });
    return;
  }
  const target = interaction.options.getUser("user", true);
  const guildId = interaction.guildId!;
  const cur = await getGuildSettingsData(ctx.db, guildId);
  const ids = new Set(cur.emoji_restricted_user_ids ?? []);
  ids.add(target.id);
  await upsertGuildSettingsData(ctx.db, guildId, { emoji_restricted_user_ids: [...ids] });
  await interaction.reply({ content: `絵文字制限を付与: ${target.tag}`, flags: MessageFlags.Ephemeral });
}

async function handleEnableEmoji(
  interaction: ChatInputCommandInteraction,
  ctx: BotContext,
  member: GuildMember | null,
): Promise<void> {
  if (!member || !isAdmin(member, ctx.config)) {
    await interaction.reply({ content: "権限がありません。", flags: MessageFlags.Ephemeral });
    return;
  }
  const target = interaction.options.getUser("user", true);
  const guildId = interaction.guildId!;
  const cur = await getGuildSettingsData(ctx.db, guildId);
  const ids = new Set(cur.emoji_restricted_user_ids ?? []);
  ids.delete(target.id);
  await upsertGuildSettingsData(ctx.db, guildId, { emoji_restricted_user_ids: [...ids] });
  await interaction.reply({ content: `絵文字制限を解除: ${target.tag}`, flags: MessageFlags.Ephemeral });
}

async function handleStampRanking(interaction: ChatInputCommandInteraction, ctx: BotContext): Promise<void> {
  await interaction.deferReply();
  const guildId = interaction.guildId!;
  const rows = await ctx.db
    .selectFrom("stamp_usage")
    .select(["user_id", sql<string>`cast(sum(count) as text)`.as("total")])
    .where("guild_id", "=", guildId)
    .groupBy("user_id")
    .orderBy(sql`sum(count)`, "desc")
    .limit(10)
    .execute();
  if (rows.length === 0) {
    await interaction.editReply({ content: "スタンプランキングデータがありません。" });
    return;
  }
  const lines = rows.map((r, i) => `${i + 1}. <@${r.user_id}> - ${Number(r.total).toLocaleString("ja-JP")}回`);
  const embed = new ComponentCardBuilder()
    .setTitle("スタンプ利用ランキング TOP10")
    .setDescription(lines.join("\n"));
  await interaction.editReply({
    ...componentCardsPayload([embed]),
    allowedMentions: { parse: ["users"] },
  });
}

async function handleTicketUsers(
  interaction: ChatInputCommandInteraction,
  ctx: BotContext,
  member: GuildMember | null,
): Promise<void> {
  if (!member || !isAdmin(member, ctx.config)) {
    await interaction.reply({ content: "権限がありません。", flags: MessageFlags.Ephemeral });
    return;
  }

  const limit = interaction.options.getInteger("limit") ?? 15;
  const rows = await listTicketUsageSummaries(ctx, interaction.guildId!, limit);
  if (rows.length === 0) {
    await interaction.reply({
      content: "Ticket 利用データがありません。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const lines = rows.map((row, i) => {
    const lastUsedAt = row.lastUsedAt ? `<t:${Math.floor(new Date(row.lastUsedAt).getTime() / 1000)}:R>` : "-";
    return [
      `${i + 1}. <@${row.userId}>`,
      `total=${row.totalCount}`,
      `modmail=${row.modmailCount}`,
      `appeal=${row.appealCount}`,
      `last=${lastUsedAt}`,
    ].join(" / ");
  });

  await interaction.reply({
    content: lines.join("\n").slice(0, 2000),
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

async function handleSenryuMute(
  interaction: ChatInputCommandInteraction,
  ctx: BotContext,
  member: GuildMember | null,
): Promise<void> {
  if (!member || !isAdmin(member, ctx.config)) {
    await interaction.reply({ content: "権限がありません。", flags: MessageFlags.Ephemeral });
    return;
  }
  const channelId = interaction.channelId;
  const mutedChannelIds = await muteChannelForSenryuPersisted(ctx.db, interaction.guildId!, channelId);
  ctx.log.info(
    { channelId, userId: interaction.user.id, command: "mute", mutedChannelCount: mutedChannelIds.length },
    "senryu: channel muted via slash command",
  );
  await interaction.reply({
    content:
      "このチャンネルでの川柳検出をオフにしました。メッセージの川柳は検出・返信されません。（親フォーラム／テキストチャンネルをミュートした場合は、その下のスレッドでも検出がスキップされます）",
    flags: MessageFlags.Ephemeral,
  });
}
