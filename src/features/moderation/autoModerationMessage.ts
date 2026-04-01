import { PermissionFlagsBits, type Message } from "discord.js";
import type { BotContext } from "../../bot/context.js";
import { getMergedAutoModSettings } from "./autoModerationSettings.js";
import type { AutoModSettings } from "./autoModerationTypes.js";

const userMessageTimes = new Map<string, number[]>();

function parseMessageTokens(content: string): { links: string[]; hasInvite: boolean } {
  const text = String(content || "");
  const links = [...text.matchAll(/https?:\/\/\S+/gi)].map((m) => m[0]!);
  const hasInvite = /discord\.gg\//i.test(text) || /discord\.com\/invite\//i.test(text);
  return { links, hasInvite };
}

function trackSpam(guildId: string, userId: string): number[] {
  const key = `${guildId}:${userId}`;
  const now = Date.now();
  if (!userMessageTimes.has(key)) {
    userMessageTimes.set(key, []);
  }
  const arr = userMessageTimes.get(key)!;
  arr.push(now);
  return arr;
}

async function handleViolation(message: Message, reason: string, settings: AutoModSettings, ctx: BotContext): Promise<void> {
  await message.delete().catch(() => undefined);

  if (settings.timeoutSec > 0 && message.member?.moderatable) {
    await message.member.timeout(settings.timeoutSec * 1000, reason).catch(() => undefined);
  }

  const replyCh = message.channel;
  const notice =
    replyCh.isTextBased() && !replyCh.isDMBased()
      ? await replyCh
          .send({
            content: `${message.author} AutoMod: ${reason}`,
            allowedMentions: { parse: [] },
          })
          .catch(() => null)
      : null;

  if (notice) {
    setTimeout(() => void notice.delete().catch(() => undefined), 8000);
  }

  const logId = settings.modlogChannelId.trim();
  if (logId && /^\d+$/.test(logId)) {
    const ch =
      ctx.client.channels.cache.get(logId) ?? (await ctx.client.channels.fetch(logId).catch(() => null));
    if (ch?.isTextBased() && !ch.isDMBased()) {
      await ch
        .send({
          content: `[AutoMod] ${message.author.tag} (${message.author.id}) - ${reason}\nmessage: ${String(message.content || "").slice(0, 1000)}`,
        })
        .catch(() => undefined);
    }
  }
}

/** ギルドメッセージの自動モデレーション（DiscordBOTv2 AutoModeration.js と同順序） */
export async function handleAutoModerationMessage(message: Message, ctx: BotContext): Promise<void> {
  if (!message.guild || message.author.bot) return;
  if (message.guild.id !== ctx.config.GUILD_ID) return;

  const settings = await getMergedAutoModSettings(ctx, message.guild.id);
  if (!settings.enabled) return;

  if (message.member?.permissions.has(PermissionFlagsBits.ManageMessages)) return;

  const { links, hasInvite } = parseMessageTokens(message.content);

  if (settings.inviteBlock && hasInvite) {
    await handleViolation(message, "Invite link blocked by AutoMod", settings, ctx);
    return;
  }

  if (settings.linkBlock && links.length > 0) {
    await handleViolation(message, "External link blocked by AutoMod", settings, ctx);
    return;
  }

  if (settings.spamBlock) {
    const times = trackSpam(message.guild.id, message.author.id);
    const cutoff = Date.now() - settings.spamWindowSec * 1000;
    while (times.length > 0 && times[0]! < cutoff) {
      times.shift();
    }

    if (times.length >= settings.spamThreshold) {
      await handleViolation(
        message,
        `Spam detected (${times.length}/${settings.spamThreshold})`,
        settings,
        ctx,
      );
      times.length = 0;
    }
  }
}
