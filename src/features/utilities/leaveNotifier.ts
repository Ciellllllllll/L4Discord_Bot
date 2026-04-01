import { EmbedBuilder, type GuildMember, type Message, type PartialGuildMember } from "discord.js";
import type { BotContext } from "../../bot/context.js";
import { getGuildSettingsData } from "../../core/guildSettings.js";
import { looksLikePrefixCommandLine } from "../../message/commandLike.js";

const MESSAGE_LINK_RE =
  /https?:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/channels\/(\d+)\/(\d+)\/(\d+)/g;

/** メンバー退出通知は `MOD_LOG_CHANNEL_ID`（.env）のみへ送信 */
export async function sendMemberLeaveEmbed(
  ctx: BotContext,
  member: GuildMember | PartialGuildMember,
): Promise<void> {
  if (member.partial) {
    const loaded = await member.fetch().catch(() => null);
    if (!loaded) return;
    return sendMemberLeaveEmbed(ctx, loaded);
  }

  const chId = ctx.config.MOD_LOG_CHANNEL_ID?.trim();
  if (!chId) {
    return;
  }

  let channel = ctx.client.channels.cache.get(chId);
  if (channel === undefined) {
    const fetched = await ctx.client.channels.fetch(chId).catch(() => null);
    channel = fetched ?? undefined;
  }

  if (!channel?.isTextBased() || channel.isDMBased()) {
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle("メンバーが退出しました")
    .setDescription(
      `${member} (${member.user?.username ?? member.displayName}) がサーバーを抜けました。`,
    )
    .setColor(0xff_00_00)
    .setThumbnail(member.displayAvatarURL());

  await channel.send({ embeds: [embed] }).catch((err: unknown) => {
    ctx.log.warn({ err: String(err) }, "leave notifier channel.send failed");
  });
}

export class LeaveNotifierMessageHandler {
  constructor(private readonly ctx: BotContext) {}

  async onMessage(message: Message): Promise<void> {
    if (message.author?.bot) {
      return;
    }
    if (!message.guild || message.guild.id !== this.ctx.config.GUILD_ID) {
      return;
    }
    if (looksLikePrefixCommandLine(message.content)) {
      return;
    }
    const s = await getGuildSettingsData(this.ctx.db, message.guild.id);
    if (s.auto_reply_excluded_channel_ids?.includes(message.channelId)) {
      return;
    }

    const matches = [...String(message.content || "").matchAll(MESSAGE_LINK_RE)];
    for (const m of matches) {
      const channelId = m[2]!;
      const messageId = m[3]!;
      try {
        const fetchedChannel = await this.ctx.client.channels.fetch(channelId);
        if (!fetchedChannel?.isTextBased() || fetchedChannel.isDMBased()) {
          continue;
        }

        const targetMessage = await fetchedChannel.messages.fetch(messageId);

        const embed = new EmbedBuilder()
          .setDescription(targetMessage.content || "")
          .setTimestamp(targetMessage.createdAt)
          .setColor(0x34_98_db)
          .setAuthor({
            name:
              targetMessage.member?.displayName ??
              targetMessage.author?.username ??
              "Unknown",
            iconURL: targetMessage.author?.displayAvatarURL() ?? undefined,
          })
          .setFooter({
            text: `${"name" in fetchedChannel ? fetchedChannel.name : "channel"} による引用`,
          });

        const files: { attachment: string; name: string }[] = [];
        let firstImage = true;
        for (const attachment of targetMessage.attachments.values()) {
          const ctype = attachment.contentType || "";
          if (ctype.startsWith("image/")) {
            if (firstImage) {
              embed.setImage(attachment.url);
              firstImage = false;
            }
          } else if (ctype.startsWith("video/")) {
            files.push({ attachment: attachment.url, name: attachment.name || "video" });
          }
        }

        const replyCh = message.channel;
        if (!replyCh.isTextBased() || replyCh.isDMBased()) {
          continue;
        }
        if (files.length > 0) {
          await replyCh.send({ embeds: [embed], files });
        } else {
          await replyCh.send({ embeds: [embed] });
        }
      } catch (err) {
        this.ctx.log.warn({ err: String(err) }, "message link fetch failed");
      }
    }
  }
}
