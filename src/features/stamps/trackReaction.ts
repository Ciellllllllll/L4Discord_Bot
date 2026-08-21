import type { Message, MessageReaction, PartialMessageReaction, User } from "discord.js";
import { sql } from "kysely";
import type { BotContext } from "../../bot/context.js";
import { nowIso } from "../../core/db/nowIso.js";

type StampUsageItem = {
  id: string;
  name: string;
};

const CUSTOM_EMOJI_RE = /<a?:([A-Za-z0-9_]{2,32}):(\d{17,20})>/g;
const EMOJI_PART = String.raw`\p{Extended_Pictographic}(?:\p{Emoji_Modifier})?(?:\uFE0F|\uFE0E)?`;
const UNICODE_EMOJI_RE = new RegExp(
  String.raw`\p{Regional_Indicator}{2}|${EMOJI_PART}(?:\u200D${EMOJI_PART})*|\p{Emoji_Presentation}(?:\p{Emoji_Modifier})?`,
  "gu",
);

function normalizeCount(count: number): bigint {
  return BigInt(Math.max(1, Math.trunc(count)));
}

function countUsageItems(items: StampUsageItem[]): Array<StampUsageItem & { count: number }> {
  const byId = new Map<string, StampUsageItem & { count: number }>();

  for (const item of items) {
    const current = byId.get(item.id);
    if (current) {
      current.count += 1;
      current.name = item.name;
      continue;
    }
    byId.set(item.id, { ...item, count: 1 });
  }

  return [...byId.values()];
}

async function incrementStampUsage(
  ctx: BotContext,
  guildId: string,
  userId: string,
  item: StampUsageItem,
  count = 1,
): Promise<void> {
  const now = nowIso() as unknown as Date;
  const amount = normalizeCount(count);
  const name = item.name.slice(0, 128);

  await ctx.db
    .insertInto("stamp_usage")
    .values({
      guild_id: guildId,
      user_id: userId,
      emoji_id: item.id,
      emoji_name: name,
      count: amount,
      updated_at: now,
    })
    .onConflict((oc) =>
      oc.columns(["guild_id", "user_id", "emoji_id"]).doUpdateSet({
        count: sql`stamp_usage.count + ${amount}`,
        emoji_name: name,
        updated_at: now,
      }),
    )
    .execute();
}

function extractEmojiUsageFromContent(content: string): StampUsageItem[] {
  const items: StampUsageItem[] = [];
  const customRanges: Array<[number, number]> = [];

  for (const match of content.matchAll(CUSTOM_EMOJI_RE)) {
    const raw = match[0];
    const name = match[1] ?? "?";
    const id = match[2];
    if (!id) continue;
    items.push({ id, name });
    customRanges.push([match.index ?? 0, (match.index ?? 0) + raw.length]);
  }

  for (const match of content.matchAll(UNICODE_EMOJI_RE)) {
    const raw = match[0];
    const index = match.index ?? 0;
    if (!raw || customRanges.some(([start, end]) => index >= start && index < end)) {
      continue;
    }
    items.push({ id: `u:${raw}`, name: raw });
  }

  return items;
}

function extractStickerUsageFromMessage(message: Message): StampUsageItem[] {
  return [...message.stickers.values()].map((sticker) => ({
    id: `s:${sticker.id}`,
    name: sticker.name || sticker.id,
  }));
}

export async function trackStampMessage(message: Message, ctx: BotContext): Promise<void> {
  if (!message.guildId || message.author.bot) return;

  const items = countUsageItems([
    ...extractEmojiUsageFromContent(message.content ?? ""),
    ...extractStickerUsageFromMessage(message),
  ]);

  for (const item of items) {
    await incrementStampUsage(ctx, message.guildId, message.author.id, item, item.count);
  }
}

export async function trackStampReaction(
  reaction: MessageReaction | PartialMessageReaction,
  user: User,
  ctx: BotContext,
): Promise<void> {
  if (user.bot || !reaction.message.guildId) return;
  const guildId = reaction.message.guildId;
  const full = reaction.partial ? await reaction.fetch().catch(() => null) : reaction;
  if (!full) return;
  const emoji = full.emoji;
  const emojiId = emoji.id ?? `u:${emoji.name ?? "?"}`;
  const emojiName = emoji.name ?? "?";

  await incrementStampUsage(ctx, guildId, user.id, { id: emojiId, name: emojiName });
}
