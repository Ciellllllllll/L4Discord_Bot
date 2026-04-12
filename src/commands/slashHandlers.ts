import {
  ChannelType,
  EmbedBuilder,
  type ChatInputCommandInteraction,
  type GuildMember,
  PermissionFlagsBits,
} from "discord.js";
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { BotContext } from "../bot/context.js";
import { sqliteTimestamp } from "../core/db/sqliteTimestamp.js";
import { getGuildSettingsData, upsertGuildSettingsData } from "../core/guildSettings.js";
import { isAdmin } from "../core/permission.js";
import { isVersionAllowed, versionBlockedMessage } from "../core/semverGate.js";
import { SLASH_META } from "./slashMeta.js";
import { deepseekChat } from "../features/ai/deepseek.js";
import { AiQueryService, readAiBasePromptFiles } from "../features/ai/aiQueryService.js";
import { canUseAi, markAiUse } from "../features/ai/userCooldown.js";
const Q_COOLDOWN_MS = 15_000;
const STUB = "この機能は準備中です。";

function metaFor(name: string) {
  return SLASH_META[name];
}

async function ensureVersion(interaction: ChatInputCommandInteraction, ctx: BotContext): Promise<boolean> {
  const m = metaFor(interaction.commandName);
  if (!m) return true;
  if (!isVersionAllowed(ctx.config.BOT_VERSION, m.introducedIn)) {
    await interaction.reply({ content: versionBlockedMessage(), ephemeral: true });
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
    await interaction.reply({ content: "このサーバーでは利用できません。", ephemeral: true });
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
    case "ping":
      return handlePing(interaction, ctx);
    case "member_count_setup":
      return handleMemberCountSetup(interaction, ctx, member);
    case "vc_rank":
      return handleVcRank(interaction, ctx);
    case "create_werewolfgame":
      return handleWerewolfCreate(interaction, ctx, member);
    case "end_werewolfgame":
      return handleWerewolfEnd(interaction, ctx, member);
    case "処刑":
    case "タイムアウト延長":
      return handlePollSlash(interaction, ctx, member);
    case "disable_emoji":
      return handleDisableEmoji(interaction, ctx, member);
    case "enable_emoji":
      return handleEnableEmoji(interaction, ctx, member);
    case "stamp_count":
      return handleStampCount(interaction, ctx);
    case "stamp_ranking":
      return handleStampRanking(interaction, ctx);
    default:
      ctx.log.warn({ command: interaction.commandName }, "slash command not implemented (stub reply)");
      await interaction.reply({ content: STUB, ephemeral: true });
  }
}

async function handleQ(interaction: ChatInputCommandInteraction, ctx: BotContext): Promise<void> {
  const raw = interaction.options.getString("text", true).trim();
  if (!raw) {
    await interaction.reply({ content: "質問内容が空です。", ephemeral: true });
    return;
  }
  if (!canUseAi(interaction.user.id, Q_COOLDOWN_MS)) {
    await interaction.reply({ content: "少し待ってから再度お試しください。", ephemeral: true });
    return;
  }
  await interaction.deferReply();
  try {
    const svc = new AiQueryService(ctx);
    await svc.routeSlashInteraction(interaction);
    markAiUse(interaction.user.id);
  } catch (e) {
    ctx.log.error({ err: e }, "deepseek q failed");
    await interaction.editReply({ content: `エラー: ${String(e)}`, embeds: [], components: [] });
  }
}

async function handlePing(interaction: ChatInputCommandInteraction, ctx: BotContext): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  try {
    const { resolved } = readAiBasePromptFiles(ctx.config);
    const { ms } = await deepseekChat(ctx.config, [
      { role: "system", content: resolved },
      { role: "user", content: "ping" },
    ]);
    await interaction.editReply(`DeepSeek 応答時間: **${ms}** ms`);
  } catch (e) {
    ctx.log.error({ err: e }, "deepseek ping failed");
    await interaction.editReply("計測に失敗しました。");
  }
}

async function handleMemberCountSetup(
  interaction: ChatInputCommandInteraction,
  ctx: BotContext,
  member: GuildMember | null,
): Promise<void> {
  if (!member || !isAdmin(member, ctx.config)) {
    await interaction.reply({ content: "権限がありません。", ephemeral: true });
    return;
  }
  const guild = interaction.guild;
  if (!guild?.members.me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
    await interaction.reply({ content: "BOTにチャンネル管理権限が必要です。", ephemeral: true });
    return;
  }
  await interaction.deferReply({ ephemeral: true });
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
async function handleWerewolfCreate(
  interaction: ChatInputCommandInteraction,
  ctx: BotContext,
  member: GuildMember | null,
): Promise<void> {
  if (!member || !isAdmin(member, ctx.config)) {
    await interaction.reply({ content: "権限がありません。", ephemeral: true });
    return;
  }
  const guildId = interaction.guildId!;
  const channelId = interaction.channelId;
  if (!channelId) {
    await interaction.reply({ content: "チャンネルが不明です。", ephemeral: true });
    return;
  }
  const id = randomUUID();
  await ctx.db
    .insertInto("werewolf_games")
    .values({
      id,
      guild_id: guildId,
      channel_id: channelId,
      host_id: interaction.user.id,
      phase: "lobby",
      state: JSON.stringify({ participants: [] }) as unknown as Record<string, unknown>,
      created_at: sqliteTimestamp() as unknown as Date,
      updated_at: sqliteTimestamp() as unknown as Date,
    })
    .execute();
  await interaction.reply({
    content: `人狼募集を開始しました（ロビー）。ゲームID: \`${id.slice(0, 8)}\` / <#${channelId}>`,
    ephemeral: false,
  });
}

async function handleWerewolfEnd(
  interaction: ChatInputCommandInteraction,
  ctx: BotContext,
  member: GuildMember | null,
): Promise<void> {
  if (!member || !isAdmin(member, ctx.config)) {
    await interaction.reply({ content: "権限がありません。", ephemeral: true });
    return;
  }
  const guildId = interaction.guildId!;
  const channelId = interaction.channelId;
  const r = await ctx.db
    .updateTable("werewolf_games")
    .set({ phase: "ended", updated_at: sqliteTimestamp() as unknown as Date })
    .where("guild_id", "=", guildId)
    .where("channel_id", "=", channelId ?? "")
    .where("phase", "!=", "ended")
    .executeTakeFirst();
  const n = Number(r.numUpdatedRows ?? 0);
  await interaction.reply({
    content: n > 0 ? "このチャンネルの人狼募集を終了しました。" : "終了対象のゲームがありません。",
    ephemeral: true,
  });
}

async function handlePollSlash(
  interaction: ChatInputCommandInteraction,
  ctx: BotContext,
  member: GuildMember | null,
): Promise<void> {
  if (!member || !isAdmin(member, ctx.config)) {
    await interaction.reply({ content: "権限がありません。", ephemeral: true });
    return;
  }
  const guildId = interaction.guildId!;
  const channelId = interaction.channelId!;
  const kind = interaction.commandName === "処刑" ? "execution" : "timeout_extend";
  let state: Record<string, unknown> = { created_by: interaction.user.id };
  if (kind === "execution") {
    const target = interaction.options.getUser("target", true);
    state = { ...state, target_id: target.id };
  }
  const id = randomUUID();
  await ctx.db
    .insertInto("polls")
    .values({
      id,
      guild_id: guildId,
      channel_id: channelId,
      message_id: null,
      kind,
      status: "open",
      state: JSON.stringify(state) as unknown as Record<string, unknown>,
      ends_at: null,
      created_at: sqliteTimestamp() as unknown as Date,
      updated_at: sqliteTimestamp() as unknown as Date,
    })
    .execute();
  await interaction.reply({
    content: `投票レコードを作成しました（\`${kind}\` / id: \`${id.slice(0, 8)}\`）。`,
    ephemeral: true,
  });
}

async function handleDisableEmoji(
  interaction: ChatInputCommandInteraction,
  ctx: BotContext,
  member: GuildMember | null,
): Promise<void> {
  if (!member || !isAdmin(member, ctx.config)) {
    await interaction.reply({ content: "権限がありません。", ephemeral: true });
    return;
  }
  const target = interaction.options.getUser("user", true);
  const guildId = interaction.guildId!;
  const cur = await getGuildSettingsData(ctx.db, guildId);
  const ids = new Set(cur.emoji_restricted_user_ids ?? []);
  ids.add(target.id);
  await upsertGuildSettingsData(ctx.db, guildId, { emoji_restricted_user_ids: [...ids] });
  await interaction.reply({ content: `絵文字制限を付与: ${target.tag}`, ephemeral: true });
}

async function handleEnableEmoji(
  interaction: ChatInputCommandInteraction,
  ctx: BotContext,
  member: GuildMember | null,
): Promise<void> {
  if (!member || !isAdmin(member, ctx.config)) {
    await interaction.reply({ content: "権限がありません。", ephemeral: true });
    return;
  }
  const target = interaction.options.getUser("user", true);
  const guildId = interaction.guildId!;
  const cur = await getGuildSettingsData(ctx.db, guildId);
  const ids = new Set(cur.emoji_restricted_user_ids ?? []);
  ids.delete(target.id);
  await upsertGuildSettingsData(ctx.db, guildId, { emoji_restricted_user_ids: [...ids] });
  await interaction.reply({ content: `絵文字制限を解除: ${target.tag}`, ephemeral: true });
}

async function handleStampCount(interaction: ChatInputCommandInteraction, ctx: BotContext): Promise<void> {
  const guildId = interaction.guildId!;
  const user = interaction.options.getUser("user") ?? interaction.user;
  const rows = await ctx.db
    .selectFrom("stamp_usage")
    .select("count")
    .where("guild_id", "=", guildId)
    .where("user_id", "=", user.id)
    .execute();
  const total = rows.reduce((acc, r) => acc + Number(r.count), 0);
  await interaction.reply({ content: `<@${user.id}> のスタンプ利用合計: **${total}**`, ephemeral: true });
}

async function handleStampRanking(interaction: ChatInputCommandInteraction, ctx: BotContext): Promise<void> {
  const guildId = interaction.guildId!;
  const rows = await ctx.db
    .selectFrom("stamp_usage")
    .select(["user_id", sql<string>`cast(sum(count) as text)`.as("total")])
    .where("guild_id", "=", guildId)
    .groupBy("user_id")
    .orderBy(sql`sum(count)`, "desc")
    .limit(15)
    .execute();
  if (rows.length === 0) {
    await interaction.reply({ content: "まだデータがありません。", ephemeral: true });
    return;
  }
  const lines = rows.map((r, i) => `${i + 1}. <@${r.user_id}> — ${r.total}`);
  await interaction.reply({ content: lines.join("\n").slice(0, 2000), ephemeral: true });
}
