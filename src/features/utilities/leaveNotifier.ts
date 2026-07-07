import { ComponentCardBuilder, componentCardsPayload } from "../panels/componentCard.js";
import {
  PermissionFlagsBits,
  type APIEmbed,
  type GuildMember,
  type Message,
  type PartialGuildMember,
} from "discord.js";
import type { BotContext } from "../../bot/context.js";
import { getGuildSettingsData } from "../../core/guildSettings.js";
import { looksLikePrefixCommandLine } from "../../message/commandLike.js";

const MESSAGE_LINK_RE =
  /https?:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/channels\/(\d+)\/(\d+)\/(\d+)/g;
const MAX_EXPANDED_EMBEDS = 10;

// メンバー退出通知は `MOD_LOG_CHANNEL_ID`（.env）のみへ送信

type MessageLinkExpansionPayload = {
  cards: ComponentCardBuilder[];
  files: [];
};

function truncateText(value: string | null | undefined, max: number): string | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function copyMessageEmbed(raw: APIEmbed): ComponentCardBuilder | null {
  const embed = new ComponentCardBuilder();
  let used = false;

  const title = truncateText(raw.title, 256);
  if (title) {
    embed.setTitle(title);
    used = true;
  }
  if (raw.url) embed.setURL(raw.url);

  const description = truncateText(raw.description, 4096);
  if (description) {
    embed.setDescription(description);
    used = true;
  }

  if (typeof raw.color === "number") embed.setColor(raw.color);
  if (raw.timestamp) embed.setTimestamp(new Date(raw.timestamp));
  if (raw.image?.url) {
    embed.setImage(raw.image.url);
    used = true;
  }
  if (raw.thumbnail?.url) {
    embed.setThumbnail(raw.thumbnail.url);
    used = true;
  }
  if (raw.author?.name) {
    embed.setAuthor({
      name: truncateText(raw.author.name, 256) ?? raw.author.name,
      iconURL: raw.author.icon_url,
      url: raw.author.url,
    });
    used = true;
  }
  if (raw.footer?.text) {
    embed.setFooter({
      text: truncateText(raw.footer.text, 2048) ?? raw.footer.text,
      iconURL: raw.footer.icon_url,
    });
    used = true;
  }
  if (Array.isArray(raw.fields) && raw.fields.length > 0) {
    embed.addFields(raw.fields.slice(0, 25).map((field) => ({
      name: truncateText(field.name, 256) ?? "-",
      value: truncateText(field.value, 1024) ?? "-",
      inline: field.inline,
    })));
    used = true;
  }

  return used ? embed : null;
}

function buildMessageLinkHeaderEmbed(targetMessage: Message, channelName: string): ComponentCardBuilder {
  const content = truncateText(targetMessage.content, 4096);
  const embed = new ComponentCardBuilder()
    .setTimestamp(targetMessage.createdAt)
    .setColor(0x34_98_db)
    .setAuthor({
      name:
        targetMessage.member?.displayName ??
        targetMessage.author?.username ??
        "Unknown",
      iconURL: targetMessage.author?.displayAvatarURL() ?? undefined,
    })
    .setFooter({ text: `${channelName || "channel"} による引用` });

  if (content) {
    embed.setDescription(content);
  } else if (targetMessage.embeds.length === 0 && targetMessage.attachments.size === 0) {
    embed.setDescription("(本文なし)");
  }

  return embed;
}

export function buildMessageLinkExpansionPayload(
  targetMessage: Message,
  channelName: string,
): MessageLinkExpansionPayload {
  const cards: ComponentCardBuilder[] = [];
  cards.push(buildMessageLinkHeaderEmbed(targetMessage, channelName));

  for (const sourceEmbed of targetMessage.embeds) {
    if (cards.length >= MAX_EXPANDED_EMBEDS) break;
    const copied = copyMessageEmbed(sourceEmbed.toJSON());
    if (copied) cards.push(copied);
  }

  return { cards, files: [] };
}

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

  const embed = new ComponentCardBuilder()
    .setTitle("メンバーが退出しました")
    .setDescription(
      `${member} (${member.user?.username ?? member.displayName}) がサーバーを抜けました。`,
    )
    .setColor(0xff_00_00)
    .setThumbnail(member.displayAvatarURL());

  await channel.send({ ...componentCardsPayload([embed]) }).catch((err: unknown) => {
    ctx.log.warn({ err: String(err) }, "leave notifier channel.send failed");
  });
}

export class LeaveNotifierMessageHandler {
  constructor(private readonly ctx: BotContext) {}

  async onMessage(message: Message): Promise<void> {
    const isOwnBotMessage = message.author?.id === this.ctx.client.user?.id;
    if (message.author?.bot && !isOwnBotMessage) {
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
      if (channelId !== message.channelId) {
        continue;
      }
      try {
        const fetchedChannel = await this.ctx.client.channels.fetch(channelId);
        if (!fetchedChannel?.isTextBased() || fetchedChannel.isDMBased()) {
          continue;
        }
        const sourcePerms = "permissionsFor" in fetchedChannel
          ? fetchedChannel.permissionsFor(message.member ?? message.author)
          : null;
        if (!sourcePerms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) {
          continue;
        }

        const targetMessage = await fetchedChannel.messages.fetch(messageId);

        const payload = buildMessageLinkExpansionPayload(
          targetMessage,
          "name" in fetchedChannel ? fetchedChannel.name : "channel",
        );

        const replyCh = message.channel;
        if (!replyCh.isTextBased() || replyCh.isDMBased()) {
          continue;
        }
        if (payload.cards.length === 0) {
          continue;
        }
        await replyCh.send(componentCardsPayload(payload.cards));
      } catch (err) {
        this.ctx.log.warn({ err: String(err) }, "message link fetch failed");
      }
    }
  }
}
