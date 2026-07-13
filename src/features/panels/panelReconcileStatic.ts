import type { Guild, Message, MessageCreateOptions, MessageEditOptions } from "discord.js";
import type { BotContext } from "../../bot/context.js";
import { getPermanentUiVersion } from "../../core/releaseVersions.js";
import { tryDeleteBotPanelMessage } from "./panelDiscordOps.js";
import { ensurePanelMessageRow, savePanelMessageRow } from "./panelMessageStore.js";

// 埋め込み＋ボタン等の静的パネルを 1 種類だけ置く（VC/RR と同じ再接続・版管理ルール）。

export async function reconcileStaticPanelMessage(
  ctx: BotContext,
  guild: Guild,
  channelId: string,
  panelKind: string,
  fingerprint: (message: Message, botUserId: string) => boolean,
  buildPayload: () => MessageCreateOptions,
  logTag: string,
): Promise<boolean> {
  const codeVer = getPermanentUiVersion(panelKind);
  let row = await ensurePanelMessageRow(ctx, guild.id, panelKind, channelId);

  if (row.channel_id !== channelId) {
    if (row.message_id) {
      await tryDeleteBotPanelMessage(ctx, guild, row.channel_id, row.message_id);
    }
    await savePanelMessageRow(ctx, row.id, channelId, "", { ...row.data, status: "pending" });
    row = { ...row, channel_id: channelId, message_id: "", data: { ...row.data, status: "pending" } };
  }

  const ch = await guild.channels.fetch(channelId).catch(() => null);
  if (!ch?.isTextBased()) {
    await savePanelMessageRow(ctx, row.id, channelId, row.message_id, {
      ...row.data,
      status: "error",
      last_error: "channel_missing",
    });
    ctx.log.warn({ channelId, logTag }, "static panel channel missing or not text");
    return false;
  }

  const payload = buildPayload();
  const editOpt = { ...payload, content: null } as MessageEditOptions;
  const botId = ctx.client.user?.id ?? "";

  if (row.message_id) {
    const msg = await ch.messages.fetch(row.message_id).catch(() => null);
    if (msg && fingerprint(msg, botId)) {
      if (row.data.ui_version === codeVer) {
        return true;
      }
      try {
        await msg.edit(editOpt);
        await savePanelMessageRow(ctx, row.id, channelId, msg.id, {
          ui_version: codeVer,
          status: "sent",
          last_sent_at: new Date().toISOString(),
        });
      } catch (e) {
        ctx.log.error({ err: e, guildId: guild.id, panelKind, logTag }, "static panel edit failed");
        return false;
      }
      return true;
    }
  }

  const recent = await ch.messages.fetch({ limit: 50 }).catch(() => null);
  if (recent && botId) {
    const existing = recent.find((m) => fingerprint(m, botId));
    if (existing) {
      try {
        if (row.data.ui_version !== codeVer) {
          await existing.edit(editOpt);
        }
        await savePanelMessageRow(ctx, row.id, channelId, existing.id, {
          ui_version: codeVer,
          status: "sent",
          last_sent_at: new Date().toISOString(),
        });
      } catch (e) {
        ctx.log.error({ err: e, guildId: guild.id, panelKind, logTag }, "static panel reconnect edit failed");
        return false;
      }
      ctx.log.debug({ messageId: existing.id, logTag }, "static panel reconnected via scan");
      return true;
    }
  }

  try {
    const sent = await ch.send(payload);
    await savePanelMessageRow(ctx, row.id, channelId, sent.id, {
      ui_version: codeVer,
      status: "sent",
      last_sent_at: new Date().toISOString(),
    });
    ctx.log.debug({ messageId: sent.id, logTag }, "static panel sent");
    return true;
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    await savePanelMessageRow(ctx, row.id, channelId, row.message_id, {
      ...row.data,
      status: "error",
      last_error: err.slice(0, 500),
    });
    ctx.log.error({ err: e, guildId: guild.id, panelKind, logTag }, "static panel send failed");
    return false;
  }
}
