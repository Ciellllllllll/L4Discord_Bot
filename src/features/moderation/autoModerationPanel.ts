import {
  ActionRowBuilder,
  EmbedBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type Guild,
  type Message,
} from "discord.js";
import type { BotContext } from "../../bot/context.js";
import { getGuildSettingsData } from "../../core/guildSettings.js";
import { getPermanentUiVersion } from "../../core/releaseVersions.js";
import { PANEL_KIND_AUTOMOD } from "../panels/constants.js";
import { ensurePanelMessageRow, savePanelMessageRow } from "../panels/panelMessageStore.js";
import { parsePanelState } from "../panels/panelState.js";
import { getMergedAutoModSettings } from "./autoModerationSettings.js";
import { AUTOMOD_SELECT_PREFIX, PANEL_TOGGLE_OPTIONS } from "./autoModerationTypes.js";

function messageHasAutomodSelect(message: Message, guildId: string): boolean {
  const prefix = `${AUTOMOD_SELECT_PREFIX}${guildId}`;
  if (!message.components?.length) return false;
  return message.components.some(
    (row) =>
      "components" in row &&
      Array.isArray(row.components) &&
      row.components.some((c) => "customId" in c && c.customId === prefix),
  );
}

export function automodPanelMessageMatches(message: Message, botUserId: string, guildId: string): boolean {
  if (message.author?.id !== botUserId) return false;
  return messageHasAutomodSelect(message, guildId);
}

export async function buildAutoModPanelPayload(ctx: BotContext, guildId: string) {
  const s = await getMergedAutoModSettings(ctx, guildId);
  const embed = new EmbedBuilder()
    .setTitle("自動モデレーション管理パネル")
    .setColor(0xf1c40f)
    .setDescription("下のチェックボックスでON/OFFを切り替えます。Raidモードは必ず確認を経て反映されます。")
    .addFields(
      { name: "自動モデレーション全体", value: s.enabled ? "ON" : "OFF", inline: true },
      { name: "外部リンク投稿ブロック", value: s.linkBlock ? "ON" : "OFF", inline: true },
      { name: "招待リンク投稿ブロック", value: s.inviteBlock ? "ON" : "OFF", inline: true },
      { name: "連投スパムブロック", value: s.spamBlock ? "ON" : "OFF", inline: true },
      { name: "Raidモード", value: s.raidMode ? "ON" : "OFF", inline: true },
      { name: "スパム判定時間", value: `${s.spamWindowSec}秒`, inline: true },
      { name: "スパムしきい値", value: `${s.spamThreshold}件`, inline: true },
    );

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`${AUTOMOD_SELECT_PREFIX}${guildId}`)
    .setPlaceholder("有効化したい項目にチェックを入れてください")
    .setMinValues(0)
    .setMaxValues(PANEL_TOGGLE_OPTIONS.length)
    .addOptions(
      PANEL_TOGGLE_OPTIONS.map((item) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(item.label)
          .setDescription(item.description)
          .setValue(item.key)
          .setDefault(Boolean(s[item.key])),
      ),
    );

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
  return { embeds: [embed], components: [row] as const };
}

// !Setup の ADMIN チャンネル（panel_channels.admin_channel_id）

export async function resolveAutoModAdminChannelId(ctx: BotContext, guildId: string): Promise<string | null> {
  const settings = await getGuildSettingsData(ctx.db, guildId);
  const a = settings.panel_channels?.admin_channel_id?.trim();
  return a && /^\d+$/.test(a) ? a : null;
}

export async function reconcileAutoModPanel(ctx: BotContext, guild: Guild, channelId: string): Promise<boolean> {
  const guildId = ctx.config.GUILD_ID;
  if (guild.id !== guildId) {
    return false;
  }

  const channel = guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId).catch(() => null));
  if (!channel?.isTextBased()) {
    return false;
  }

  const codeVer = getPermanentUiVersion(PANEL_KIND_AUTOMOD);
  let row = await ensurePanelMessageRow(ctx, guildId, PANEL_KIND_AUTOMOD, channelId);

  if (row.channel_id !== channelId) {
    row = { ...row, channel_id: channelId };
  }

  const payload = await buildAutoModPanelPayload(ctx, guildId);
  const botId = ctx.client.user?.id ?? "";

  if (row.message_id && botId) {
    const oldMsg = await channel.messages.fetch(row.message_id).catch(() => null);
    if (oldMsg?.author?.id === botId && automodPanelMessageMatches(oldMsg, botId, guildId)) {
      await oldMsg.edit(payload).catch(() => undefined);
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
    const existing = recent.find((m) => m.author?.id === botId && automodPanelMessageMatches(m, botId, guildId));
    if (existing) {
      await existing.edit(payload).catch(() => undefined);
      await savePanelMessageRow(ctx, row.id, channelId, existing.id, {
        ...parsePanelState(row.data),
        ui_version: codeVer,
        status: "sent",
        last_sent_at: new Date().toISOString(),
      });
      ctx.log.info({ messageId: existing.id }, "automod panel reconnected via scan");
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
  ctx.log.info({ messageId: sent.id }, "automod panel sent");
  return true;
}
