import type { Message } from "discord.js";
import type { BotContext } from "../../bot/context.js";
import {
  allPendingReplies,
  setReplyConfirmMessageId,
  type ModmailReplyRow,
} from "./modmailRepliesDb.js";
import { confirmReplyTextResolved } from "./modmailStaffFlow.js";
import {
  buildModmailCloseRow,
  buildModmailConfirmRow,
} from "./modmailUi.js";
import {
  buildModmailThreadSummaryEmbed,
  parseModmailRowData,
  type ModmailThreadRow,
} from "./modmailService.js";

function asThreadRow(r: Record<string, unknown>): ModmailThreadRow {
  return r as unknown as ModmailThreadRow;
}

function messageHasButtonCustomId(msg: Message, predicate: (customId: string) => boolean): boolean {
  for (const row of msg.components) {
    if (!("components" in row) || !Array.isArray(row.components)) continue;
    for (const c of row.components) {
      if (c && typeof c === "object" && "customId" in c) {
        const id = (c as { customId?: string }).customId;
        if (typeof id === "string" && predicate(id)) return true;
      }
    }
  }
  return false;
}

// 起動時: 未処理の承認パネル・要約パネルを再同期（DiscordBOTv2 registerPersistentUI 相当）

export async function restoreModmailUiState(ctx: BotContext): Promise<void> {
  const pending = await allPendingReplies(ctx);
  for (const row of pending) {
    const guild = await ctx.client.guilds.fetch(row.guild_id).catch(() => null);
    if (!guild) continue;
    const thread = await guild.channels.fetch(row.thread_id).catch(() => null);
    if (!thread?.isTextBased()) continue;
    const reply = row as ModmailReplyRow;
    const approveId = `mm_yes:${reply.id}`;
    const rejectId = `mm_no:${reply.id}`;
    const attachPrefix = `mm_ratt:${reply.id}.`;
    let msg = null;
    if (reply.confirm_message_id) {
      msg = await thread.messages.fetch(reply.confirm_message_id).catch(() => null);
    }
    if (!msg) {
      const confirmBody = await confirmReplyTextResolved(ctx, reply);
      const sent = await thread
        .send({
          content: confirmBody,
          components: [buildModmailConfirmRow(reply.id, reply.author_staff_id)],
          allowedMentions: { parse: [] },
        })
        .catch(() => null);
      if (sent) await setReplyConfirmMessageId(ctx, reply.id, sent.id);
      continue;
    }
    const needsFix =
      !messageHasButtonCustomId(msg, (id) => id === approveId) ||
      !messageHasButtonCustomId(msg, (id) => id === rejectId) ||
      !messageHasButtonCustomId(msg, (id) => id.startsWith(attachPrefix));
    if (needsFix) {
      const confirmBody = await confirmReplyTextResolved(ctx, reply);
      await msg
        .edit({
          content: confirmBody,
          components: [buildModmailConfirmRow(reply.id, reply.author_staff_id)],
        })
        .catch(() => undefined);
    }
  }

  const openTickets = await ctx.ticketDb
    .selectFrom("modmail_threads")
    .selectAll()
    .where("status", "=", "open")
    .execute();

  for (const raw of openTickets) {
    const t = asThreadRow(raw as Record<string, unknown>);
    if (!t.thread_id) continue;
    const guild = await ctx.client.guilds.fetch(t.guild_id).catch(() => null);
    if (!guild) continue;
    const thread = await guild.channels.fetch(t.thread_id).catch(() => null);
    if (!thread?.isTextBased()) continue;
    const data = parseModmailRowData(t.data);
    const embed = buildModmailThreadSummaryEmbed(t, data);
    const payload = {
      embeds: [embed],
      components: [buildModmailCloseRow(t.id)],
      allowedMentions: { parse: [] as const },
    };
    const panelId = typeof data.panel_message_id === "string" ? data.panel_message_id : null;
    let panel = panelId ? await thread.messages.fetch(panelId).catch(() => null) : null;
    if (!panel) {
      const sent = await thread.send(payload).catch(() => null);
      if (sent) {
        const merged = { ...data, panel_message_id: sent.id, info_message_id: sent.id };
        await ctx.ticketDb
          .updateTable("modmail_threads")
          .set({
            data: JSON.stringify(merged) as unknown as Record<string, unknown>,
          })
          .where("id", "=", t.id)
          .execute();
      }
      continue;
    }
    await panel.edit(payload).catch(() => undefined);
  }
}
