import type { BotContext } from "../../bot/context.js";
import type { RemindersRow } from "../../core/db/types.js";
import { EVENT_META, normalizeEventType } from "./reminderHubTypes.js";
import { reminderRowStoredData } from "./reminderHubRepo.js";

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
  const mentionRaw =
    data.mention_text?.trim() || (ev === "notice" ? "@everyone" : `<@${row.author_id}>`);
  const mention = `${mentionRaw} `;
  const title = data.title || label;
  const content = `${mention}**${title}**\n${row.body}`.slice(0, 2000);
  await ch
    .send({
      content,
      allowedMentions: { parse: ["users", "roles", "everyone"] },
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
  const text = `${label}: ${data.title || label}\n${row.body}`.slice(0, 2000);
  await user.send(text).catch(() => undefined);
}
