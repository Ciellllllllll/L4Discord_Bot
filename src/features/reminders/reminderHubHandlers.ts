import { componentCardsPayload, ephemeralComponentPayload } from "../../core/componentCard.js";
import {
  MessageFlags,
  
  type ButtonInteraction,
  
  
  
  
} from "discord.js";

import { withReminderDispatchLock } from "./reminderDispatchLock.js";
import {
  clearPendingDispatchUpdate,
  clearRecurringPermanentSkipWarned,
  clearReminderRetryState,
  
  hasPendingDispatchUpdate,
  recordPendingDispatchUpdate,
  
} from "./reminderDispatchState.js";
import {
  applyDispatchResult,
  cancelReminderForAuthor,
  
  computeNextFireAtForRow,
  
  getActiveForAuthor,
  getReminderRowForAuthor,
  listActiveByType,
  reminderRowStoredData,
  
  
} from "./reminderHubRepo.js";
import {
  buildCreateChannelPayload,
  buildCreateModal,
  buildEditModal,
  buildManageDetailPayload,
  buildManageListPayload,
  
} from "./reminderHubPayload.js";
import { sendReminderHubMessage, type ReminderSendResult } from "./reminderHubSend.js";
import {
  
  
  
  
  normalizeEventType,
  
  
  
  type ReminderEvType,
} from "./reminderHubTypes.js";

import {
  buildManageListForUser,
  handleDeferredPanelError,
  isReminderSystemButtonId,
  makeInfoEmbed,
  type ReminderHubButtonDeps,
  type ReminderHubHandlerDeps,
} from "./reminderHubCommon.js";

export async function handleReminderHubButton(
  interaction: ButtonInteraction,
  ctx: ReminderHubHandlerDeps,
  deps: ReminderHubButtonDeps = {},
): Promise<boolean> {
  if (!isReminderSystemButtonId(interaction.customId)) return false;

  const id = interaction.customId;
  const createMap: Record<string, ReminderEvType> = {
    reminder_create: "reminder",
    todo_create: "todo",
    notice_create: "notice",
  };

  if (id.startsWith("rem_create_channel_id:")) {
    if (!interaction.guild) {
      await interaction.reply({
        ...componentCardsPayload([makeInfoEmbed("エラー", "サーバー内でのみ利用できます。")]),
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
      return true;
    }
    const kind = normalizeEventType(id.slice("rem_create_channel_id:".length));
    await interaction.showModal(buildCreateModal(kind));
    return true;
  }

  if (createMap[id]) {
    if (!interaction.guild) {
      await interaction.reply({
        ...componentCardsPayload([makeInfoEmbed("エラー", "サーバー内でのみ利用できます。")]),
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
      return true;
    }
    await interaction.reply(ephemeralComponentPayload(buildCreateChannelPayload(createMap[id])));
    return true;
  }

  if (id === "reminder_manage" || id === "reminder_list") {
    if (!interaction.guild) {
      await interaction.reply({
        ...componentCardsPayload([makeInfoEmbed("エラー", "サーバー内でのみ利用できます。")]),
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
      return true;
    }
    const payload = await buildManageListForUser(ctx, interaction.guild.id, interaction.user.id, "reminder");
    await interaction.reply(ephemeralComponentPayload(payload));
    return true;
  }

  if (id.startsWith("rem_manage_tab:") || id.startsWith("rem_manage_back:") || id.startsWith("rem_manage_refresh:")) {
    if (!interaction.guild) {
      await interaction.reply({
        ...componentCardsPayload([makeInfoEmbed("エラー", "サーバー内でのみ利用できます。")]),
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
      return true;
    }
    const kind = normalizeEventType(id.split(":")[1] ?? "reminder");
    const payload = await buildManageListForUser(ctx, interaction.guild.id, interaction.user.id, kind);
    await interaction.update(payload);
    return true;
  }

  if (id.startsWith("rem_manage_edit:")) {
    if (!interaction.guild) {
      await interaction.reply({
        ...componentCardsPayload([makeInfoEmbed("エラー", "サーバー内でのみ利用できます。")]),
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
      return true;
    }
    const getActive = deps.getActiveForAuthor ?? getActiveForAuthor;
    const rowId = id.slice("rem_manage_edit:".length);
    const row = await getActive(ctx, interaction.guild.id, interaction.user.id, rowId);
    if (!row) {
      await interaction.reply({
        ...componentCardsPayload([makeInfoEmbed("エラー", "対象が見つからないか、すでに無効です。")]),
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
      return true;
    }
    const modal = buildEditModal(row);
    if (!modal) {
      ctx.log.error(
        { reminderId: row.id, fireAt: row.fire_at },
        "failed to build reminder edit modal customId",
      );
      await interaction.reply({
        ...componentCardsPayload([makeInfoEmbed("エラー", "編集画面を開けませんでした。時間をおいて再度お試しください。")]),
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
      return true;
    }
    await interaction.showModal(modal);
    return true;
  }

  if (id.startsWith("rem_manage_delete:")) {
    if (!interaction.guild) {
      await interaction.reply({
        ...componentCardsPayload([makeInfoEmbed("エラー", "サーバー内でのみ利用できます。")]),
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
      return true;
    }
    const getActive = deps.getActiveForAuthor ?? getActiveForAuthor;
    const cancelReminder = deps.cancelReminderForAuthor ?? cancelReminderForAuthor;
    const listActive = deps.listActiveByType ?? listActiveByType;

    const rowId = id.slice("rem_manage_delete:".length);
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
      const updated = await withReminderDispatchLock(rowId, async () => {
        const count = await cancelReminder(ctx, guildId, userId, rowId);
        clearReminderRetryState(rowId);
        clearRecurringPermanentSkipWarned(rowId);
        clearPendingDispatchUpdate(rowId);
        return count;
      });
      const notice =
        updated > 0
          ? `#${rowId} を削除しました。`
          : `#${rowId} はすでに送信済みか、他の処理で更新されました。`;
      const rows = await listActive(ctx, guildId, userId, current.ev_type);
      await interaction.editReply(buildManageListPayload(current.ev_type, rows, notice));
    } catch (err) {
      await handleDeferredPanelError(interaction, ctx, err, {
        action: "delete",
        rowId,
        evType: current.ev_type,
        guildId,
        userId,
        listActive,
      });
    }
    return true;
  }

  if (id.startsWith("rem_manage_post:")) {
    if (!interaction.guild) {
      await interaction.reply({
        ...componentCardsPayload([makeInfoEmbed("エラー", "サーバー内でのみ利用できます。")]),
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
      return true;
    }
    const getRow = deps.getReminderRowForAuthor ?? getReminderRowForAuthor;
    const applyDispatch = deps.applyDispatchResult ?? applyDispatchResult;
    const sendReminder = deps.sendReminderHubMessage ?? sendReminderHubMessage;
    const getActive = deps.getActiveForAuthor ?? getActiveForAuthor;
    const listActive = deps.listActiveByType ?? listActiveByType;
    const nowFn = deps.now ?? Date.now;

    const rowId = id.slice("rem_manage_post:".length);
    const guildId = interaction.guild.id;
    const userId = interaction.user.id;
    const initial = await getRow(ctx, guildId, userId, rowId);
    if (!initial) {
      await interaction.reply({
        ...componentCardsPayload([makeInfoEmbed("エラー", "対象が見つからないか、すでに無効です。")]),
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
      return true;
    }
    await interaction.deferUpdate();
    try {
      const outcome = await withReminderDispatchLock(rowId, async () => {
        const fresh = await getRow(ctx, guildId, userId, rowId);
        if (!fresh || fresh.status !== "pending" || fresh.fire_at !== initial.fire_at) {
          return { kind: "already_processed" as const, row: fresh ?? initial };
        }
        if (hasPendingDispatchUpdate(fresh.id, fresh.fire_at)) {
          return { kind: "already_processed" as const, row: fresh };
        }
        let sendResult: ReminderSendResult;
        try {
          sendResult = await sendReminder(ctx, fresh);
        } catch (err) {
          sendResult = { delivered: false, channelError: err, dmError: undefined, permanent: false };
        }
        if (!sendResult.delivered) {
          ctx.log.error(
            {
              channelError: sendResult.channelError,
              dmError: sendResult.dmError,
              permanent: sendResult.permanent,
              reminderId: fresh.id,
              channelId: fresh.channel_id,
            },
            "manual reminder delivery failed",
          );
          return { kind: "failed" as const, row: fresh };
        }
        clearReminderRetryState(fresh.id);
        clearRecurringPermanentSkipWarned(fresh.id);
        const nextFireAt = computeNextFireAtForRow(fresh, true, nowFn());
        try {
          await applyDispatch(ctx, fresh, true, undefined, nextFireAt);
        } catch (err) {
          recordPendingDispatchUpdate(fresh, true, "delivered", nextFireAt);
          ctx.log.error(
            { err, reminderId: fresh.id, channelId: fresh.channel_id },
            "manual reminder delivered but DB update failed; queued for retry",
          );
        }
        return { kind: "delivered" as const, row: fresh };
      });

      const notice =
        outcome.kind === "already_processed"
          ? `#${rowId} はすでに送信済みか、他の処理で更新されました。`
          : outcome.kind === "failed"
            ? `#${rowId} の送信に失敗しました。`
            : `#${rowId} を即時投稿しました。`;

      const refreshed = await getActive(ctx, guildId, userId, rowId);
      if (refreshed) {
        await interaction.editReply(buildManageDetailPayload(refreshed, notice));
      } else {
        const kindFromRow = reminderRowStoredData(outcome.row).ev_type;
        const rows = await listActive(ctx, guildId, userId, kindFromRow);
        await interaction.editReply(buildManageListPayload(kindFromRow, rows, notice));
      }
    } catch (err) {
      await handleDeferredPanelError(interaction, ctx, err, {
        action: "post",
        rowId,
        evType: reminderRowStoredData(initial).ev_type,
        guildId,
        userId,
        listActive,
      });
    }
    return true;
  }

  return false;
}
