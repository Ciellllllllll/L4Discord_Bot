import {
  ChannelType,
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
    await interaction.reply({ content: "このサーバーでは利用できません。", ephemeral: true });
    return;
  }

  if (!(await ensureVersion(interaction, ctx))) return;

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
    case "end_werewolfgame":
      return handleStubMod(interaction, ctx, member);
    case "処刑":
    case "タイムアウト延長":
      return handleStubMod(interaction, ctx, member);
    case "disable_emoji":
      return handleDisableEmoji(interaction, ctx, member);
    case "enable_emoji":
      return handleEnableEmoji(interaction, ctx, member);
    case "stamp_count":
      return handleStampCount(interaction, ctx);
    case "stamp_ranking":
      return handleStampRanking(interaction, ctx);
    default:
      await interaction.reply({ content: STUB, ephemeral: true });
  }
}

async function handleQ(interaction: ChatInputCommandInteraction, ctx: BotContext): Promise<void> {
  const text = interaction.options.getString("text", true);
  if (!canUseAi(interaction.user.id, Q_COOLDOWN_MS)) {
    await interaction.reply({ content: "少し待ってから再度お試しください。", ephemeral: true });
    return;
  }
  await interaction.deferReply();
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 45_000);
  try {
    const { content } = await deepseekChat(
      ctx.config,
      [
        { role: "system", content: "簡潔に日本語で答えてください。" },
        { role: "user", content: text },
      ],
      controller.signal,
    );
    markAiUse(interaction.user.id);
    await interaction.editReply(content.slice(0, 2000) || "(空の応答)");
  } catch (e) {
    ctx.log.error({ err: e }, "deepseek q failed");
    await interaction.editReply("応答に失敗しました。");
  } finally {
    clearTimeout(t);
  }
}

async function handlePing(interaction: ChatInputCommandInteraction, ctx: BotContext): Promise<void> {
  await interaction.deferReply();
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 45_000);
  try {
    const { ms } = await deepseekChat(
      ctx.config,
      [{ role: "user", content: 'Reply with exactly the word "pong".' }],
      controller.signal,
    );
    await interaction.editReply(`DeepSeek往復: **${ms}** ms`);
  } catch (e) {
    ctx.log.error({ err: e }, "deepseek ping failed");
    await interaction.editReply("計測に失敗しました。");
  } finally {
    clearTimeout(t);
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
  const period = interaction.options.getString("period", true) as "day" | "week" | "month" | "all";
  const rows = await ctx.vcRanking.getRanking(interaction.guildId!, period);
  if (rows.length === 0) {
    await interaction.reply({
      content: "準備中: VCランキングデータに接続していません。",
      ephemeral: true,
    });
    return;
  }
  const lines = rows.slice(0, 20).map((r, i) => `${i + 1}. <@${r.userId}> — ${r.seconds}s`);
  await interaction.reply({ content: lines.join("\n").slice(0, 2000), ephemeral: true });
}

async function handleStubMod(
  interaction: ChatInputCommandInteraction,
  ctx: BotContext,
  member: GuildMember | null,
): Promise<void> {
  if (!member || !isAdmin(member, ctx.config)) {
    await interaction.reply({ content: "権限がありません。", ephemeral: true });
    return;
  }
  await interaction.reply({ content: STUB, ephemeral: true });
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
