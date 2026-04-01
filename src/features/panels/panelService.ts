import { randomUUID } from "node:crypto";
import type { Guild } from "discord.js";
import type { BotContext } from "../../bot/context.js";
import { sqliteTimestamp } from "../../core/db/sqliteTimestamp.js";
import { getGuildSettingsData, upsertGuildSettingsData } from "../../core/guildSettings.js";
import { reconcileReactionRoleEntriesOnly, reconcileReactionRoleAdminPanel } from "../reactionRoles/reactionRoleService.js";
import { buildMessageLogPanelPayload, messageLogPanelMessageMatches } from "./adminPanelsPayload.js";
import {
  LEGACY_PANEL_KIND_ADMIN_HUB,
  LEGACY_PANEL_KIND_USER_HUB,
  PANEL_KIND_AI_QUERY_HISTORY,
  PANEL_KIND_AUTOMOD,
  PANEL_KIND_MESSAGE_LOG_PANEL,
  PANEL_KIND_REACTION_ROLE_ADMIN,
  PANEL_KIND_REMINDER_HUB,
  PANEL_KIND_USER_CONTACT_PANEL,
  PANEL_KIND_VC_CREATOR,
} from "./constants.js";
import { tryDeleteBotPanelMessage } from "./panelDiscordOps.js";
import { deletePanelMessageRow } from "./panelMessageStore.js";
import { reconcileStaticPanelMessage } from "./panelReconcileStatic.js";
import { reconcileAiHistoryAdminPanel } from "../ai/aiHistoryAdminPanel.js";
import {
  buildReminderHubPanelPayload,
  reminderHubPanelMessageMatches,
} from "../reminders/reminderHubPayload.js";
import { reconcileAutoModPanel } from "../moderation/autoModerationPanel.js";
import { reconcileVcCreatorPanel } from "../vc/vcTemporaryChannelManager.js";
import { buildUserContactPanelPayload, userContactPanelMessageMatches } from "./userPanelsPayload.js";
import { serializePanelState, type PanelMessageState } from "./panelState.js";

const MANAGED_PANEL_KINDS = [
  PANEL_KIND_VC_CREATOR,
  PANEL_KIND_REACTION_ROLE_ADMIN,
  PANEL_KIND_MESSAGE_LOG_PANEL,
  PANEL_KIND_AI_QUERY_HISTORY,
  PANEL_KIND_REMINDER_HUB,
  PANEL_KIND_AUTOMOD,
  PANEL_KIND_USER_CONTACT_PANEL,
] as const;
const LEGACY_HUB_KINDS = [LEGACY_PANEL_KIND_ADMIN_HUB, LEGACY_PANEL_KIND_USER_HUB] as const;

type ExpectedPanel = { kind: string; channelId: string };

function panelChannelIds(settings: Awaited<ReturnType<typeof getGuildSettingsData>>): {
  admin?: string;
  user?: string;
} {
  const a = settings.panel_channels?.admin_channel_id?.trim();
  const u = settings.panel_channels?.user_channel_id?.trim();
  return {
    admin: a && /^\d+$/.test(a) ? a : undefined,
    user: u && /^\d+$/.test(u) ? u : undefined,
  };
}

async function buildExpectedPanelsAsync(ctx: BotContext, guildId: string): Promise<ExpectedPanel[]> {
  const out: ExpectedPanel[] = [];
  const settings = await getGuildSettingsData(ctx.db, guildId);
  const { admin, user } = panelChannelIds(settings);
  if (admin) {
    out.push({ kind: PANEL_KIND_REACTION_ROLE_ADMIN, channelId: admin });
    out.push({ kind: PANEL_KIND_MESSAGE_LOG_PANEL, channelId: admin });
    out.push({ kind: PANEL_KIND_AI_QUERY_HISTORY, channelId: admin });
    out.push({ kind: PANEL_KIND_REMINDER_HUB, channelId: admin });
    out.push({ kind: PANEL_KIND_AUTOMOD, channelId: admin });
  }
  if (user) {
    out.push({ kind: PANEL_KIND_VC_CREATOR, channelId: user });
    out.push({ kind: PANEL_KIND_USER_CONTACT_PANEL, channelId: user });
  }
  return out;
}

async function cleanupLegacyHubRows(ctx: BotContext, guild: Guild): Promise<void> {
  const legacy = await ctx.db
    .selectFrom("panel_messages")
    .selectAll()
    .where("guild_id", "=", guild.id)
    .where("panel_kind", "in", [...LEGACY_HUB_KINDS])
    .execute();
  for (const row of legacy) {
    if (row.message_id) {
      await tryDeleteBotPanelMessage(ctx, guild, row.channel_id, row.message_id);
    }
    await deletePanelMessageRow(ctx, row.id);
  }
}

export async function reconcilePanelsForGuild(ctx: BotContext, guildId: string): Promise<void> {
  const guild = await ctx.client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return;

  await cleanupLegacyHubRows(ctx, guild);

  const expected = await buildExpectedPanelsAsync(ctx, guildId);
  const expectedKinds = new Set(expected.map((e) => e.kind));

  const tracked = await ctx.db
    .selectFrom("panel_messages")
    .selectAll()
    .where("guild_id", "=", guildId)
    .where("panel_kind", "in", [...MANAGED_PANEL_KINDS])
    .execute();

  for (const row of tracked) {
    if (expectedKinds.has(row.panel_kind)) continue;
    if (row.message_id) {
      await tryDeleteBotPanelMessage(ctx, guild, row.channel_id, row.message_id);
    }
    await deletePanelMessageRow(ctx, row.id);
  }

  for (const exp of expected) {
    if (exp.kind === PANEL_KIND_VC_CREATOR) {
      await reconcileVcCreatorPanel(ctx, guild, exp.channelId);
    } else if (exp.kind === PANEL_KIND_REACTION_ROLE_ADMIN) {
      await reconcileReactionRoleAdminPanel(ctx, guild, exp.channelId);
    } else if (exp.kind === PANEL_KIND_MESSAGE_LOG_PANEL) {
      await reconcileStaticPanelMessage(
        ctx,
        guild,
        exp.channelId,
        exp.kind,
        messageLogPanelMessageMatches,
        buildMessageLogPanelPayload,
        "message_log_panel",
      );
    } else if (exp.kind === PANEL_KIND_AI_QUERY_HISTORY) {
      await reconcileAiHistoryAdminPanel(ctx, guild, exp.channelId);
    } else if (exp.kind === PANEL_KIND_REMINDER_HUB) {
      await reconcileStaticPanelMessage(
        ctx,
        guild,
        exp.channelId,
        exp.kind,
        reminderHubPanelMessageMatches,
        buildReminderHubPanelPayload,
        "reminder_hub",
      );
    } else if (exp.kind === PANEL_KIND_AUTOMOD) {
      await reconcileAutoModPanel(ctx, guild, exp.channelId);
    } else if (exp.kind === PANEL_KIND_USER_CONTACT_PANEL) {
      await reconcileStaticPanelMessage(
        ctx,
        guild,
        exp.channelId,
        exp.kind,
        userContactPanelMessageMatches,
        buildUserContactPanelPayload,
        "user_contact_panel",
      );
    }
  }

  await reconcileReactionRoleEntriesOnly(ctx, guild);
}

/** !Setup 完了時: ADMIN/USER チャンネルを保存し、常設 UI を同期 */
export async function savePanelChannelsAndReconcile(
  ctx: BotContext,
  guildId: string,
  adminChannelId: string,
  userChannelId: string,
): Promise<void> {
  const cur = await getGuildSettingsData(ctx.db, guildId);
  const { ui_destinations: _legacyUi, ...rest } = cur as typeof cur & { ui_destinations?: unknown };
  void _legacyUi;
  await upsertGuildSettingsData(ctx.db, guildId, {
    ...rest,
    panel_channels: { admin_channel_id: adminChannelId, user_channel_id: userChannelId },
  });

  const guild = await ctx.client.guilds.fetch(guildId).catch(() => null);
  if (guild) {
    for (const kind of [...MANAGED_PANEL_KINDS]) {
      const existing = await ctx.db
        .selectFrom("panel_messages")
        .selectAll()
        .where("guild_id", "=", guildId)
        .where("panel_kind", "=", kind)
        .executeTakeFirst();
      if (existing?.message_id) {
        await tryDeleteBotPanelMessage(ctx, guild, existing.channel_id, existing.message_id);
      }
    }
  }

  const pending: PanelMessageState = { ui_version: "0.0.0", status: "pending" };
  const pendingJson = JSON.stringify(serializePanelState(pending)) as unknown as Record<string, unknown>;
  for (const [kind, ch] of [
    [PANEL_KIND_REACTION_ROLE_ADMIN, adminChannelId],
    [PANEL_KIND_MESSAGE_LOG_PANEL, adminChannelId],
    [PANEL_KIND_AI_QUERY_HISTORY, adminChannelId],
    [PANEL_KIND_REMINDER_HUB, adminChannelId],
    [PANEL_KIND_AUTOMOD, adminChannelId],
    [PANEL_KIND_VC_CREATOR, userChannelId],
    [PANEL_KIND_USER_CONTACT_PANEL, userChannelId],
  ] as const) {
    const existing = await ctx.db
      .selectFrom("panel_messages")
      .selectAll()
      .where("guild_id", "=", guildId)
      .where("panel_kind", "=", kind)
      .executeTakeFirst();
    if (existing) {
      await ctx.db
        .updateTable("panel_messages")
        .set({
          channel_id: ch,
          message_id: "",
          data: pendingJson,
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
          data: pendingJson,
          created_at: sqliteTimestamp() as unknown as Date,
        })
        .execute();
    }
  }

  await reconcilePanelsForGuild(ctx, guildId);
}
