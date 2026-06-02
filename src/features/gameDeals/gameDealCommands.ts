import { MessageFlags, type ChatInputCommandInteraction, type GuildMember } from "discord.js";
import type { BotContext } from "../../bot/context.js";
import { isAdmin } from "../../core/permission.js";
import { buildGameDealStatusEmbed } from "./gameDealEmbeds.js";
import { GameDealRepository } from "./gameDealRepository.js";
import { parseGameStoreLink, scanCurrentFreeGamesDetailed } from "./gameDealScanner.js";
import type { GameDealFreeItem, GameDealScanResult } from "./gameDealTypes.js";

function chunkItems(items: GameDealFreeItem[], size = 10): GameDealFreeItem[][] {
  const chunks: GameDealFreeItem[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

async function sendGameDealItemChunks(
  interaction: ChatInputCommandInteraction,
  items: GameDealFreeItem[],
  firstContent: string,
): Promise<void> {
  if (items.some((item) => item.components && item.components.length > 0)) {
    const [first, ...rest] = items;
    await interaction.editReply({
      content: firstContent,
      embeds: first ? [first.embed] : [],
      components: first?.components ?? [],
      allowedMentions: { parse: [] },
    });
    for (const item of rest) {
      await interaction.followUp({
        embeds: [item.embed],
        components: item.components ?? [],
        allowedMentions: { parse: [] },
      });
    }
    return;
  }
  const chunks = chunkItems(items);
  const [first, ...rest] = chunks;
  await interaction.editReply({
    content: firstContent,
    embeds: (first ?? []).map((item) => item.embed),
    allowedMentions: { parse: [] },
  });
  let page = 2;
  for (const chunk of rest) {
    await interaction.followUp({
      content: `ゲーム無料候補 続き ${page}/${chunks.length}`,
      embeds: chunk.map((item) => item.embed),
      allowedMentions: { parse: [] },
    });
    page += 1;
  }
}

function okSourceCount(scan: GameDealScanResult): number {
  return scan.sources.filter((source) => source.status === "ok").length;
}

function steamSourceNote(scan: GameDealScanResult): string {
  const steam = scan.sources.find((source) => source.platform === "steam");
  if (!steam || steam.status === "ok") return "";
  return "\nSteam側の取得に失敗しました。Epicなど取得できた情報のみ表示します。";
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
  const repo = new GameDealRepository(ctx.sqlite);
  const result = repo.enableNotifyChannel(interaction.guildId!, interaction.channelId);
  if (result.alreadyEnabledInChannel) {
    await interaction.reply({ content: "既にこのチャンネルでゲーム無料お知らせは有効です", flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferReply();
  const scan = await scanCurrentFreeGamesDetailed(ctx);
  const items = scan.items;
  for (const item of items) repo.upsertFreeSeen(item, true);
  if (okSourceCount(scan) === 0) {
    await interaction.editReply("ゲーム無料情報の取得に失敗しました。時間をおいて再度試してください。");
    return;
  }
  if (items.length === 0) {
    await interaction.editReply(`このチャンネルでゲーム無料お知らせを有効化しました。現在検出できる無料候補はありません。${steamSourceNote(scan)}`);
    return;
  }
  await sendGameDealItemChunks(
    interaction,
    items,
    `このチャンネルでゲーム無料お知らせを有効化しました。現在検出できた候補: ${items.length}件${steamSourceNote(scan)}`,
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
  new GameDealRepository(ctx.sqlite).disableNotifyChannel(interaction.guildId!);
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
  await interaction.deferReply();
  const scan = await scanCurrentFreeGamesDetailed(ctx);
  const items = scan.items;
  if (okSourceCount(scan) === 0) {
    await interaction.editReply("ゲーム無料情報の取得に失敗しました。時間をおいて再度試してください。");
    return;
  }
  if (items.length === 0) {
    await interaction.editReply(`現在検出できるゲーム無料候補はありません。${steamSourceNote(scan)}`);
    return;
  }
  await sendGameDealItemChunks(interaction, items, `現在検出できたゲーム無料候補: ${items.length}件${steamSourceNote(scan)}`);
}

export async function handleGameStatus(
  interaction: ChatInputCommandInteraction,
  ctx: BotContext,
  member: GuildMember | null,
): Promise<void> {
  if (!member || !isAdmin(member, ctx.config)) {
    await interaction.reply({ content: "権限がありません。", flags: MessageFlags.Ephemeral });
    return;
  }
  const repo = new GameDealRepository(ctx.sqlite);
  const channel = repo.getNotifyChannel(interaction.guildId!);
  await interaction.reply({
    embeds: [
      buildGameDealStatusEmbed({
        enabled: channel?.enabled === true,
        channelId: channel?.enabled ? channel.channelId : null,
        status: repo.getStatus(),
      }),
    ],
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

export async function handleGameSub(interaction: ChatInputCommandInteraction, ctx: BotContext): Promise<void> {
  const link = interaction.options.getString("link", true);
  const parsed = parseGameStoreLink(link);
  if (!parsed) {
    await interaction.reply({
      content: "Steam または Epic Games Store のゲームURLを指定してください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const sub = new GameDealRepository(ctx.sqlite).addSubscription({
    guildId: interaction.guildId!,
    channelId: interaction.channelId,
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
  const rows = new GameDealRepository(ctx.sqlite).listActiveSubscriptionsForUser(interaction.guildId!, interaction.user.id);
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
