import { randomUUID } from "node:crypto";
import type { Guild, MessageCreateOptions, MessageEditOptions } from "discord.js";
import type { BotContext } from "../../bot/context.js";
import { sqliteTimestamp } from "../../core/db/sqliteTimestamp.js";
import { getGuildSettingsData, upsertGuildSettingsData } from "../../core/guildSettings.js";
import { isVersionAllowed } from "../../core/semverGate.js";
import { PANEL_KIND_ADMIN, PANEL_KIND_USER } from "./constants.js";
import { buildAdminHubPayload, buildUserHubPayload } from "./hubUi.js";
import { parsePanelState, serializePanelState, type PanelMessageState } from "./panelState.js";

async function getOrCreatePanelRow(
  ctx: BotContext,
  guildId: string,
  kind: string,
  channelId: string,
  initial: PanelMessageState,
): Promise<{ id: string; message_id: string; data: PanelMessageState }> {
  const existing = await ctx.db
    .selectFrom("panel_messages")
    .selectAll()
    .where("guild_id", "=", guildId)
    .where("panel_kind", "=", kind)
    .executeTakeFirst();
  if (existing) {
    return {
      id: existing.id,
      message_id: existing.message_id,
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
      data: JSON.stringify(serializePanelState(initial)) as unknown as Record<string, unknown>,
      created_at: sqliteTimestamp() as unknown as Date,
    })
    .execute();
  return { id, message_id: "", data: initial };
}

async function savePanelRow(
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

async function sendOrUpdateHub(
  ctx: BotContext,
  guild: Guild,
  channelId: string | undefined,
  kind: string,
  payload: MessageCreateOptions,
): Promise<void> {
  if (!channelId) return;
  const panelVer = ctx.config.BOT_VERSION;
  const pending: PanelMessageState = { panel_version: panelVer, status: "pending" };
  const row = await getOrCreatePanelRow(ctx, guild.id, kind, channelId, pending);
  if (!isVersionAllowed(ctx.config.BOT_VERSION, row.data.panel_version)) {
    await savePanelRow(ctx, row.id, channelId, row.message_id, {
      ...row.data,
      status: "pending",
    });
    return;
  }
  const ch = await guild.channels.fetch(channelId).catch(() => null);
  if (!ch?.isTextBased()) {
    await savePanelRow(ctx, row.id, channelId, row.message_id, {
      ...row.data,
      status: "error",
      last_error: "channel_missing",
    });
    return;
  }
  try {
    let messageId = row.message_id;
    const editOpt = payload as MessageEditOptions;
    if (messageId) {
      const msg = await ch.messages.fetch(messageId).catch(() => null);
      if (msg) {
        await msg.edit(editOpt);
      } else {
        const m = await ch.send(payload);
        messageId = m.id;
      }
    } else {
      const m = await ch.send(payload);
      messageId = m.id;
    }
    await savePanelRow(ctx, row.id, channelId, messageId, {
      panel_version: panelVer,
      status: "sent",
      last_sent_at: new Date().toISOString(),
    });
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    await savePanelRow(ctx, row.id, channelId, row.message_id, {
      ...row.data,
      status: "error",
      last_error: err.slice(0, 500),
    });
    ctx.log.error({ err: e, kind }, "panel send failed");
  }
}

export async function reconcilePanelsForGuild(ctx: BotContext, guildId: string): Promise<void> {
  const guild = await ctx.client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return;
  const s = await getGuildSettingsData(ctx.db, guildId);
  const adminCh = s.panel_channels?.admin_channel_id;
  const userCh = s.panel_channels?.user_channel_id;
  await sendOrUpdateHub(ctx, guild, adminCh, PANEL_KIND_ADMIN, buildAdminHubPayload());
  await sendOrUpdateHub(ctx, guild, userCh, PANEL_KIND_USER, buildUserHubPayload());
}

export async function savePanelChannelTargets(
  ctx: BotContext,
  guildId: string,
  adminChannelId: string,
  userChannelId: string,
): Promise<void> {
  const cur = await getGuildSettingsData(ctx.db, guildId);
  await upsertGuildSettingsData(ctx.db, guildId, {
    ...cur,
    panel_channels: { admin_channel_id: adminChannelId, user_channel_id: userChannelId },
  });
  const panelVer = ctx.config.BOT_VERSION;
  for (const kind of [PANEL_KIND_ADMIN, PANEL_KIND_USER]) {
    const ch = kind === PANEL_KIND_ADMIN ? adminChannelId : userChannelId;
    const existing = await ctx.db
      .selectFrom("panel_messages")
      .selectAll()
      .where("guild_id", "=", guildId)
      .where("panel_kind", "=", kind)
      .executeTakeFirst();
    const st: PanelMessageState = { panel_version: panelVer, status: "pending" };
    if (existing) {
      await ctx.db
        .updateTable("panel_messages")
        .set({
          channel_id: ch,
          message_id: "",
          data: JSON.stringify(serializePanelState(st)) as unknown as Record<string, unknown>,
        })
        .where("id", "=", existing.id)
        .execute();
    } else {
      await ctx.db
        .insertInto("panel_messages")
        .values({
          id: randomUUID(),
          guild_id: guildId,
          panel_kind: kind,
          channel_id: ch,
          message_id: "",
          data: JSON.stringify(serializePanelState(st)) as unknown as Record<string, unknown>,
          created_at: sqliteTimestamp() as unknown as Date,
        })
        .execute();
    }
  }
  await reconcilePanelsForGuild(ctx, guildId);
}
