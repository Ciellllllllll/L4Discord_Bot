import type DatabaseLib from "better-sqlite3";
import type { Message, PartialMessage } from "discord.js";
import { snowflakeToBigInt } from "../../core/snowflake.js";

function attachmentsJson(m: Message): string {
  try {
    const urls = [...m.attachments.values()].map((a) => a.url).slice(0, 10);
    return JSON.stringify(urls);
  } catch {
    return "[]";
  }
}

function shouldSkipGuild(guildId: string, targetGuildId: string): boolean {
  return guildId !== targetGuildId;
}

export function ingestMessageCreate(
  sqlite: DatabaseLib.Database,
  message: Message,
  targetGuildId: string,
  excludedChannelIds: string[],
): void {
  if (!message.guildId || message.author.bot) return;
  if (shouldSkipGuild(message.guildId, targetGuildId)) return;
  if (excludedChannelIds.includes(message.channelId)) return;
  const gid = snowflakeToBigInt(message.guildId);
  const cid = snowflakeToBigInt(message.channelId);
  const uid = snowflakeToBigInt(message.author.id);
  const now = new Date().toISOString();
  const content = message.content ?? "";
  sqlite
    .prepare(
      `INSERT INTO message_logs (log_type, guild_id, channel_id, user_id, user_name, content, edited_at, deleted_at, time, attachments)
       VALUES ('create', ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
    )
    .run(
      gid,
      cid,
      uid,
      message.author.username?.slice(0, 128) ?? "unknown",
      content,
      now,
      attachmentsJson(message),
    );
}

export function ingestMessageUpdate(
  sqlite: DatabaseLib.Database,
  message: Message,
  targetGuildId: string,
  excludedChannelIds: string[],
): void {
  if (!message.guildId || message.author.bot) return;
  if (shouldSkipGuild(message.guildId, targetGuildId)) return;
  if (excludedChannelIds.includes(message.channelId)) return;
  const gid = snowflakeToBigInt(message.guildId);
  const cid = snowflakeToBigInt(message.channelId);
  const uid = snowflakeToBigInt(message.author.id);
  const now = new Date().toISOString();
  const content = message.content ?? "";
  sqlite
    .prepare(
      `INSERT INTO message_logs (log_type, guild_id, channel_id, user_id, user_name, content, edited_at, deleted_at, time, attachments)
       VALUES ('edit', ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    )
    .run(
      gid,
      cid,
      uid,
      message.author.username?.slice(0, 128) ?? "unknown",
      content,
      now,
      now,
      attachmentsJson(message),
    );
}

export function ingestMessageDelete(
  sqlite: DatabaseLib.Database,
  message: Message | PartialMessage,
  targetGuildId: string,
  excludedChannelIds: string[],
): void {
  if (!message.guildId) return;
  if (shouldSkipGuild(message.guildId, targetGuildId)) return;
  if (message.channelId && excludedChannelIds.includes(message.channelId)) return;
  const author = message.author;
  if (author?.bot) return;
  const gid = snowflakeToBigInt(message.guildId);
  const cid = snowflakeToBigInt(message.channelId ?? "0");
  const uid = author ? snowflakeToBigInt(author.id) : BigInt(0);
  const now = new Date().toISOString();
  const content = message.content ?? "";
  const name = author?.username?.slice(0, 128) ?? "unknown";
  sqlite
    .prepare(
      `INSERT INTO message_logs (log_type, guild_id, channel_id, user_id, user_name, content, edited_at, deleted_at, time, attachments)
       VALUES ('delete', ?, ?, ?, ?, ?, NULL, ?, ?, '[]')`,
    )
    .run(gid, cid, uid, name, content, now, now);
}
