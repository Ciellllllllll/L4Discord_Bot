import { ComponentCardBuilder, componentCardsPayload, ephemeralComponentPayload } from "../../core/componentCard.js";
import {
  DISCORD_API_MISSING_ACCESS,
  DISCORD_API_MISSING_PERMISSIONS,
  getDiscordErrorCode,
  getHttpStatus,
  isDiscordUnknownChannelOrNotFound,
} from "../../core/discordErrors.js";
import {
  MessageFlags,
  PermissionFlagsBits,
  type ButtonInteraction,
  type ChannelSelectMenuInteraction,
  type Guild,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import type { BotContext } from "../../bot/context.js";
import { withReminderDispatchLock } from "./reminderDispatchLock.js";
import {
  clearPendingDispatchUpdate,
  clearRecurringPermanentSkipWarned,
  clearReminderRetryState,
  getPendingDispatchUpdate,
  hasPendingDispatchUpdate,
  recordPendingDispatchUpdate,
  type PendingDispatchAction,
} from "./reminderDispatchState.js";
import {
  applyDispatchResult,
  cancelReminderForAuthor,
  cancelUndeliverableReminder,
  computeNextFireAtForRow,
  createReminderHubEntry,
  getActiveForAuthor,
  getReminderRowForAuthor,
  listActiveByType,
  reminderRowStoredData,
  updateReminderHubChannel,
  updateReminderHubContentAndChannel,
} from "./reminderHubRepo.js";
import { applyPendingDispatchUpdate } from "./reminderScheduler.js";
import {
  buildCreateChannelPayload,
  buildCreateModal,
  buildEditModal,
  buildManageDetailPayload,
  buildManageListPayload,
  type ReminderHubMessagePayload,
} from "./reminderHubPayload.js";
import { sendReminderHubMessage, type ReminderSendResult } from "./reminderHubSend.js";
import {
  dueToInput,
  EDIT_MODAL_PREFIX,
  EVENT_META,
  formatDue,
  normalizeEventType,
  parseDueAt,
  parseEditModalCustomId,
  parseRecurrenceInput,
  type ReminderEvType,
} from "./reminderHubTypes.js";

function makeInfoEmbed(title: string, description: string): ComponentCardBuilder {
  return new ComponentCardBuilder().setTitle(title).setDescription(description);
}

type ChannelSendabilityResult =
  | { ok: true }
  | { ok: false; reason: "not_sendable" }
  | { ok: false; reason: "missing_permissions"; missing: string[] }
  | { ok: false; reason: "temporary_error" };

async function checkSendableGuildChannel(
  guild: Guild,
  channelId: string,
  log: Pick<BotContext["log"], "warn">,
): Promise<ChannelSendabilityResult> {
  let ch = guild.channels?.cache?.get(channelId) ?? null;
  if (!ch && typeof guild.channels?.fetch === "function") {
    try {
      ch = await guild.channels.fetch(channelId);
    } catch (err) {
      if (isDiscordUnknownChannelOrNotFound(err)) {
        return { ok: false, reason: "not_sendable" };
      }
      const code = getDiscordErrorCode(err);
      const status = getHttpStatus(err);
      if (
        code === DISCORD_API_MISSING_ACCESS
        || code === DISCORD_API_MISSING_PERMISSIONS
        || status === 403
      ) {
        return { ok: false, reason: "missing_permissions", missing: ["ViewChannel"] };
      }
      log.warn(
        { err, guildId: guild.id, channelId },
        "failed to fetch channel for reminder sendability check",
      );
      return { ok: false, reason: "temporary_error" };
    }
  }
  if (!ch || !("guildId" in ch) || ch.guildId !== guild.id) {
    return { ok: false, reason: "not_sendable" };
  }
  if (!ch.isTextBased() || !ch.isSendable()) {
    return { ok: false, reason: "not_sendable" };
  }

  let me = guild.members?.me ?? null;
  if (!me && typeof guild.members?.fetchMe === "function") {
    try {
      me = await guild.members.fetchMe();
    } catch (err) {
      log.warn(
        { err, guildId: guild.id, channelId },
        "failed to fetch bot guild member for channel permission check; skipping check",
      );
      return { ok: true };
    }
  }
  if (!me) {
    log.warn(
      { guildId: guild.id, channelId },
      "bot guild member unavailable for channel permission check; skipping check",
    );
    return { ok: true };
  }
  if (typeof ch.permissionsFor !== "function") {
    log.warn(
      { guildId: guild.id, channelId },
      "channel permissionsFor unavailable for channel permission check; skipping check",
    );
    return { ok: true };
  }

  const perms = ch.permissionsFor(me);
  if (!perms) {
    log.warn(
      { guildId: guild.id, channelId },
      "failed to resolve bot permissions for channel; skipping check",
    );
    return { ok: true };
  }

  const isThread = typeof ch.isThread === "function" && ch.isThread();
  const missing: string[] = [];
  if (!perms.has(PermissionFlagsBits.ViewChannel)) {
    missing.push("ViewChannel");
  }
  if (isThread) {
    if (!perms.has(PermissionFlagsBits.SendMessagesInThreads)) {
      missing.push("SendMessagesInThreads");
    }
  } else if (!perms.has(PermissionFlagsBits.SendMessages)) {
    missing.push("SendMessages");
  }

  if (missing.length > 0) {
    return { ok: false, reason: "missing_permissions", missing };
  }
  return { ok: true };
}

function formatChannelSendabilityError(result: Exclude<ChannelSendabilityResult, { ok: true }>): string {
  if (result.reason === "missing_permissions") {
    return `Bot がこのチャンネルに投稿できません（権限: ${result.missing.join(", ")}）`;
  }
  if (result.reason === "temporary_error") {
    return "Discord との通信に失敗しました。少し待ってから再度お試しください。";
  }
  return "このサーバー内の送信可能なテキストチャンネルを指定してください。";
}

// DiscordBotv2 と同一のボタン customId か（誤ルーティング防止）

function isReminderSystemButtonId(id: string): boolean {
  if (
    id === "reminder_create" ||
    id === "todo_create" ||
    id === "notice_create" ||
    id === "reminder_manage" ||
    id === "reminder_list"
  ) {
    return true;
  }
  return id.startsWith("rem_manage_") || id.startsWith("rem_create_channel_id:");
}

async function buildManageListForUser(
  ctx: BotContext,
  guildId: string,
  userId: string,
  kind: ReminderEvType,
  noticeText = "",
): Promise<ReminderHubMessagePayload> {
  const rows = await listActiveByType(ctx, guildId, userId, kind);
  return buildManageListPayload(kind, rows, noticeText);
}

async function handleDeferredPanelError(
  interaction: ButtonInteraction | ChannelSelectMenuInteraction,
  ctx: BotContext,
  err: unknown,
  context: {
    action: string;
    rowId: string;
    evType: ReminderEvType;
    guildId: string;
    userId: string;
    listActive: typeof listActiveByType;
  },
): Promise<void> {
  ctx.log.error(
    { err, reminderId: context.rowId, action: context.action },
    "reminder manage action failed after deferUpdate",
  );
  const errorNotice = `#${context.rowId} の処理中にエラーが発生しました。少し待ってから再度お試しください。`;
  try {
    const rows = await context.listActive(ctx, context.guildId, context.userId, context.evType);
    await interaction.editReply(buildManageListPayload(context.evType, rows, errorNotice));
    return;
  } catch (editErr) {
    ctx.log.error(
      { err: editErr, reminderId: context.rowId, action: context.action },
      "failed to refresh or edit deferred reminder manage panel with error payload",
    );
  }
  try {
    await interaction.followUp({
      ...componentCardsPayload([makeInfoEmbed("エラー", errorNotice)]),
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    });
  } catch (followUpErr) {
    ctx.log.error(
      { err: followUpErr, reminderId: context.rowId, action: context.action },
      "failed to send ephemeral followUp for reminder manage error",
    );
  }
}

export type ReminderHubButtonDeps = {
  getReminderRowForAuthor?: typeof getReminderRowForAuthor;
  applyDispatchResult?: typeof applyDispatchResult;
  sendReminderHubMessage?: typeof sendReminderHubMessage;
  cancelReminderForAuthor?: typeof cancelReminderForAuthor;
  getActiveForAuthor?: typeof getActiveForAuthor;
  listActiveByType?: typeof listActiveByType;
  now?: () => number;
};

export type ReminderHubChannelSelectDeps = {
  getActiveForAuthor?: typeof getActiveForAuthor;
  updateReminderHubChannel?: typeof updateReminderHubChannel;
  listActiveByType?: typeof listActiveByType;
  applyDispatchResult?: typeof applyDispatchResult;
  cancelUndeliverableReminder?: typeof cancelUndeliverableReminder;
  now?: () => number;
};

export type ReminderHubModalDeps = {
  createReminderHubEntry?: typeof createReminderHubEntry;
  getActiveForAuthor?: typeof getActiveForAuthor;
  updateReminderHubContentAndChannel?: typeof updateReminderHubContentAndChannel;
  listActiveByType?: typeof listActiveByType;
  applyDispatchResult?: typeof applyDispatchResult;
  cancelUndeliverableReminder?: typeof cancelUndeliverableReminder;
  now?: () => number;
};

export async function handleReminderHubButton(
  interaction: ButtonInteraction,
  ctx: BotContext,
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

export async function handleReminderHubStringSelect(
  interaction: StringSelectMenuInteraction,
  ctx: BotContext,
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
  ctx: BotContext,
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

export async function handleReminderHubModal(
  interaction: ModalSubmitInteraction,
  ctx: BotContext,
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
