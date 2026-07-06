import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
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
import { deepseekChat } from "../features/ai/deepseek.js";
import { AiQueryService, SHOW_PROMPT_APPLY_BUTTON_ID, readAiBasePromptFiles } from "../features/ai/aiQueryService.js";
import { buildChangePromptModal } from "../features/ai/changePromptModal.js";
import { showCreatePromptModal } from "../features/ai/createPrompt.js";
import { canUseAi, markAiUse } from "../features/ai/userCooldown.js";
import { getAiThinkingEnabled, setAiThinkingEnabled } from "../features/ai/thinkingSettings.js";
import { getAiR18Enabled, setAiR18Enabled } from "../features/ai/aiR18Settings.js";
import { startExecutionFlow } from "../features/execution/executionFlow.js";
import { startTimeoutExtendFlow } from "../features/execution/timeoutExtendFlow.js";
import { muteChannelForSenryuPersisted } from "../features/senryu/senryu.filters.js";
import { listTicketUsageSummaries } from "../features/tickets/ticketUsageStats.js";
import { startAfkDisconnectCommand } from "../features/vc/afkDisconnect.js";
import { handlePacchiHelp } from "../features/pacchi/pacchi.slash.js";
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
import { handleWerewolfCreate, handleWerewolfEnd } from "../features/werewolf/werewolfGame.js";
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
    case "pacchi_help":
      return handlePacchiHelp(interaction, ctx);
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
    default:
      ctx.log.warn({ command: interaction.commandName }, "slash command not implemented (stub reply)");
      await interaction.reply({ content: STUB, flags: MessageFlags.Ephemeral });
  }
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
    content: `${targetLabel} の DeepSeek V4 Flash Thinking を ${enabled ? "ON" : "OFF"} にしました。`,
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
  const embed = new EmbedBuilder()
    .setTitle("現在の /q プロンプト")
    .setDescription(prompt.slice(0, 4000) || "プロンプトが空です。")
    .setColor(0x5865f2);
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
    embeds: [embed],
    components: [row],
    allowedMentions: { parse: [] },
  });
}

async function handleQ(interaction: ChatInputCommandInteraction, ctx: BotContext): Promise<void> {
  const raw = interaction.options.getString("text", true).trim();
  if (!raw) {
    await interaction.reply({ content: "質問内容が空です。", flags: MessageFlags.Ephemeral });
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
    ctx.log.error({ err: e }, "deepseek q failed");
    await interaction.editReply({
      content: Q_FAILED_MESSAGE,
      embeds: [],
      components: [],
      allowedMentions: { parse: [] },
    });
  }
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
    const { ms } = await deepseekChat(
      ctx.config,
      [
        { role: "system", content: resolved },
        { role: "user", content: "ping" },
      ],
      { thinking },
    );
    await interaction.editReply([
      `DeepSeek 応答時間: **${ms}** ms / Thinking: **${thinking ? "ON" : "OFF"}**`,
      workerLine,
    ].join("\n"));
  } catch (e) {
    ctx.log.error({ err: e }, "deepseek ping failed");
    await interaction.editReply([
      "DeepSeek 応答時間: **計測失敗**",
      workerLine,
    ].join("\n"));
  }
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

  const embed = new EmbedBuilder()
    .setTitle("\u0056\u0043\u6ede\u5728\u30e9\u30f3\u30ad\u30f3\u30b0\u0020\u0054\u004f\u0050\u0031\u0030")
    .setColor(0x3498db)
    .setDescription(lines.join("\n"));
  await interaction.editReply({
    embeds: [embed],
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
  const embed = new EmbedBuilder()
    .setTitle("スタンプ利用ランキング TOP10")
    .setColor(0x3498db)
    .setDescription(lines.join("\n"));
  await interaction.editReply({
    embeds: [embed],
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
