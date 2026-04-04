import { EmbedBuilder } from "discord.js";
import type { BotContext } from "../../bot/context.js";
import type { RemindersRow } from "../../core/db/types.js";
import { EVENT_META, normalizeEventType, type ReminderEvType } from "./reminderHubTypes.js";
import { reminderRowStoredData } from "./reminderHubRepo.js";

/** 公開投稿用: タイトル・本文とも Discord 見出し1（#）。本文は大文字。 */
export function buildReminderHubPublicEmbed(
  ev: ReminderEvType,
  titleLine: string,
  bodyText: string,
): EmbedBuilder {
  const meta = EVENT_META[ev];
  const t = titleLine.trim() || meta.label;
  const b = bodyText.trim();
  const desc = [`## ${t}`, b ? `### **${b}**` : ""]
    .filter((line) => line.length > 0)
    .join("\n")
    .slice(0, 4096);
  return new EmbedBuilder().setColor(meta.color).setDescription(desc);
}

export async function sendReminderHubMessage(ctx: BotContext, row: RemindersRow): Promise<void> {
  const data = reminderRowStoredData(row);
  const guild = await ctx.client.guilds.fetch(row.guild_id).catch(() => null);
  if (!guild) {
    await dmFallback(ctx, row, data);
    return;
  }
  const ch = await ctx.client.channels.fetch(row.channel_id).catch(() => null);
  if (!ch?.isTextBased() || !ch.isSendable()) {
    await dmFallback(ctx, row, data);
    return;
  }

  const ev = normalizeEventType(data.ev_type);
  const label = EVENT_META[ev].label;
  const title = data.title || label;
  const embed = buildReminderHubPublicEmbed(ev, title, row.body);
  await ch
    .send({
      embeds: [embed],
      allowedMentions: { parse: [] },
    })
    .catch(() => undefined);
}

async function dmFallback(
  ctx: BotContext,
  row: RemindersRow,
  data: ReturnType<typeof reminderRowStoredData>,
): Promise<void> {
  const ev = normalizeEventType(data.ev_type);
  const label = EVENT_META[ev].label;
  const user = await ctx.client.users.fetch(row.author_id).catch(() => null);
  if (!user) return;
  const title = data.title || label;
  const embed = buildReminderHubPublicEmbed(ev, title, row.body);
  await user.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => undefined);
}
