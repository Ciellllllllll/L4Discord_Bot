import { EmbedBuilder, type Message } from "discord.js";
import type { BotContext } from "../bot/context.js";
import { getGuildSettingsData } from "../core/guildSettings.js";
import { sql } from "kysely";

const DISCORD_MSG =
  /https?:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/channels\/(\d+)\/(\d+)\/(\d+)/i;

function roughSenryuLines(text: string): boolean {
  const lines = text
    .trim()
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length !== 3) return false;
  const counts = lines.map((l) => [...l.replace(/\s/g, "")].length);
  return counts[0] === 5 && counts[1] === 7 && counts[2] === 5;
}

export async function handleExtendedAutoReplies(message: Message, ctx: BotContext): Promise<boolean> {
  if (!message.guild || message.author.bot) return false;
  if (message.guild.id !== ctx.config.GUILD_ID) return false;
  const s = await getGuildSettingsData(ctx.db, message.guild.id);
  if (s.auto_reply_excluded_channel_ids?.includes(message.channelId)) return false;

  const cold = (s.cold_keywords as string[] | undefined) ?? ["冷笑"];
  for (const kw of cold) {
    if (kw && message.content.includes(kw)) {
      await ctx.db
        .insertInto("keyword_stats")
        .values({
          guild_id: message.guild.id,
          user_id: message.author.id,
          keyword_key: "cold",
          count: BigInt(1),
          updated_at: new Date(),
        })
        .onConflict((oc) =>
          oc.columns(["guild_id", "user_id", "keyword_key"]).doUpdateSet({
            count: sql`keyword_stats.count + 1`,
            updated_at: new Date(),
          }),
        )
        .execute();
      const row = await ctx.db
        .selectFrom("keyword_stats")
        .select("count")
        .where("guild_id", "=", message.guild.id)
        .where("user_id", "=", message.author.id)
        .where("keyword_key", "=", "cold")
        .executeTakeFirst();
      const c = row ? String(row.count) : "1";
      await message.reply(`検知: ${kw}（あなたの累計: ${c}）`).catch(() => undefined);
      return true;
    }
  }

  const replies = (s.keyword_replies as Record<string, string> | undefined) ?? {
    ばっちい: "それな",
  };
  for (const [k, v] of Object.entries(replies)) {
    if (message.content.includes(k)) {
      await message.reply(v).catch(() => undefined);
      return true;
    }
  }

  if (roughSenryuLines(message.content)) {
    await message.reply("川柳が検出されました").catch(() => undefined);
    return true;
  }

  const m = message.content.match(DISCORD_MSG);
  if (m) {
    const [, gId, chId, msgId] = m;
    if (gId !== message.guild.id) return false;
    const ch = await message.guild.channels.fetch(chId).catch(() => null);
    if (!ch?.isTextBased()) return false;
    const src = await ch.messages.fetch(msgId).catch(() => null);
    if (!src) return false;
    const embed = new EmbedBuilder()
      .setAuthor({ name: src.author.tag, iconURL: src.author.displayAvatarURL() })
      .setDescription(src.content.slice(0, 800) || "(本文なし)")
      .setTimestamp(src.createdAt);
    if (src.attachments.size > 0) {
      const imgs = [...src.attachments.values()]
        .filter((a) => a.contentType?.startsWith("image/"))
        .slice(0, 4);
      for (const a of imgs) embed.addFields({ name: "画像", value: a.url });
    }
    await message.reply({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => undefined);
    return true;
  }

  return false;
}
