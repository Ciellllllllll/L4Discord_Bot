import { randomUUID } from "node:crypto";
import type { Guild } from "discord.js";
import type { CoreDeps } from "../../core/deps.js";
import { nowIso } from "../../core/db/nowIso.js";
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
} from "../panels/constants.js";
import { tryDeleteBotPanelMessage } from "../panels/panelDiscordOps.js";
import { deletePanelMessageRow } from "../panels/panelMessageStore.js";
import { reconcileStaticPanelMessage } from "../panels/panelReconcileStatic.js";
import { reconcileAiHistoryAdminPanel } from "../ai/aiHistoryAdminPanel.js";
import {
  buildReminderHubPanelPayload,
  reminderHubPanelMessageMatches,
} from "../reminders/reminderHubPayload.js";
import { reconcileAutoModPanel } from "../moderation/autoModerationPanel.js";
import { reconcileVcCreatorPanel } from "../vc/vcCreatorPanel.js";
import { buildUserContactPanelPayload, userContactPanelMessageMatches } from "../panels/userPanelsPayload.js";
import { serializePanelState, type PanelMessageState } from "../panels/panelState.js";

// PanelHub が使う依存。
type PanelHubDeps = Pick<CoreDeps, "config" | "db" | "log" | "client" | "aiHistoryDb" | "automodDb">;

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
  vc?: string;
  modmail?: string;
} {
  const pc = settings.panel_channels;
  const a = pc?.admin_channel_id?.trim();
  const legacyUser = pc?.user_channel_id?.trim();
  const vcRaw = pc?.vc_channel_id?.trim() ?? legacyUser;
  const mmRaw = pc?.modmail_channel_id?.trim() ?? legacyUser;
  return {
    admin: a && /^\d+$/.test(a) ? a : undefined,
    vc: vcRaw && /^\d+$/.test(vcRaw) ? vcRaw : undefined,
    modmail: mmRaw && /^\d+$/.test(mmRaw) ? mmRaw : undefined,
  };
}

// guild_settings の panel_channels から、pending 行に書き込む [kind, channelId] 一覧

function buildPendingChannelPairs(settings: Awaited<ReturnType<typeof getGuildSettingsData>>): [string, string][] {
  const { admin, vc, modmail } = panelChannelIds(settings);
  const out: [string, string][] = [];
  if (admin) {
    out.push(
      [PANEL_KIND_REACTION_ROLE_ADMIN, admin],
      [PANEL_KIND_MESSAGE_LOG_PANEL, admin],
      [PANEL_KIND_AI_QUERY_HISTORY, admin],
      [PANEL_KIND_REMINDER_HUB, admin],
      [PANEL_KIND_AUTOMOD, admin],
    );
  }
  if (vc) {
    out.push([PANEL_KIND_VC_CREATOR, vc]);
  }
  if (modmail) {
    out.push([PANEL_KIND_USER_CONTACT_PANEL, modmail]);
  }
  return out;
}

async function buildExpectedPanelsAsync(ctx: PanelHubDeps, guildId: string): Promise<ExpectedPanel[]> {
  const out: ExpectedPanel[] = [];
  const settings = await getGuildSettingsData(ctx.db, guildId);
  const { admin, vc, modmail } = panelChannelIds(settings);
  if (admin) {
    out.push({ kind: PANEL_KIND_REACTION_ROLE_ADMIN, channelId: admin });
    out.push({ kind: PANEL_KIND_MESSAGE_LOG_PANEL, channelId: admin });
    out.push({ kind: PANEL_KIND_AI_QUERY_HISTORY, channelId: admin });
    out.push({ kind: PANEL_KIND_REMINDER_HUB, channelId: admin });
    out.push({ kind: PANEL_KIND_AUTOMOD, channelId: admin });
  }
  if (vc) {
    out.push({ kind: PANEL_KIND_VC_CREATOR, channelId: vc });
  }
  if (modmail) {
    out.push({ kind: PANEL_KIND_USER_CONTACT_PANEL, channelId: modmail });
  }
  return out;
}

async function cleanupLegacyHubRows(ctx: PanelHubDeps, guild: Guild): Promise<void> {
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

export async function reconcilePanelsForGuild(ctx: PanelHubDeps, guildId: string): Promise<void> {
  const guild = await ctx.client.guilds.fetch(guildId).catch(() => null);
  if (!guild) throw new Error(`target guild unavailable for panel reconciliation: ${guildId}`);

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

  const failedPanels: string[] = [];
  const reconcilePanel = async (kind: string, operation: () => Promise<boolean>): Promise<void> => {
    try {
      if (!await operation()) failedPanels.push(kind);
    } catch (err) {
      failedPanels.push(kind);
      ctx.log.error({ err, guildId, panelKind: kind }, "panel reconciliation failed");
    }
  };

  for (const exp of expected) {
    if (exp.kind === PANEL_KIND_VC_CREATOR) {
      await reconcilePanel(exp.kind, () => reconcileVcCreatorPanel(ctx, guild, exp.channelId));
    } else if (exp.kind === PANEL_KIND_REACTION_ROLE_ADMIN) {
      await reconcilePanel(exp.kind, () => reconcileReactionRoleAdminPanel(ctx, guild, exp.channelId));
    } else if (exp.kind === PANEL_KIND_MESSAGE_LOG_PANEL) {
      await reconcilePanel(exp.kind, () => reconcileStaticPanelMessage(
        ctx,
        guild,
        exp.channelId,
        exp.kind,
        messageLogPanelMessageMatches,
        buildMessageLogPanelPayload,
        "message_log_panel",
      ));
    } else if (exp.kind === PANEL_KIND_AI_QUERY_HISTORY) {
      await reconcilePanel(exp.kind, () => reconcileAiHistoryAdminPanel(ctx, guild, exp.channelId));
    } else if (exp.kind === PANEL_KIND_REMINDER_HUB) {
      await reconcilePanel(exp.kind, () => reconcileStaticPanelMessage(
        ctx,
        guild,
        exp.channelId,
        exp.kind,
        reminderHubPanelMessageMatches,
        buildReminderHubPanelPayload,
        "reminder_hub",
      ));
    } else if (exp.kind === PANEL_KIND_AUTOMOD) {
      await reconcilePanel(exp.kind, () => reconcileAutoModPanel(ctx, guild, exp.channelId));
    } else if (exp.kind === PANEL_KIND_USER_CONTACT_PANEL) {
      await reconcilePanel(exp.kind, () => reconcileStaticPanelMessage(
        ctx,
        guild,
        exp.channelId,
        exp.kind,
        userContactPanelMessageMatches,
        buildUserContactPanelPayload,
        "user_contact_panel",
      ));
    }
  }

  failedPanels.push(...await reconcileReactionRoleEntriesOnly(ctx, guild));
  if (failedPanels.length > 0) {
    const err = Object.assign(new Error("one or more panels failed to reconcile"), { failedComponents: failedPanels });
    throw err;
  }
}

// 現在の guild_settings を読み、Discord 上の常設パネル投稿を削除して DB を pending に戻したうえで reconcile。
// !Setup 保存直後および !Reload で利用。

export async function resetPanelMessagesAndReconcile(ctx: PanelHubDeps, guildId: string): Promise<void> {
  const guild = await ctx.client.guilds.fetch(guildId).catch(() => null);
  const settings = await getGuildSettingsData(ctx.db, guildId);
  const pairMap = new Map(buildPendingChannelPairs(settings));

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

  for (const kind of [...MANAGED_PANEL_KINDS]) {
    const ch = pairMap.get(kind);
    const existing = await ctx.db
      .selectFrom("panel_messages")
      .selectAll()
      .where("guild_id", "=", guildId)
      .where("panel_kind", "=", kind)
      .executeTakeFirst();
    if (ch) {
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
            created_at: nowIso() as unknown as Date,
          })
          .execute();
      }
    } else if (existing) {
      await deletePanelMessageRow(ctx, existing.id);
    }
  }

  await reconcilePanelsForGuild(ctx, guildId);
}

// !Setup 完了時: ADMIN / VC / Modmail チャンネルを保存し、常設 UI を同期

export async function savePanelChannelsAndReconcile(
  ctx: PanelHubDeps,
  guildId: string,
  adminChannelId: string,
  vcChannelId: string,
  modmailChannelId: string,
): Promise<void> {
  const cur = await getGuildSettingsData(ctx.db, guildId);
  const { ui_destinations: _legacyUi, ...rest } = cur as typeof cur & { ui_destinations?: unknown };
  void _legacyUi;
  await upsertGuildSettingsData(ctx.db, guildId, {
    ...rest,
    panel_channels: {
      admin_channel_id: adminChannelId,
      vc_channel_id: vcChannelId,
      modmail_channel_id: modmailChannelId,
    },
  });

  await resetPanelMessagesAndReconcile(ctx, guildId);
}

// !Reload: チャンネル ID は変えずに UI を再送・再接続（pending 化して reconcile）

export async function reloadPanelsFromGuildSettings(ctx: PanelHubDeps, guildId: string): Promise<{
  ok: boolean;
  reason?: "no_channels";
}> {
  const settings = await getGuildSettingsData(ctx.db, guildId);
  const { admin, vc, modmail } = panelChannelIds(settings);
  if (!admin && !vc && !modmail) {
    return { ok: false, reason: "no_channels" };
  }
  await resetPanelMessagesAndReconcile(ctx, guildId);
  return { ok: true };
}
