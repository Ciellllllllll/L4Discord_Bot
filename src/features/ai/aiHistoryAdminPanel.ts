import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  StringSelectMenuBuilder,
  type ButtonInteraction,
  type Guild,
  type Message,
  type MessageEditOptions,
  type StringSelectMenuInteraction,
} from "discord.js";
import { sql } from "kysely";
import type { BotContext } from "../../bot/context.js";
import { getGuildSettingsData } from "../../core/guildSettings.js";
import { getPermanentUiVersion } from "../../core/releaseVersions.js";
import { PANEL_KIND_AI_QUERY_HISTORY } from "../panels/constants.js";
import { buildContainerPanelPayload, messageComponentsHaveCustomId } from "../panels/componentPanelPayload.js";
import { ensurePanelMessageRow, savePanelMessageRow } from "../panels/panelMessageStore.js";
import { parsePanelState } from "../panels/panelState.js";

// DiscordBOTv2 AI_Query.js と同一の customId

export const HISTORY_ADMIN_USER_SELECT_ID = "chatgpt_history_admin_select_user";
export const HISTORY_ADMIN_CONVERSATION_SELECT_PREFIX = "chatgpt_history_admin_select_conversation:";
export const HISTORY_CLEAR_ALL_ID = "chatgpt_history_clear_all";
export const HISTORY_CLEAR_ME_ID = "chatgpt_history_clear_me";

// !Setup で保存した ADMIN パネルチャンネルのみ（履歴管理 UI をここに置く）

export async function resolveAiHistoryAdminChannelId(ctx: BotContext, guildId: string): Promise<string | null> {
  const settings = await getGuildSettingsData(ctx.db, guildId);
  const a = settings.panel_channels?.admin_channel_id?.trim();
  return a && /^\d+$/.test(a) ? a : null;
}

function safeStrip(text: string): string {
  return String(text || "").trim();
}

function truncateText(text: string, maxLen = 80): string {
  const s = safeStrip(text).replace(/\s+/g, " ");
  if (s.length <= maxLen) {
    return s || "(empty)";
  }
  return `${s.slice(0, Math.max(1, maxLen - 1))}…`;
}

function messageHasAnyCustomId(message: Message, customIds: Set<string>): boolean {
  if (!message.components?.length) return false;
  return messageComponentsHaveCustomId(message.components, customIds);
}

export function parseConversationRanges(values: string[]): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  for (const value of values) {
    const m = /^range:(\d+):(\d+)$/.exec(String(value));
    if (!m) continue;
    const start = Number(m[1]);
    const end = Number(m[2]);
    if (Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end >= start) {
      ranges.push({ start, end });
    }
  }
  return ranges;
}

function getConversationSegments(
  history: { role: string; content: string }[],
): { start: number; end: number; preview: string }[] {
  const segments: { start: number; end: number; preview: string }[] = [];
  let index = 0;
  while (index < history.length) {
    const start = index;
    const first = history[index];
    const preview = first?.content || "";
    index += 1;
    while (index < history.length && history[index]?.role !== "user") {
      index += 1;
    }
    const end = index - 1;
    segments.push({ start, end, preview });
  }
  return segments;
}

async function listDistinctHistoryUserIds(ctx: BotContext, guildId: string): Promise<string[]> {
  const rows = await ctx.aiHistoryDb
    .selectFrom("ai_history")
    .select(["user_id", sql<string>`max(created_at)`.as("last_at")])
    .where("guild_id", "=", guildId)
    .groupBy("user_id")
    .orderBy(sql`max(created_at)`, "desc")
    .execute();
  return rows.map((r) => r.user_id);
}

async function loadUserHistoryRows(
  ctx: BotContext,
  guildId: string,
  userId: string,
): Promise<{ id: string; role: string; content: string }[]> {
  return ctx.aiHistoryDb
    .selectFrom("ai_history")
    .select(["id", "role", "content"])
    .where("guild_id", "=", guildId)
    .where("user_id", "=", userId)
    .orderBy("created_at", "asc")
    .execute();
}

export async function deleteAiHistoryRanges(
  ctx: BotContext,
  guildId: string,
  userId: string,
  ranges: { start: number; end: number }[],
): Promise<number> {
  const rows = await loadUserHistoryRows(ctx, guildId, userId);
  if (!rows.length || !ranges.length) {
    return 0;
  }
  const deleteIndexes = new Set<number>();
  for (const range of ranges) {
    for (let i = range.start; i <= range.end; i += 1) {
      deleteIndexes.add(i);
    }
  }
  const ids = [...deleteIndexes]
    .filter((i) => i >= 0 && i < rows.length)
    .map((i) => rows[i]!.id);
  if (!ids.length) {
    return 0;
  }
  const uniqueIds = [...new Set(ids)];
  await ctx.aiHistoryDb.deleteFrom("ai_history").where("id", "in", uniqueIds).execute();
  return uniqueIds.length;
}

export async function clearAllAiHistoryInGuild(ctx: BotContext, guildId: string): Promise<number> {
  const r = await ctx.aiHistoryDb.deleteFrom("ai_history").where("guild_id", "=", guildId).executeTakeFirst();
  return Number(r.numDeletedRows ?? 0);
}

export async function clearUserAiHistory(ctx: BotContext, guildId: string, userId: string): Promise<void> {
  await ctx.aiHistoryDb
    .deleteFrom("ai_history")
    .where("guild_id", "=", guildId)
    .where("user_id", "=", userId)
    .execute();
}

function buildHistoryUserOptions(ctx: BotContext, userIds: string[]) {
  const ids = userIds.slice(0, 25);
  return ids.map((id) => {
    const cached = ctx.client.users.cache.get(id);
    const label = cached
      ? truncateText(`${cached.username} (${id})`, 100)
      : truncateText(id, 100);
    return {
      label,
      value: id,
      description: "会話履歴を削除する対象ユーザー",
    };
  });
}

export async function buildAiHistoryAdminPanelPayload(ctx: BotContext, guildId: string) {
  const userIds = await listDistinctHistoryUserIds(ctx, guildId);
  const userOptions = buildHistoryUserOptions(ctx, userIds);
  const userRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(HISTORY_ADMIN_USER_SELECT_ID)
      .setPlaceholder(userOptions.length ? "履歴を削除するユーザーを選択" : "履歴ユーザーがいません")
      .setDisabled(!userOptions.length)
      .addOptions(
        userOptions.length
          ? userOptions
          : [
              {
                label: "履歴ユーザーなし",
                value: "none",
                description: "削除対象がありません",
              },
            ],
      ),
  );

  const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(HISTORY_CLEAR_ALL_ID)
      .setLabel("全履歴削除")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(HISTORY_CLEAR_ME_ID)
      .setLabel("自分の履歴を削除")
      .setStyle(ButtonStyle.Secondary),
  );

  return buildContainerPanelPayload(
    [
      "## /q 履歴管理",
      "会話履歴のユーザー別削除と全履歴削除を実行できます。",
      "全履歴削除はOWNER専用です。",
      "",
      "**現在の状態**",
      userIds.length ? `履歴ユーザー: **${userIds.length}人**` : "削除対象の履歴ユーザーはいません。",
      "",
      "**操作**",
      "ユーザー選択   自分の履歴削除   全履歴削除",
      "",
    ].join("\n"),
    [userRow, actionRow],
  );
}

export async function refreshHistoryAdminPanelMessage(message: Message, ctx: BotContext): Promise<void> {
  const botId = ctx.client.user?.id;
  if (!message || message.author?.id !== botId || !message.guildId) {
    return;
  }
  const payload = await buildAiHistoryAdminPanelPayload(ctx, message.guildId);
  await message.edit({ ...payload, content: null } satisfies MessageEditOptions).catch(() => undefined);
}

export async function reconcileAiHistoryAdminPanel(ctx: BotContext, guild: Guild, channelId: string): Promise<boolean> {
  const guildId = ctx.config.GUILD_ID;
  if (guild.id !== guildId) {
    return false;
  }

  let channel = guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId).catch(() => null));
  if (!channel?.isTextBased()) {
    ctx.log.warn({ channelId, guildId, panelKind: PANEL_KIND_AI_QUERY_HISTORY }, "AI history panel channel missing or not text");
    return false;
  }

  const codeVer = getPermanentUiVersion(PANEL_KIND_AI_QUERY_HISTORY);
  let row = await ensurePanelMessageRow(ctx, guildId, PANEL_KIND_AI_QUERY_HISTORY, channelId);

  if (row.channel_id !== channelId) {
    row = { ...row, channel_id: channelId };
  }

  const payload = await buildAiHistoryAdminPanelPayload(ctx, guildId);
  const editPayload = { ...payload, content: null } satisfies MessageEditOptions;
  const customIds = new Set([
    HISTORY_ADMIN_USER_SELECT_ID,
    HISTORY_CLEAR_ALL_ID,
    HISTORY_CLEAR_ME_ID,
  ]);
  const botId = ctx.client.user?.id ?? "";

  if (row.message_id && botId) {
    const oldMsg = await channel.messages.fetch(row.message_id).catch(() => null);
    if (oldMsg?.author?.id === botId) {
      try {
        await oldMsg.edit(editPayload);
      } catch (err) {
        ctx.log.error({ err, channelId, guildId, panelKind: PANEL_KIND_AI_QUERY_HISTORY }, "AI history panel edit failed");
        return false;
      }
      await savePanelMessageRow(ctx, row.id, channelId, oldMsg.id, {
        ...parsePanelState(row.data),
        ui_version: codeVer,
        status: "sent",
        last_sent_at: new Date().toISOString(),
      });
      return true;
    }
  }

  const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  if (recent && botId) {
    const existing = recent.find((m) => m.author?.id === botId && messageHasAnyCustomId(m, customIds));
    if (existing) {
      try {
        await existing.edit(editPayload);
      } catch (err) {
        ctx.log.error({ err, channelId, guildId, panelKind: PANEL_KIND_AI_QUERY_HISTORY }, "AI history panel reconnect edit failed");
        return false;
      }
      await savePanelMessageRow(ctx, row.id, channelId, existing.id, {
        ...parsePanelState(row.data),
        ui_version: codeVer,
        status: "sent",
        last_sent_at: new Date().toISOString(),
      });
      return true;
    }
  }

  const sent = await channel.send(payload);
  await savePanelMessageRow(ctx, row.id, channelId, sent.id, {
    ...parsePanelState(row.data),
    ui_version: codeVer,
    status: "sent",
    last_sent_at: new Date().toISOString(),
  });
  return true;
}

export async function sendOrReconnectAiHistoryAdminPanel(ctx: BotContext): Promise<boolean> {
  const guildId = ctx.config.GUILD_ID;
  const channelId = await resolveAiHistoryAdminChannelId(ctx, guildId);
  if (!channelId) {
    return false;
  }

  const guild = ctx.client.guilds.cache.get(guildId) ?? (await ctx.client.guilds.fetch(guildId).catch(() => null));
  if (!guild) {
    return false;
  }

  return reconcileAiHistoryAdminPanel(ctx, guild, channelId);
}

function isOwner(ctx: BotContext, userId: string): boolean {
  const oid = ctx.config.OWNER_ID.trim();
  return /^\d+$/.test(oid) && userId === oid;
}

async function buildConversationOptionsForUser(
  ctx: BotContext,
  guildId: string,
  userId: string,
): Promise<{
  options: { label: string; value: string; description: string }[];
  historyCount: number;
}> {
  const rows = await loadUserHistoryRows(ctx, guildId, userId);
  const history = rows.map((r) => ({ role: r.role, content: r.content }));
  const segments = getConversationSegments(history);
  const withIndex = segments.map((seg, idx) => ({ ...seg, idx })).reverse().slice(0, 24);

  const options: { label: string; value: string; description: string }[] = [
    {
      label: "このユーザーの全履歴を削除",
      value: "all",
      description: "選択ユーザーの履歴をすべて削除",
    },
  ];

  for (const seg of withIndex) {
    options.push({
      label: truncateText(`#${seg.idx + 1} ${seg.preview}`, 100),
      value: `range:${seg.start}:${seg.end}`,
      description: `${seg.end - seg.start + 1}件のメッセージ`,
    });
  }

  return { options, historyCount: rows.length };
}

export async function handleAiHistoryAdminButton(
  interaction: ButtonInteraction,
  ctx: BotContext,
): Promise<boolean> {
  if (interaction.customId === HISTORY_CLEAR_ALL_ID) {
    if (!interaction.guildId || interaction.guildId !== ctx.config.GUILD_ID) {
      await interaction.reply({ content: "このサーバーでは利用できません。", flags: MessageFlags.Ephemeral });
      return true;
    }
    if (!isOwner(ctx, interaction.user.id)) {
      await interaction.reply({ content: "OWNER 専用です。", flags: MessageFlags.Ephemeral });
      return true;
    }
    const count = await clearAllAiHistoryInGuild(ctx, interaction.guildId);
    await refreshHistoryAdminPanelMessage(interaction.message, ctx);
    await interaction.reply({ content: `全履歴を削除しました。（${count} 行）`, flags: MessageFlags.Ephemeral });
    return true;
  }

  if (interaction.customId === HISTORY_CLEAR_ME_ID) {
    if (!interaction.guildId || interaction.guildId !== ctx.config.GUILD_ID) {
      await interaction.reply({ content: "このサーバーでは利用できません。", flags: MessageFlags.Ephemeral });
      return true;
    }
    await clearUserAiHistory(ctx, interaction.guildId, interaction.user.id);
    await sendOrReconnectAiHistoryAdminPanel(ctx).catch(() => undefined);
    await interaction.reply({ content: "あなたの履歴を削除しました。", flags: MessageFlags.Ephemeral });
    return true;
  }

  return false;
}

export async function handleAiHistoryAdminStringSelect(
  interaction: StringSelectMenuInteraction,
  ctx: BotContext,
): Promise<boolean> {
  if (!interaction.guildId || interaction.guildId !== ctx.config.GUILD_ID) {
    return false;
  }

  if (interaction.customId === HISTORY_ADMIN_USER_SELECT_ID) {
    if (!isOwner(ctx, interaction.user.id)) {
      await interaction.reply({ content: "OWNER 専用です。", flags: MessageFlags.Ephemeral });
      return true;
    }

    const userId = interaction.values?.[0];
    if (!userId || userId === "none" || !/^\d+$/.test(String(userId))) {
      await interaction.reply({ content: "対象ユーザーが不正です。", flags: MessageFlags.Ephemeral });
      return true;
    }

    const { options, historyCount } = await buildConversationOptionsForUser(ctx, interaction.guildId, userId);
    if (historyCount === 0) {
      await refreshHistoryAdminPanelMessage(interaction.message, ctx);
      await interaction.reply({ content: "このユーザーの履歴はありません。", flags: MessageFlags.Ephemeral });
      return true;
    }

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`${HISTORY_ADMIN_CONVERSATION_SELECT_PREFIX}${userId}`)
        .setPlaceholder("削除する会話(複数可)を選択")
        .setMinValues(1)
        .setMaxValues(Math.min(25, options.length))
        .addOptions(options),
    );

    await refreshHistoryAdminPanelMessage(interaction.message, ctx);
    await interaction.reply({
      content: `対象ユーザー: <@${userId}> （${historyCount}件のメッセージ）`,
      components: [row],
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (interaction.customId.startsWith(HISTORY_ADMIN_CONVERSATION_SELECT_PREFIX)) {
    if (!isOwner(ctx, interaction.user.id)) {
      await interaction.reply({ content: "OWNER 専用です。", flags: MessageFlags.Ephemeral });
      return true;
    }

    const userId = interaction.customId.slice(HISTORY_ADMIN_CONVERSATION_SELECT_PREFIX.length);
    if (!/^\d+$/.test(String(userId))) {
      await interaction.reply({ content: "対象ユーザーが不正です。", flags: MessageFlags.Ephemeral });
      return true;
    }

    if (interaction.values.includes("all")) {
      await clearUserAiHistory(ctx, interaction.guildId, userId);
      await sendOrReconnectAiHistoryAdminPanel(ctx).catch(() => undefined);
      await interaction.reply({ content: `<@${userId}> の全履歴を削除しました。`, flags: MessageFlags.Ephemeral });
      return true;
    }

    const rows = await loadUserHistoryRows(ctx, interaction.guildId, userId);
    if (!rows.length) {
      await sendOrReconnectAiHistoryAdminPanel(ctx).catch(() => undefined);
      await interaction.reply({ content: "履歴が見つかりませんでした。", flags: MessageFlags.Ephemeral });
      return true;
    }

    const ranges = parseConversationRanges(interaction.values);
    if (!ranges.length) {
      await interaction.reply({ content: "削除対象の会話が不正です。", flags: MessageFlags.Ephemeral });
      return true;
    }

    const removed = await deleteAiHistoryRanges(ctx, interaction.guildId, userId, ranges);
    if (removed <= 0) {
      await interaction.reply({ content: "削除対象が見つかりませんでした。", flags: MessageFlags.Ephemeral });
      return true;
    }

    await sendOrReconnectAiHistoryAdminPanel(ctx).catch(() => undefined);
    await interaction.reply({
      content: `<@${userId}> の会話履歴を削除しました。（${removed}件）`,
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  return false;
}
