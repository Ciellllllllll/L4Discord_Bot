import type { Guild } from "discord.js";
import { getPermanentUiVersion } from "../../core/releaseVersions.js";
import { PANEL_KIND_REACTION_ROLE_ADMIN } from "../panels/constants.js";
import { tryDeleteBotPanelMessage } from "../panels/panelDiscordOps.js";
import { ensurePanelMessageRow, savePanelMessageRow } from "../panels/panelMessageStore.js";
import { loadEntriesForGuild, setEntryMessageId } from "./reactionRoleRepository.js";
import {
  buildReactionRoleAdminPanelPayload,
  messageHasCustomId,
  sendOrUpdateEntryMessage,
  type ReactionRoleServiceDeps,
} from "./reactionRoleMessages.js";
import { ADMIN_CREATE_BUTTON_ID } from "./reactionRoleConstants.js";

// リアクションロールの Discord 状態の再同期。

export async function reconcileReactionRoleAdminPanel(
  ctx: ReactionRoleServiceDeps,
  guild: Guild,
  channelId: string,
): Promise<boolean> {
  const kind = PANEL_KIND_REACTION_ROLE_ADMIN;
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
    ctx.log.warn({ channelId, guildId: guild.id, panelKind: kind }, "reaction role admin channel missing or not text");
    await savePanelMessageRow(ctx, row.id, channelId, row.message_id, {
      ...row.data,
      status: "error",
      last_error: "channel_missing",
    });
    return false;
  }

  const payload = buildReactionRoleAdminPanelPayload(`<#${channelId}>`);
  const editPayload = { ...payload, content: null };
  const botId = ctx.client.user?.id ?? "";

  if (row.message_id) {
    const msg = await ch.messages.fetch(row.message_id).catch(() => null);
    if (msg && msg.author?.id === botId && messageHasCustomId(msg, ADMIN_CREATE_BUTTON_ID)) {
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
        ctx.log.error({ err: e, guildId: guild.id, panelKind: kind }, "reaction role admin panel edit failed");
        return false;
      }
      return true;
    }
  }

  const recent = await ch.messages.fetch({ limit: 50 }).catch(() => null);
  if (recent && botId) {
    const existing = recent.find(
      (m) => m.author?.id === botId && messageHasCustomId(m, ADMIN_CREATE_BUTTON_ID),
    );
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
        ctx.log.error({ err: e, guildId: guild.id, panelKind: kind }, "reaction role admin panel reconnect edit failed");
        return false;
      }
      ctx.log.debug({ messageId: existing.id }, "reaction role admin UI reconnected via scan");
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
    ctx.log.debug({ messageId: sent.id }, "reaction role admin UI sent");
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    await savePanelMessageRow(ctx, row.id, channelId, row.message_id, {
      ...row.data,
      status: "error",
      last_error: err.slice(0, 500),
    });
    ctx.log.error({ err: e, guildId: guild.id, panelKind: kind }, "reaction role admin UI send failed");
    return false;
  }
  return true;
}

let entriesReconcileRunning = false;

export async function reconcileReactionRoleEntriesOnly(ctx: ReactionRoleServiceDeps, guild: Guild): Promise<string[]> {
  if (entriesReconcileRunning) return [];
  const failedEntries: string[] = [];
  entriesReconcileRunning = true;
  try {
    const entries = await loadEntriesForGuild(ctx.db, guild.id);
    for (const e of entries) {
      if (e.roles.length === 0) continue;
      try {
        const messageId = await sendOrUpdateEntryMessage(ctx, guild, e);
        if (messageId !== e.messageId) {
          await setEntryMessageId(ctx.db, guild.id, e.entryId, messageId, e.channelId);
        }
      } catch (err) {
        failedEntries.push(`reaction_role_entry:${e.entryId}`);
        ctx.log.warn({ err, entryId: e.entryId, guildId: guild.id, panelKind: PANEL_KIND_REACTION_ROLE_ADMIN }, "reaction role entry reconnect failed");
      }
    }
  } finally {
    entriesReconcileRunning = false;
  }
  return failedEntries;
}
