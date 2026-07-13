import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type Guild,
  type Message,
  type MessageEditOptions,
} from "discord.js";
import type { BotContext } from "../../bot/context.js";
import { getGuildSettingsData } from "../../core/guildSettings.js";
import { getPermanentUiVersion } from "../../core/releaseVersions.js";
import { buildContainerPanelPayload, messageComponentsHaveCustomId } from "../panels/componentPanelPayload.js";
import { PANEL_KIND_AUTOMOD } from "../panels/constants.js";
import { ensurePanelMessageRow, savePanelMessageRow } from "../panels/panelMessageStore.js";
import { parsePanelState } from "../panels/panelState.js";
import { getMergedAutoModSettings } from "./autoModerationSettings.js";
import { AUTOMOD_SELECT_PREFIX, PANEL_TOGGLE_OPTIONS } from "./autoModerationTypes.js";

function messageHasAutomodSelect(message: Message, guildId: string): boolean {
  const prefix = `${AUTOMOD_SELECT_PREFIX}${guildId}`;
  return messageComponentsHaveCustomId(message.components, new Set([prefix]));
}

export function automodPanelMessageMatches(message: Message, botUserId: string, guildId: string): boolean {
  if (message.author?.id !== botUserId) return false;
  return messageHasAutomodSelect(message, guildId);
}

export async function buildAutoModPanelPayload(ctx: BotContext, guildId: string) {
  const s = await getMergedAutoModSettings(ctx, guildId);
  const enabledLabel = (value: boolean): string => (value ? "ON" : "OFF");
  const panelText = [
    "## 自動モデレーション管理",
    "投稿ブロックとRaidモードをまとめて切り替えます。",
    "Raidモードの変更は確認画面を経てから反映されます。",
    "",
    "**現在の設定**",
    `全体: **${enabledLabel(s.enabled)}**`,
    `外部リンク: **${enabledLabel(s.linkBlock)}**`,
    `招待リンク: **${enabledLabel(s.inviteBlock)}**`,
    `連投スパム: **${enabledLabel(s.spamBlock)}**`,
    `Raidモード: **${enabledLabel(s.raidMode)}**`,
    `スパム判定時間: **${s.spamWindowSec}秒**`,
    `スパムしきい値: **${s.spamThreshold}件**`,
    "",
  ].join("\n");

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
  return buildContainerPanelPayload(panelText, [row]);
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
    ctx.log.warn({ channelId, guildId, panelKind: PANEL_KIND_AUTOMOD }, "automod panel channel missing or not text");
    return false;
  }

  const codeVer = getPermanentUiVersion(PANEL_KIND_AUTOMOD);
  let row = await ensurePanelMessageRow(ctx, guildId, PANEL_KIND_AUTOMOD, channelId);

  if (row.channel_id !== channelId) {
    row = { ...row, channel_id: channelId };
  }

  const payload = await buildAutoModPanelPayload(ctx, guildId);
  const editPayload = { ...payload, content: null } satisfies MessageEditOptions;
  const botId = ctx.client.user?.id ?? "";

  if (row.message_id && botId) {
    const oldMsg = await channel.messages.fetch(row.message_id).catch(() => null);
    if (oldMsg?.author?.id === botId && automodPanelMessageMatches(oldMsg, botId, guildId)) {
      try {
        await oldMsg.edit(editPayload);
      } catch (err) {
        ctx.log.error({ err, channelId, guildId, panelKind: PANEL_KIND_AUTOMOD }, "automod panel edit failed");
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
    const existing = recent.find((m) => m.author?.id === botId && automodPanelMessageMatches(m, botId, guildId));
    if (existing) {
      try {
        await existing.edit(editPayload);
      } catch (err) {
        ctx.log.error({ err, channelId, guildId, panelKind: PANEL_KIND_AUTOMOD }, "automod panel reconnect edit failed");
        return false;
      }
      await savePanelMessageRow(ctx, row.id, channelId, existing.id, {
        ...parsePanelState(row.data),
        ui_version: codeVer,
        status: "sent",
        last_sent_at: new Date().toISOString(),
      });
      ctx.log.debug({ messageId: existing.id }, "automod panel reconnected via scan");
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
  ctx.log.debug({ messageId: sent.id }, "automod panel sent");
  return true;
}
