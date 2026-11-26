import { DiscordAPIError } from "discord.js";
import { ComponentCardBuilder, componentCardsPayload } from "../../core/componentCard.js";
import {
  DISCORD_API_MISSING_ACCESS,
  DISCORD_API_MISSING_PERMISSIONS,
  DISCORD_API_UNKNOWN_CHANNEL,
  DISCORD_API_UNKNOWN_GUILD,
  getDiscordErrorCode,
  getHttpStatus,
  isPermanentReminderDeliveryPair,
  isStructuralReminderDeliveryError,
} from "../../core/discordErrors.js";

import type { CoreDeps } from "../../core/deps.js";
import type { RemindersRow } from "../../core/db/types.js";
import { EVENT_META, normalizeEventType, type ReminderEvType } from "./reminderHubTypes.js";
import { reminderRowStoredData } from "./reminderHubRepo.js";

// ReminderHubSend が使う依存。
type ReminderHubSendDeps = Pick<CoreDeps, "config" | "client" | "log">;

export type StructuralReminderDeliveryErrorCode =
  | "GUILD_NOT_FOUND"
  | "CHANNEL_NOT_SENDABLE"
  | "AUTHOR_NOT_FOUND";

export class StructuralReminderDeliveryError extends Error {
  readonly kind = "structural" as const;
  readonly code: StructuralReminderDeliveryErrorCode;

  constructor(code: StructuralReminderDeliveryErrorCode, message: string) {
    super(message);
    this.name = "StructuralReminderDeliveryError";
    this.code = code;
  }
}

export type ReminderSendResult =
  | { delivered: true; via: "channel" | "dm" }
  | {
      delivered: false;
      channelError: unknown;
      dmError: unknown;
      permanent: boolean;
    };

// 公開投稿用: タイトル・本文とも Discord 見出し1（#）。本文は大文字。

export function buildReminderHubPublicEmbed(
  ev: ReminderEvType,
  titleLine: string,
  bodyText: string,
): ComponentCardBuilder {
  const meta = EVENT_META[ev];
  const t = titleLine.trim() || meta.label;
  const b = bodyText.trim();
  const desc = [`## ${t}`, b ? `### ${b}` : ""]
    .filter((line) => line.length > 0)
    .join("\n")
    .slice(0, 4096);
  return new ComponentCardBuilder().setDescription(desc);
}

function isNonTransientDiscordApi4xx(error: unknown): boolean {
  const status = getHttpStatus(error);
  if (status === null || status < 400 || status >= 500 || status === 429) {
    return false;
  }
  if (error instanceof DiscordAPIError) {
    return true;
  }
  const hasDiscordApiName =
    typeof error === "object"
    && error !== null
    && "name" in error
    && typeof (error as { name: unknown }).name === "string"
    && (error as { name: string }).name.startsWith("DiscordAPIError");
  return hasDiscordApiName || getDiscordErrorCode(error) !== null;
}

function shouldFallbackToDmOnChannelError(error: unknown): boolean {
  if (isStructuralReminderDeliveryError(error)) {
    return true;
  }
  const code = getDiscordErrorCode(error);
  if (
    code === DISCORD_API_UNKNOWN_CHANNEL
    || code === DISCORD_API_UNKNOWN_GUILD
    || code === DISCORD_API_MISSING_ACCESS
    || code === DISCORD_API_MISSING_PERMISSIONS
  ) {
    return true;
  }
  return isNonTransientDiscordApi4xx(error);
}

export async function sendReminderHubMessage(ctx: ReminderHubSendDeps, row: RemindersRow): Promise<ReminderSendResult> {
  const data = reminderRowStoredData(row);
  const ev = normalizeEventType(data.ev_type);
  const label = EVENT_META[ev].label;
  const title = data.title || label;
  const embed = buildReminderHubPublicEmbed(ev, title, row.body);
  const payload = {
    ...componentCardsPayload([embed]),
    allowedMentions: { parse: [] },
  };

  let channelError: unknown;
  try {
    const guild = await ctx.client.guilds.fetch(row.guild_id);
    if (!guild) {
      channelError = new StructuralReminderDeliveryError(
        "GUILD_NOT_FOUND",
        `Reminder target guild not found: ${row.guild_id}`,
      );
    } else {
      const ch = await ctx.client.channels.fetch(row.channel_id);
      if (!ch || !("guildId" in ch) || ch.guildId !== row.guild_id || !ch.isTextBased() || !ch.isSendable()) {
        channelError = new StructuralReminderDeliveryError(
          "CHANNEL_NOT_SENDABLE",
          `Reminder target channel is not sendable: ${row.channel_id}`,
        );
      } else {
        await ch.send(payload);
        return { delivered: true, via: "channel" };
      }
    }
  } catch (err) {
    channelError = err;
  }

  if (!shouldFallbackToDmOnChannelError(channelError)) {
    return {
      delivered: false,
      channelError,
      dmError: undefined,
      permanent: false,
    };
  }

  return dmFallback(ctx, row, payload, channelError);
}

async function dmFallback(
  ctx: ReminderHubSendDeps,
  row: RemindersRow,
  payload: ReturnType<typeof componentCardsPayload> & { allowedMentions: { parse: never[] } },
  channelError: unknown,
): Promise<ReminderSendResult> {
  try {
    const user = await ctx.client.users.fetch(row.author_id);
    if (!user) {
      const dmError = new StructuralReminderDeliveryError(
        "AUTHOR_NOT_FOUND",
        `Reminder author not found: ${row.author_id}`,
      );
      return {
        delivered: false,
        channelError,
        dmError,
        permanent: isPermanentReminderDeliveryPair(channelError, dmError),
      };
    }
    await user.send(payload);
    return { delivered: true, via: "dm" };
  } catch (dmError) {
    return {
      delivered: false,
      channelError,
      dmError,
      permanent: isPermanentReminderDeliveryPair(channelError, dmError),
    };
  }
}
