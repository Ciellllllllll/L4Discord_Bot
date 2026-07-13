import { ComponentCardBuilder, componentCardsPayload } from "../panels/componentCard.js";
import type { Channel } from "discord.js";

import type { Kysely } from "kysely";
import type pino from "pino";
import type { Database } from "../../core/db/types.js";
import { getGuildSettingsData, upsertGuildSettingsData } from "../../core/guildSettings.js";

// タイトルは「ログ対象切り替え」（Embed 見出しとして大きく表示）。チャンネル・実行者は <#…> / <@…> でリンク表示。括弧は使わない

export function buildNologToggleEmbed(opts: {
  nowExcluded: boolean;
  channelId: string;
  executorUserId: string;
}): ComponentCardBuilder {
  const channelMention = `<#${opts.channelId}>`;
  const executorMention = `<@${opts.executorUserId}>`;
  const summaryLine = opts.nowExcluded
    ? "このチャンネルはログ記録の対象外に切り替わりました。"
    : "このチャンネルはログ記録の対象として再度有効になりました。";
  return new ComponentCardBuilder()
    .setTitle("ログ対象切り替え")
    .setDescription(
      `${summaryLine}\n\n` + `対象チャンネル：${channelMention}\n` + `実行者：${executorMention}`,
    );
}

// message_log_excluded_channel_ids をトグル。戻り値の nowExcluded はトグル後に当該チャンネルが除外リストに含まれるか。

export async function toggleMessageLogExcludedForChannel(
  db: Kysely<Database>,
  guildId: string,
  channelId: string,
): Promise<{ nowExcluded: boolean }> {
  const settings = await getGuildSettingsData(db, guildId);
  const prev = [...(settings.message_log_excluded_channel_ids ?? [])];
  const next = [...prev];
  const idx = next.indexOf(channelId);
  if (idx >= 0) next.splice(idx, 1);
  else next.push(channelId);
  await upsertGuildSettingsData(db, guildId, { message_log_excluded_channel_ids: next });
  return { nowExcluded: next.includes(channelId) };
}

export async function runNologToggleAndBuildEmbed(
  db: Kysely<Database>,
  guildId: string,
  channelId: string,
  executorUserId: string,
): Promise<ComponentCardBuilder> {
  const { nowExcluded } = await toggleMessageLogExcludedForChannel(db, guildId, channelId);
  return buildNologToggleEmbed({ nowExcluded, channelId, executorUserId });
}

// ボイス／テキスト等、send 可能なチャンネルへ Embed を送る

export async function trySendNologEmbedInChannel(
  channel: Channel,
  embed: ComponentCardBuilder,
  log: pino.Logger,
  executorUserId?: string,
): Promise<void> {
  try {
    if (channel.isTextBased() && !channel.isDMBased()) {
      await channel.send({
        ...componentCardsPayload([embed]),
        ...(executorUserId ? { allowedMentions: { users: [executorUserId] } } : {}),
      });
    }
  } catch (e) {
    log.warn({ err: String(e) }, "nolog embed channel.send failed");
  }
}
