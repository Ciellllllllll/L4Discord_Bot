import {
  type Message,
  type MessageReaction,
  type PartialMessageReaction,
  PermissionFlagsBits,
  type User,
} from "discord.js";
import type { BotContext } from "../../bot/context.js";
import { getGuildSettingsData } from "../../core/guildSettings.js";

const CUSTOM_EMOJI = /<a?:\w+:\d+>/;
// レビューで方針が揺れたため、以下の明示的な許可リスト方式で絵文字判定を確定した:
// (a) \p{Emoji_Presentation}（U+FE0E が後続しても検出）
// (b) \p{Emoji} + U+FE0F
// (c) ZWJ 連結シーケンス
// (d) キーキャップ（[#*0-9]\uFE0F?\u20E3）
// (e) 国旗（Regional Indicator 2文字）
// (f) スキントーン修飾子付きの文字
// (g) 未割り当ての Extended_Pictographic（\p{Cn}、将来の絵文字対策）
// (h) Discord が絵文字表示する頻出のテキスト既定文字（許可リスト。U+FE0E が後続する場合は除外）
// それ以外の Emoji_Presentation=No の文字（© ® ™ ‼ ⁉ ℹ ↔ 〰 〽 ㊗ ㊙ ⌨ ♀ ♂ ♨ 等）は U+FE0F が付かない限り検出しない。
const EMOJI_ZWJ_PART = String.raw`(?=\p{Emoji}|\p{Cn})\p{Extended_Pictographic}(?:\p{Emoji_Modifier})?\uFE0F?`;
const DISCORD_TEXT_DEFAULT_EMOJI_ALLOWLIST =
  String.raw`[\u2764\u2665\u2660\u2663\u2666\u2714\u270C\u263A\u2600\u25B6\u25C0\u2B06\u2B07\u2B05\u27A1\u2709]`;
const UNICODE_EMOJI = new RegExp(
  [
    String.raw`\p{Regional_Indicator}{2}`,
    String.raw`[#*0-9]\uFE0F?\u20E3`,
    String.raw`${EMOJI_ZWJ_PART}(?:\u200D${EMOJI_ZWJ_PART})+`,
    String.raw`\p{Emoji}\p{Emoji_Modifier}`,
    String.raw`\p{Emoji}\uFE0F`,
    String.raw`\p{Emoji_Presentation}`,
    String.raw`(?=\p{Cn})\p{Extended_Pictographic}`,
    String.raw`${DISCORD_TEXT_DEFAULT_EMOJI_ALLOWLIST}(?!\uFE0E)`,
  ].join("|"),
  "u",
);

export function messageContainsEmoji(content: string): boolean {
  return CUSTOM_EMOJI.test(content) || UNICODE_EMOJI.test(content);
}

async function isRestricted(ctx: BotContext, guildId: string, userId: string): Promise<boolean> {
  const s = await getGuildSettingsData(ctx.db, guildId);
  return Boolean(s.emoji_restricted_user_ids?.includes(userId));
}

function channelExcluded(settings: Awaited<ReturnType<typeof getGuildSettingsData>>, channelId: string): boolean {
  return Boolean(settings.auto_reply_excluded_channel_ids?.includes(channelId));
}

export async function handleEmojiGuardMessage(message: Message, ctx: BotContext): Promise<void> {
  if (!message.guildId || message.author.bot) return;
  if (!(await isRestricted(ctx, message.guildId, message.author.id))) return;
  const s = await getGuildSettingsData(ctx.db, message.guildId);
  if (channelExcluded(s, message.channelId)) return;
  if (!messageContainsEmoji(message.content)) return;
  const me = message.guild?.members.me;
  if (!me?.permissionsIn(message.channelId).has(PermissionFlagsBits.ManageMessages)) return;
  await message.delete().catch(() => undefined);
}

export async function handleEmojiGuardReaction(
  reaction: MessageReaction | PartialMessageReaction,
  user: User,
  ctx: BotContext,
): Promise<void> {
  if (user.bot) return;
  const full = reaction.partial ? await reaction.fetch().catch(() => null) : reaction;
  if (!full?.message.guildId) return;
  const guildId = full.message.guildId;
  if (!(await isRestricted(ctx, guildId, user.id))) return;
  const s = await getGuildSettingsData(ctx.db, guildId);
  if (channelExcluded(s, full.message.channelId)) return;
  const me = full.message.guild?.members.me;
  if (!me?.permissionsIn(full.message.channelId).has(PermissionFlagsBits.ManageMessages)) return;
  await full.users.remove(user.id).catch(() => undefined);
}
