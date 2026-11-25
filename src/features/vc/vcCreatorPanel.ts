import {
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type Guild,
  type Message,
  type MessageEditOptions,
} from "discord.js";
import type { BotContext } from "../../bot/context.js";
import { getPermanentUiVersion } from "../../core/releaseVersions.js";
import { PANEL_KIND_VC_CREATOR } from "../panels/constants.js";
import { tryDeleteBotPanelMessage } from "../panels/panelDiscordOps.js";
import { ensurePanelMessageRow, savePanelMessageRow } from "../panels/panelMessageStore.js";
import { messageComponentsHaveCustomId } from "../panels/componentPanelPayload.js";
import {
  buildVcCreatorMainPayload,
  buildVcRenameModalCustomId,
  VC_NAME_MODAL_PREFIX,
} from "./vcCreatorUi.js";

export function buildVcNameModal(genre: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`${VC_NAME_MODAL_PREFIX}${genre}`)
    .setTitle("VC名の入力")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("vc_name_input")
          .setLabel("VCの名前 2から30文字")
          .setPlaceholder("例: 雑談VC")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMinLength(2)
          .setMaxLength(30),
      ),
    );
}

export function buildVcRenameModal(channelId: string, genre: string, beforeName: string): ModalBuilder {
  const prefix = `[${genre}]:`;
  return new ModalBuilder()
    .setCustomId(buildVcRenameModalCustomId(channelId, genre))
    .setTitle("VC名変更")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("vc_name_before_display")
          .setLabel("変更前VC名（確認用）")
          .setStyle(TextInputStyle.Short)
          .setValue(beforeName.slice(0, 30))
          .setRequired(false)
          .setMaxLength(30),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("vc_name_after_input")
          .setLabel("変更後VC名")
          .setStyle(TextInputStyle.Short)
          .setValue(prefix)
          .setPlaceholder(`${prefix}雑談VC`)
          .setRequired(true)
          .setMinLength(Math.min(prefix.length, 30))
          .setMaxLength(30),
      ),
    );
}

export function vcPanelMessageHasOpenButton(message: Message<boolean>): boolean {
  return messageComponentsHaveCustomId(message.components, new Set(["open_vc_modal"]));
}

export async function reconcileVcCreatorPanel(ctx: BotContext, guild: Guild, channelId: string): Promise<boolean> {
  const kind = PANEL_KIND_VC_CREATOR;
  const codeVer = getPermanentUiVersion(kind);
  let row = await ensurePanelMessageRow(ctx, guild.id, kind, channelId);

  if (row.channel_id !== channelId) {
    if (row.message_id) {
      await tryDeleteBotPanelMessage(ctx, guild, row.channel_id, row.message_id);
    }
    await savePanelMessageRow(ctx, row.id, channelId, "", { ...row.data, status: "pending" });
    row = { ...row, channel_id: channelId, message_id: "", data: { ...row.data, status: "pending" } };
  }

  const ch = await guild.channels.fetch(channelId).catch(() => null);
  if (!ch?.isTextBased()) {
    ctx.log.warn({ channelId, guildId: guild.id, panelKind: kind }, "USER panel channel missing or not text (VC creator panel)");
    await savePanelMessageRow(ctx, row.id, channelId, row.message_id, {
      ...row.data,
      status: "error",
      last_error: "channel_missing",
    });
    return false;
  }

  const payload = buildVcCreatorMainPayload();
  const editPayload = { ...payload, content: null } satisfies MessageEditOptions;
  const botId = ctx.client.user?.id ?? "";

  if (row.message_id) {
    const msg = await ch.messages.fetch(row.message_id).catch(() => null);
    if (msg && msg.author?.id === botId && vcPanelMessageHasOpenButton(msg)) {
      if (row.data.ui_version === codeVer) {
        return true;
      }
      try {
        await msg.edit(editPayload);
        await savePanelMessageRow(ctx, row.id, channelId, msg.id, {
          ui_version: codeVer,
          status: "sent",
          last_sent_at: new Date().toISOString(),
        });
      } catch (e) {
        ctx.log.error({ err: e, guildId: guild.id, panelKind: kind }, "VC creator panel edit failed");
        return false;
      }
      return true;
    }
  }

  const recent = await ch.messages.fetch({ limit: 50 }).catch(() => null);
  if (recent && botId) {
    const existing = recent.find((m) => m.author?.id === botId && vcPanelMessageHasOpenButton(m));
    if (existing) {
      try {
        if (row.data.ui_version !== codeVer) {
          await existing.edit(editPayload);
        }
        await savePanelMessageRow(ctx, row.id, channelId, existing.id, {
          ui_version: codeVer,
          status: "sent",
          last_sent_at: new Date().toISOString(),
        });
      } catch (e) {
        ctx.log.error({ err: e, guildId: guild.id, panelKind: kind }, "VC creator panel reconnect edit failed");
        return false;
      }
      ctx.log.debug({ messageId: existing.id }, "VC creator UI reconnected via scan");
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
    ctx.log.debug({ messageId: sent.id }, "VC creator UI sent");
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    await savePanelMessageRow(ctx, row.id, channelId, row.message_id, {
      ...row.data,
      status: "error",
      last_error: err.slice(0, 500),
    });
    ctx.log.error({ err: e, guildId: guild.id, panelKind: kind }, "VC creator UI send failed");
    return false;
  }
  return true;
}
