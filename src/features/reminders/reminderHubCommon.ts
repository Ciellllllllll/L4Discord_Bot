import { ComponentCardBuilder, componentCardsPayload,  } from "../../core/componentCard.js";
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
  
  
} from "discord.js";
import type { CoreDeps } from "../../core/deps.js";
import type pino from "pino";

import {
  applyDispatchResult,
  cancelReminderForAuthor,
  cancelUndeliverableReminder,
  createReminderHubEntry,
  getActiveForAuthor,
  getReminderRowForAuthor,
  listActiveByType,
  updateReminderHubChannel,
  updateReminderHubContentAndChannel,
} from "./reminderHubRepo.js";
import { buildManageListPayload, type ReminderHubMessagePayload } from "./reminderHubPayload.js";
import { sendReminderHubMessage } from "./reminderHubSend.js";
import type { ReminderEvType } from "./reminderHubTypes.js";

// ReminderHub の共通処理と、各入口 (ボタン/セレクト/モーダル) の依存型。
export type ReminderHubHandlerDeps = Pick<CoreDeps, "config" | "db" | "log" | "client">;

export function makeInfoEmbed(title: string, description: string): ComponentCardBuilder {
  return new ComponentCardBuilder().setTitle(title).setDescription(description);
}

export type ChannelSendabilityResult =
  | { ok: true }
  | { ok: false; reason: "not_sendable" }
  | { ok: false; reason: "missing_permissions"; missing: string[] }
  | { ok: false; reason: "temporary_error" };

export async function checkSendableGuildChannel(
  guild: Guild,
  channelId: string,
  log: Pick<pino.Logger, "warn">,
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

export function formatChannelSendabilityError(result: Exclude<ChannelSendabilityResult, { ok: true }>): string {
  if (result.reason === "missing_permissions") {
    return `Bot がこのチャンネルに投稿できません（権限: ${result.missing.join(", ")}）`;
  }
  if (result.reason === "temporary_error") {
    return "Discord との通信に失敗しました。少し待ってから再度お試しください。";
  }
  return "このサーバー内の送信可能なテキストチャンネルを指定してください。";
}

// DiscordBotv2 と同一のボタン customId か（誤ルーティング防止）

export function isReminderSystemButtonId(id: string): boolean {
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

export async function buildManageListForUser(
  ctx: ReminderHubHandlerDeps,
  guildId: string,
  userId: string,
  kind: ReminderEvType,
  noticeText = "",
): Promise<ReminderHubMessagePayload> {
  const rows = await listActiveByType(ctx, guildId, userId, kind);
  return buildManageListPayload(kind, rows, noticeText);
}

export async function handleDeferredPanelError(
  interaction: ButtonInteraction | ChannelSelectMenuInteraction,
  ctx: ReminderHubHandlerDeps,
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
