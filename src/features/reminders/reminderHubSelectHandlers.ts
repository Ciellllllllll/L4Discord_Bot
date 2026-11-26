import { componentCardsPayload,  } from "../../core/componentCard.js";
import {
  MessageFlags,
  
  
  type ChannelSelectMenuInteraction,
  
  
  type StringSelectMenuInteraction,
} from "discord.js";

import { withReminderDispatchLock } from "./reminderDispatchLock.js";
import {
  
  clearRecurringPermanentSkipWarned,
  clearReminderRetryState,
  getPendingDispatchUpdate,
  hasPendingDispatchUpdate,
  
  
} from "./reminderDispatchState.js";
import {
  
  
  
  
  
  getActiveForAuthor,
  
  listActiveByType,
  
  updateReminderHubChannel,
  
} from "./reminderHubRepo.js";
import { applyPendingDispatchUpdate } from "./reminderScheduler.js";
import {
  
  buildCreateModal,
  
  buildManageDetailPayload,
  buildManageListPayload,
  
} from "./reminderHubPayload.js";
import {
  
  
  
  
  normalizeEventType,
  
  
  
  
} from "./reminderHubTypes.js";

import {
  buildManageListForUser,
  checkSendableGuildChannel,
  formatChannelSendabilityError,
  handleDeferredPanelError,
  makeInfoEmbed,
  type ReminderHubChannelSelectDeps,
  type ReminderHubHandlerDeps,
} from "./reminderHubCommon.js";

export async function handleReminderHubStringSelect(
  interaction: StringSelectMenuInteraction,
  ctx: ReminderHubHandlerDeps,
): Promise<boolean> {
  if (!interaction.customId.startsWith("rem_manage_pick:")) return false;
  if (!interaction.guild) {
    await interaction.reply({
      ...componentCardsPayload([makeInfoEmbed("エラー", "サーバー内でのみ利用できます。")]),
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    });
    return true;
  }
  const kind = normalizeEventType(interaction.customId.split(":")[1] ?? "reminder");
  const rowId = interaction.values[0];
  if (!rowId) {
    const payload = await buildManageListForUser(
      ctx,
      interaction.guild.id,
      interaction.user.id,
      kind,
      "対象IDが不正です。",
    );
    await interaction.update(payload);
    return true;
  }
  const row = await getActiveForAuthor(ctx, interaction.guild.id, interaction.user.id, rowId);
  if (!row) {
    const payload = await buildManageListForUser(
      ctx,
      interaction.guild.id,
      interaction.user.id,
      kind,
      "対象が見つからないか、すでに無効です。",
    );
    await interaction.update(payload);
    return true;
  }
  await interaction.update(buildManageDetailPayload(row));
  return true;
}

export async function handleReminderHubChannelSelect(
  interaction: ChannelSelectMenuInteraction,
  ctx: ReminderHubHandlerDeps,
  deps: ReminderHubChannelSelectDeps = {},
): Promise<boolean> {
  const cid = interaction.customId;
  if (!cid.startsWith("rem_create_channel:") && !cid.startsWith("rem_manage_channel_pick:")) {
    return false;
  }

  if (cid.startsWith("rem_create_channel:")) {
    if (!interaction.guild) {
      await interaction.reply({
        ...componentCardsPayload([makeInfoEmbed("エラー", "サーバー内でのみ利用できます。")]),
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
      return true;
    }
    const kind = normalizeEventType(cid.slice("rem_create_channel:".length));
    const channelId = interaction.values[0];
    if (!channelId || !/^\d+$/.test(channelId)) {
      await interaction.reply({
        ...componentCardsPayload([makeInfoEmbed("エラー", "チャンネルIDが不正です。")]),
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
      return true;
    }
    await interaction.showModal(buildCreateModal(kind, channelId));
    return true;
  }

  if (cid.startsWith("rem_manage_channel_pick:")) {
    if (!interaction.guild) {
      await interaction.reply({
        ...componentCardsPayload([makeInfoEmbed("エラー", "サーバー内でのみ利用できます。")]),
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
      return true;
    }
    const rowId = cid.slice("rem_manage_channel_pick:".length);
    const channelId = interaction.values[0];
    if (!channelId || !/^\d+$/.test(channelId)) {
      await interaction.reply({
        ...componentCardsPayload([makeInfoEmbed("エラー", "入力が不正です。")]),
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
      return true;
    }
    const getActive = deps.getActiveForAuthor ?? getActiveForAuthor;
    const updateChannel = deps.updateReminderHubChannel ?? updateReminderHubChannel;
    const listActive = deps.listActiveByType ?? listActiveByType;
    const guildId = interaction.guild.id;
    const userId = interaction.user.id;
    const current = await getActive(ctx, guildId, userId, rowId);
    if (!current) {
      await interaction.reply({
        ...componentCardsPayload([makeInfoEmbed("エラー", "対象が見つからないか、すでに無効です。")]),
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
      return true;
    }
    await interaction.deferUpdate();
    try {
      const sendability = await checkSendableGuildChannel(interaction.guild, channelId, ctx.log);
      if (!sendability.ok) {
        await interaction.editReply(
          buildManageDetailPayload(current, formatChannelSendabilityError(sendability)),
        );
        return true;
      }
      type ChannelChangeOutcome =
        | { kind: "updated"; count: number }
        | { kind: "already_sent" }
        | { kind: "cancelled_undeliverable" }
        | { kind: "pending_apply_failed" };
      const outcome: ChannelChangeOutcome = await withReminderDispatchLock(rowId, async () => {
        if (hasPendingDispatchUpdate(rowId)) {
          const pending = getPendingDispatchUpdate(rowId);
          const pendingAction = pending?.action;
          if (pending) {
            try {
              await applyPendingDispatchUpdate(ctx, pending, {
                applyDispatchResult: deps.applyDispatchResult,
                cancelUndeliverableReminder: deps.cancelUndeliverableReminder,
                now: deps.now,
              });
            } catch (err) {
              ctx.log.error(
                { err, reminderId: rowId, action: pending.action },
                "failed to apply pending reminder DB update before channel change",
              );
              return { kind: "pending_apply_failed" };
            }
          }
          const latest = await getActive(ctx, guildId, userId, rowId);
          if (!latest || latest.status !== "pending") {
            return pendingAction === "cancel"
              ? { kind: "cancelled_undeliverable" }
              : { kind: "already_sent" };
          }
        }
        const count = await updateChannel(ctx, guildId, userId, rowId, channelId);
        if (count > 0) {
          clearReminderRetryState(rowId);
          clearRecurringPermanentSkipWarned(rowId);
        }
        return { kind: "updated", count };
      });
      if (outcome.kind === "pending_apply_failed") {
        await interaction.editReply(
          buildManageDetailPayload(current, "送信処理の反映中のため、少し待ってから再度お試しください"),
        );
        return true;
      }
      if (outcome.kind === "already_sent" || outcome.kind === "cancelled_undeliverable") {
        const rows = await listActive(ctx, guildId, userId, current.ev_type);
        const notice =
          outcome.kind === "cancelled_undeliverable"
            ? "このリマインダーは送信できなかったため取り消されました"
            : "このリマインダーはすでに送信済みです";
        await interaction.editReply(buildManageListPayload(current.ev_type, rows, notice));
        return true;
      }
      const updated = outcome.count;
      const refreshed = await getActive(ctx, guildId, userId, rowId);
      if (!refreshed) {
        const rows = await listActive(ctx, guildId, userId, current.ev_type);
        await interaction.editReply(
          buildManageListPayload(
            current.ev_type,
            rows,
            updated > 0
              ? "更新後データが取得できませんでした。"
              : `#${rowId} はすでに送信済みか、他の処理で更新されました。`,
          ),
        );
        return true;
      }
      await interaction.editReply(
        buildManageDetailPayload(refreshed, `投稿先を <#${channelId}> に変更しました。`),
      );
    } catch (err) {
      await handleDeferredPanelError(interaction, ctx, err, {
        action: "channel_change",
        rowId,
        evType: current.ev_type,
        guildId,
        userId,
        listActive,
      });
    }
    return true;
  }

  return false;
}
