import { ComponentCardBuilder, componentCardsPayload,  } from "../../core/componentCard.js";
import {
  MessageFlags,
  
  
  
  
  type ModalSubmitInteraction,
  
} from "discord.js";

import { withReminderDispatchLock } from "./reminderDispatchLock.js";
import {
  
  clearRecurringPermanentSkipWarned,
  clearReminderRetryState,
  getPendingDispatchUpdate,
  hasPendingDispatchUpdate,
  
  type PendingDispatchAction,
} from "./reminderDispatchState.js";
import {
  
  
  
  
  createReminderHubEntry,
  getActiveForAuthor,
  
  listActiveByType,
  
  
  updateReminderHubContentAndChannel,
} from "./reminderHubRepo.js";
import { applyPendingDispatchUpdate } from "./reminderScheduler.js";
import {
  
  
  
  buildManageDetailPayload,
  buildManageListPayload,
  
} from "./reminderHubPayload.js";
import {
  dueToInput,
  EDIT_MODAL_PREFIX,
  EVENT_META,
  formatDue,
  normalizeEventType,
  parseDueAt,
  parseEditModalCustomId,
  parseRecurrenceInput,
  
} from "./reminderHubTypes.js";

import {
  
  checkSendableGuildChannel,
  formatChannelSendabilityError,
  makeInfoEmbed,
  type ReminderHubHandlerDeps,
  type ReminderHubModalDeps,
} from "./reminderHubCommon.js";

export async function handleReminderHubModal(
  interaction: ModalSubmitInteraction,
  ctx: ReminderHubHandlerDeps,
  deps: ReminderHubModalDeps = {},
): Promise<boolean> {
  if (interaction.customId.startsWith("reminder_modal:")) {
    if (!interaction.guild) {
      await interaction.reply({
        ...componentCardsPayload([makeInfoEmbed("エラー", "サーバー内でのみ利用できます。")]),
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
      return true;
    }
    const parts = interaction.customId.split(":");
    if (parts[0] !== "reminder_modal" || parts.length !== 2) {
      await interaction.reply({
        ...componentCardsPayload([makeInfoEmbed("エラー", "モーダルIDが不正です。")]),
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
      return true;
    }
    const createEntry = deps.createReminderHubEntry ?? createReminderHubEntry;
    const kindRaw = parts[1] ?? "reminder";
    const kind = normalizeEventType(kindRaw);
    const channelId = interaction.fields.getTextInputValue("channel_id").trim();
    if (!channelId || !/^\d+$/.test(channelId)) {
      await interaction.reply({
        ...componentCardsPayload([makeInfoEmbed("エラー", "チャンネルが不正です。")]),
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
      return true;
    }

    const title = interaction.fields.getTextInputValue("title").trim();
    const body = interaction.fields.getTextInputValue("body").trim();
    const dueRaw = interaction.fields.getTextInputValue("due_at").trim();
    const recRaw = interaction.fields.getTextInputValue("recurrence").trim();

    const dueAt = parseDueAt(dueRaw);
    if (!dueAt) {
      await interaction.reply({
        ...componentCardsPayload([makeInfoEmbed("入力エラー", "期限の形式が不正です。")]),
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
      return true;
    }
    const recParse = parseRecurrenceInput(recRaw);
    if (!recParse.valid) {
      await interaction.reply({
        ...componentCardsPayload([makeInfoEmbed("入力エラー", "繰り返しは `10m` `1h` `1d` 形式で入力してください。")]),
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
      return true;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const sendability = await checkSendableGuildChannel(interaction.guild, channelId, ctx.log);
      if (!sendability.ok) {
        await interaction.editReply(
          componentCardsPayload([
            makeInfoEmbed(
              sendability.reason === "temporary_error" ? "一時エラー" : "入力エラー",
              formatChannelSendabilityError(sendability),
            ),
          ]),
        );
        return true;
      }

      const newId = await createEntry(ctx, {
        guildId: interaction.guild.id,
        authorId: interaction.user.id,
        evType: kind,
        title,
        body,
        channelId,
        fireAt: dueAt,
        recurrence: recParse.value,
      });

      const embed = new ComponentCardBuilder()
        .setTitle(`${EVENT_META[kind].label}を作成しました`)
        .setDescription(`ID: **${newId}**`)
        .addFields(
          { name: "投稿先", value: `<#${channelId}>`, inline: true },
          { name: "期限", value: formatDue(dueAt.toISOString()), inline: true },
          { name: "繰り返し", value: recParse.value ? recRaw : "なし", inline: true },
        );
      await interaction.editReply(componentCardsPayload([embed]));
    } catch (err) {
      ctx.log.error(
        { err, guildId: interaction.guild.id, channelId, evType: kind, action: "create" },
        "reminder create modal failed after deferReply",
      );
      try {
        await interaction.editReply(
          componentCardsPayload([
            makeInfoEmbed("エラー", "保存に失敗しました。時間をおいて再度お試しください。"),
          ]),
        );
      } catch (editErr) {
        ctx.log.error(
          { err: editErr, guildId: interaction.guild.id, channelId, evType: kind, action: "create" },
          "failed to edit deferred reminder create reply with error payload",
        );
      }
    }
    return true;
  }

  if (interaction.customId.startsWith(`${EDIT_MODAL_PREFIX}:`)) {
    if (!interaction.guild) {
      await interaction.reply({
        ...componentCardsPayload([makeInfoEmbed("エラー", "サーバー内でのみ利用できます。")]),
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
      return true;
    }
    const getActive = deps.getActiveForAuthor ?? getActiveForAuthor;
    const updateContentAndChannel =
      deps.updateReminderHubContentAndChannel ?? updateReminderHubContentAndChannel;
    const listActive = deps.listActiveByType ?? listActiveByType;
    const guildId = interaction.guild.id;
    const userId = interaction.user.id;
    const parsedEditId = parseEditModalCustomId(interaction.customId);
    if (!parsedEditId) {
      await interaction.reply({
        ...componentCardsPayload([makeInfoEmbed("エラー", "モーダルIDが不正です。")]),
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
      return true;
    }
    const { rowId, modalFireAtMs } = parsedEditId;
    if (modalFireAtMs === null) {
      await interaction.reply({
        ...componentCardsPayload([
          makeInfoEmbed("エラー", "編集画面が古くなっています。もう一度編集ボタンから開き直してください。"),
        ]),
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
      return true;
    }
    const current = await getActive(ctx, guildId, userId, rowId);
    if (!current) {
      await interaction.reply({
        ...componentCardsPayload([makeInfoEmbed("エラー", "対象が見つからないか、すでに無効です。")]),
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
      return true;
    }

    const title = interaction.fields.getTextInputValue("title").trim();
    const body = interaction.fields.getTextInputValue("body").trim();
    const dueRaw = interaction.fields.getTextInputValue("due_at").trim();
    const recRaw = interaction.fields.getTextInputValue("recurrence").trim();
    const channelId = interaction.fields.getTextInputValue("channel_id").trim();

    if (!/^\d+$/.test(channelId)) {
      await interaction.reply({
        ...componentCardsPayload([makeInfoEmbed("入力エラー", "チャンネルIDは数字のみで入力してください。")]),
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
      return true;
    }

    const dueAt = parseDueAt(dueRaw);
    if (!dueAt) {
      await interaction.reply({
        ...componentCardsPayload([makeInfoEmbed("入力エラー", "期限の形式が不正です。")]),
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
      return true;
    }
    const recParse = parseRecurrenceInput(recRaw);
    if (!recParse.valid) {
      await interaction.reply({
        ...componentCardsPayload([makeInfoEmbed("入力エラー", "繰り返しは `10m` `1h` `1d` 形式で入力してください。")]),
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
      return true;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      if (channelId !== current.channel_id) {
        const sendability = await checkSendableGuildChannel(interaction.guild, channelId, ctx.log);
        if (!sendability.ok) {
          await interaction.editReply(
            componentCardsPayload([
              makeInfoEmbed(
                sendability.reason === "temporary_error" ? "一時エラー" : "入力エラー",
                formatChannelSendabilityError(sendability),
              ),
            ]),
          );
          return true;
        }
      }

      type EditOutcome =
        | { kind: "updated"; count: number }
        | { kind: "already_sent" }
        | { kind: "cancelled_undeliverable" }
        | { kind: "pending_apply_failed" };
      const outcome: EditOutcome = await withReminderDispatchLock(rowId, async () => {
        let appliedPendingAction: PendingDispatchAction | undefined;
        if (hasPendingDispatchUpdate(rowId)) {
          const pending = getPendingDispatchUpdate(rowId);
          appliedPendingAction = pending?.action;
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
                "failed to apply pending reminder DB update before edit",
              );
              return { kind: "pending_apply_failed" };
            }
          }
        }
        const latest = await getActive(ctx, guildId, userId, rowId);
        if (!latest || latest.status !== "pending") {
          if (appliedPendingAction !== undefined) {
            return appliedPendingAction === "cancel"
              ? { kind: "cancelled_undeliverable" }
              : { kind: "already_sent" };
          }
          return { kind: "updated", count: 0 };
        }
        let effectiveFireAt = dueAt;
        if (modalFireAtMs !== 0) {
          const latestFireAtMs = Date.parse(latest.fire_at);
          const initialDueInput = dueToInput(new Date(modalFireAtMs).toISOString());
          const userChangedDue = dueRaw !== initialDueInput;
          if (Number.isFinite(latestFireAtMs) && latestFireAtMs !== modalFireAtMs && !userChangedDue) {
            effectiveFireAt = new Date(latestFireAtMs);
          }
        }
        const updatedCount = await updateContentAndChannel(ctx, {
          guildId,
          authorId: userId,
          id: rowId,
          title,
          body,
          fireAt: effectiveFireAt,
          recurrence: recParse.value,
          channelId,
        });
        if (updatedCount === 0) return { kind: "updated", count: 0 };
        clearReminderRetryState(rowId);
        clearRecurringPermanentSkipWarned(rowId);
        return { kind: "updated", count: updatedCount };
      });

      if (outcome.kind === "pending_apply_failed") {
        await interaction.editReply(
          componentCardsPayload([
            makeInfoEmbed("一時エラー", "送信処理の反映中のため、少し待ってから再度お試しください"),
          ]),
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
              ? "更新しましたが一覧の再取得に失敗しました。"
              : `#${rowId} はすでに送信済みか、他の処理で更新されました。`,
          ),
        );
        return true;
      }
      await interaction.editReply(buildManageDetailPayload(refreshed, `#${rowId} を更新しました。`));
    } catch (err) {
      ctx.log.error(
        { err, reminderId: rowId, action: "edit" },
        "reminder edit modal failed after deferReply",
      );
      try {
        await interaction.editReply(
          componentCardsPayload([
            makeInfoEmbed("エラー", "保存に失敗しました。時間をおいて再度お試しください。"),
          ]),
        );
      } catch (editErr) {
        ctx.log.error(
          { err: editErr, reminderId: rowId, action: "edit" },
          "failed to edit deferred reminder edit reply with error payload",
        );
      }
    }
    return true;
  }

  return false;
}

