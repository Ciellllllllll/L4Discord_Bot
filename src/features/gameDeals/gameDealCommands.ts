import { MessageFlags, type ChatInputCommandInteraction, type GuildMember, type SendableChannels } from "discord.js";
import type { BotContext } from "../../bot/context.js";
import { componentCardsPayload } from "../panels/componentCard.js";
import { isAdmin } from "../../core/permission.js";
import { parseGameStoreLink, scanCurrentFreeGamesDetailed } from "./gameDealScanner.js";
import { createGameDealRepository } from "./postgresGameDealRepository.js";
import { scanSteamNowFullDiscountItems } from "./steamFreeScanner.js";
import type { GameDealFreeItem, GameDealScanResult } from "./gameDealTypes.js";

function chunkItems(items: GameDealFreeItem[], size = 10): GameDealFreeItem[][] {
  const chunks: GameDealFreeItem[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function configuredGameDealChannelId(ctx: BotContext): string | null {
  return ctx.config.GAME_DEAL_CHANNEL_ID?.trim() || null;
}

function configuredGameDealRoleId(ctx: BotContext): string | null {
  return ctx.config.GAME_DEAL_NOTIFY_ROLE_ID?.trim() || null;
}

async function ensureGameDealCommandChannel(interaction: ChatInputCommandInteraction, ctx: BotContext): Promise<string | null> {
  const channelId = configuredGameDealChannelId(ctx);
  if (!channelId) {
    await interaction.reply({
      content: `${ctx.config.BOT_PROFILE} 用の GAME_DEAL_CHANNEL_ID が設定されていません。PRODUCTION_GAME_DEAL_CHANNEL_ID または DEBUG_GAME_DEAL_CHANNEL_ID を確認してください。`,
      flags: MessageFlags.Ephemeral,
    });
    return null;
  }
  if (interaction.channelId !== channelId) {
    await interaction.reply({ content: `このコマンドは <#${channelId}> でのみ使用できます。`, flags: MessageFlags.Ephemeral });
    return null;
  }
  return channelId;
}

function gameDealRoleMention(ctx: BotContext): string | undefined {
  const roleId = configuredGameDealRoleId(ctx);
  return roleId ? `<@&${roleId}>` : undefined;
}

function gameDealAllowedMentions(ctx: BotContext): { roles?: string[]; parse: [] } {
  const roleId = configuredGameDealRoleId(ctx);
  return roleId ? { roles: [roleId], parse: [] } : { parse: [] };
}

async function fetchGameDealChannel(interaction: ChatInputCommandInteraction, channelId: string): Promise<SendableChannels | null> {
  const channel = await interaction.client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased() || channel.isDMBased() || !channel.isSendable()) return null;
  return channel;
}

async function sendGameDealItemsToChannel(
  interaction: ChatInputCommandInteraction,
  items: GameDealFreeItem[],
  ctx: BotContext,
  channelId: string,
): Promise<boolean> {
  const channel = await fetchGameDealChannel(interaction, channelId);
  if (!channel) return false;
  const roleMention = gameDealRoleMention(ctx);
  const allowedMentions = gameDealAllowedMentions(ctx);
  if (roleMention) {
    await channel.send({ content: roleMention, allowedMentions });
  }
  if (items.some((item) => item.components && item.components.length > 0)) {
    for (const item of items) {
      await channel.send({
        ...componentCardsPayload([item.embed], item.components ?? []),
        allowedMentions: { parse: [] },
      });
    }
    return true;
  }
  for (const chunk of chunkItems(items)) {
    await channel.send({
      ...componentCardsPayload(chunk.map((item) => item.embed)),
      allowedMentions: { parse: [] },
    });
  }
  return true;
}

function okSourceCount(scan: GameDealScanResult): number {
  return scan.sources.filter((source) => source.status === "ok").length;
}

function steamSourceNote(scan: GameDealScanResult): string {
  const steam = scan.sources.find((source) => source.platform === "steam");
  if (!steam || steam.status === "ok") return "";
  return "\nSteam側の取得に失敗しました。Epicなど取得できた情報のみ表示します。";
}

function steamWatchNote(): string {
  return "Steamは指定の100%OFF検索ページを監視し、対象ゲームを検証して通知します。";
}

export async function handleGameOn(
  interaction: ChatInputCommandInteraction,
  ctx: BotContext,
  member: GuildMember | null,
): Promise<void> {
  if (!member || !isAdmin(member, ctx.config)) {
    await interaction.reply({ content: "権限がありません。", flags: MessageFlags.Ephemeral });
    return;
  }
  const repo = createGameDealRepository(ctx);
  const channelId = await ensureGameDealCommandChannel(interaction, ctx);
  if (!channelId) return;
  const result = await repo.enableNotifyChannel(interaction.guildId!, channelId);
  if (result.alreadyEnabledInChannel) {
    await interaction.reply({ content: "既にこのチャンネルでゲーム無料お知らせは有効です", flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const scan = await scanCurrentFreeGamesDetailed(ctx);
  const items = scan.items.filter((item) => item.platform === "epic");
  for (const item of items) await repo.upsertFreeSeen(item, true);
  if (okSourceCount(scan) === 0) {
    await interaction.editReply(`ゲーム無料情報の取得に失敗しました。時間をおいて再度試してください。\n${steamWatchNote()}`);
    return;
  }
  if (items.length === 0) {
    await interaction.editReply(`このチャンネルでゲーム無料お知らせを有効化しました。Epicの現在無料候補はありません。\n${steamWatchNote()}${steamSourceNote(scan)}`);
    return;
  }
  const sent = await sendGameDealItemsToChannel(interaction, items, ctx, channelId);
  await interaction.editReply(
    sent
      ? `このチャンネルでゲーム無料お知らせを有効化しました。Epicの現在無料候補 ${items.length}件を送信しました。\n${steamWatchNote()}${steamSourceNote(scan)}`
      : "通知チャンネルを取得できませんでした。",
  );
}

export async function handleGameOff(
  interaction: ChatInputCommandInteraction,
  ctx: BotContext,
  member: GuildMember | null,
): Promise<void> {
  if (!member || !isAdmin(member, ctx.config)) {
    await interaction.reply({ content: "権限がありません。", flags: MessageFlags.Ephemeral });
    return;
  }
  const repo = createGameDealRepository(ctx);
  await repo.disableNotifyChannel(interaction.guildId!);
  await interaction.reply({ content: "このサーバーのゲーム無料お知らせを無効化しました。", flags: MessageFlags.Ephemeral });
}

export async function handleGameNow(
  interaction: ChatInputCommandInteraction,
  ctx: BotContext,
  member: GuildMember | null,
): Promise<void> {
  if (!member || !isAdmin(member, ctx.config)) {
    await interaction.reply({ content: "権限がありません。", flags: MessageFlags.Ephemeral });
    return;
  }
  const channelId = await ensureGameDealCommandChannel(interaction, ctx);
  if (!channelId) return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const items = await scanSteamNowFullDiscountItems(ctx).catch((err) => {
    ctx.log.warn({ err }, "steam now full discount scan failed");
    return null;
  });
  if (items === null) {
    await interaction.editReply("Steamの100%割引商品の取得に失敗しました。時間をおいて再度試してください。");
    return;
  }
  if (items.length === 0) {
    await interaction.editReply("現在検出できるSteamの100%割引商品はありません。");
    return;
  }
  const sent = await sendGameDealItemsToChannel(interaction, items, ctx, channelId);
  await interaction.editReply(sent ? `Steamの100%割引商品 ${items.length}件を送信しました。` : "通知チャンネルを取得できませんでした。");
}

export async function handleGameSub(interaction: ChatInputCommandInteraction, ctx: BotContext): Promise<void> {
  const repo = createGameDealRepository(ctx);
  const channelId = await ensureGameDealCommandChannel(interaction, ctx);
  if (!channelId) return;
  const link = interaction.options.getString("link", true);
  const parsed = parseGameStoreLink(link);
  if (!parsed) {
    await interaction.reply({
      content: "Steam または Epic Games Store のゲームURLを指定してください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const sub = await repo.addSubscription({
    guildId: interaction.guildId!,
    channelId,
    userId: interaction.user.id,
    platform: parsed.platform,
    targetId: parsed.targetId,
    url: parsed.url,
  });
  await interaction.reply({
    content: `登録しました。割引または無料化を検出したら <#${sub.channelId}> で <@${sub.userId}> に通知します。`,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

export async function handleGameSubList(interaction: ChatInputCommandInteraction, ctx: BotContext): Promise<void> {
  const repo = createGameDealRepository(ctx);
  const rows = await repo.listActiveSubscriptionsForUser(interaction.guildId!, interaction.user.id);
  if (rows.length === 0) {
    await interaction.reply({ content: "監視中のゲームはありません。", flags: MessageFlags.Ephemeral });
    return;
  }
  const lines = rows.slice(0, 25).map((row, index) => {
    const platform = row.platform === "steam" ? "Steam" : "Epic Games";
    const title = row.title ?? `${platform} ${row.targetId}`;
    return `${index + 1}. ${title} / ${platform} / <#${row.channelId}>\n${row.url}`;
  });
  const suffix = rows.length > 25 ? `\nほか${rows.length - 25}件の監視があります。` : "";
  await interaction.reply({
    content: `監視中のゲーム:\n${lines.join("\n").slice(0, 1900)}${suffix}`,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}
