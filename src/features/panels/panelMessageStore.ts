import { randomUUID } from "node:crypto";
import type { BotContext } from "../../bot/context.js";
import { nowIso } from "../../core/db/nowIso.js";
import { parsePanelState, serializePanelState, type PanelMessageState } from "./panelState.js";

export type PanelMessageRow = {
  id: string;
  message_id: string;
  channel_id: string;
  data: PanelMessageState;
};

export async function ensurePanelMessageRow(
  ctx: BotContext,
  guildId: string,
  kind: string,
  channelId: string,
): Promise<PanelMessageRow> {
  const existing = await ctx.db
    .selectFrom("panel_messages")
    .selectAll()
    .where("guild_id", "=", guildId)
    .where("panel_kind", "=", kind)
    .executeTakeFirst();
  const pending: PanelMessageState = { ui_version: "0.0.0", status: "pending" };
  if (existing) {
    return {
      id: existing.id,
      message_id: existing.message_id,
      channel_id: existing.channel_id,
      data: parsePanelState(existing.data),
    };
  }
  const id = randomUUID();
  await ctx.db
    .insertInto("panel_messages")
    .values({
      id,
      guild_id: guildId,
      panel_kind: kind,
      channel_id: channelId,
      message_id: "",
      data: JSON.stringify(serializePanelState(pending)) as unknown as Record<string, unknown>,
      created_at: nowIso() as unknown as Date,
    })
    .execute();
  return { id, message_id: "", channel_id: channelId, data: pending };
}

export async function savePanelMessageRow(
  ctx: BotContext,
  rowId: string,
  channelId: string,
  messageId: string,
  data: PanelMessageState,
): Promise<void> {
  await ctx.db
    .updateTable("panel_messages")
    .set({
      channel_id: channelId,
      message_id: messageId,
      data: JSON.stringify(serializePanelState(data)) as unknown as Record<string, unknown>,
    })
    .where("id", "=", rowId)
    .execute();
}

export async function deletePanelMessageRow(ctx: BotContext, rowId: string): Promise<void> {
  await ctx.db.deleteFrom("panel_messages").where("id", "=", rowId).execute();
}
