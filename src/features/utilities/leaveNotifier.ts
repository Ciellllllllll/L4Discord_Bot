import { CyclicQuoteError, type ExpansionReply } from "../linkPreviews/shared/linkExpansionTracker.js";
import { ComponentCardBuilder, componentCardsPayload, type ComponentCardsPayload } from "../../core/componentCard.js";
import {
  ChannelType,
  ComponentType,
  PermissionFlagsBits,
  type APIEmbed,
  type APIMessageComponent,
  type APIMessageTopLevelComponent,
  type APIUnfurledMediaItem,
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

function isMissingQuoteResource(error: unknown): boolean {
  return [10003, 10004, 10007, 10008, 10013].includes(Number((error as { code?: unknown })?.code));
}

function ignoreMissingQuoteResource(error: unknown): null {
  if (isMissingQuoteResource(error)) return null;
  throw error;
}

// メンバー退出通知は `MOD_LOG_CHANNEL_ID`（.env）のみへ送信

type MessageLinkExpansionPayload = ComponentCardsPayload & {
  allowedMentions: { parse: []; repliedUser: false };
};

function truncateText(value: string | null | undefined, max: number): string | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function quoteMediaUrl(media: APIUnfurledMediaItem, message: Message): string | null {
  const attachment = media.url.startsWith("attachment://")
    ? message.attachments.get(media.attachment_id ?? "") ??
      message.attachments.find((item) => item.name === media.url.slice("attachment://".length))
    : null;
  try {
    const url = new URL(attachment?.url ?? (media.url.startsWith("attachment://") ? media.proxy_url ?? "" : media.url));
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function copyQuoteComponents(
  components: readonly APIMessageComponent[],
  message: Message,
  budget = { components: 40, text: 4000 },
): APIMessageTopLevelComponent[] {
  const copied: APIMessageTopLevelComponent[] = [];
  for (const component of components) {
    if (budget.components <= 0) break;
    switch (component.type) {
      case ComponentType.TextDisplay: {
        const content = budget.text > 0 ? truncateText(component.content, budget.text) : null;
        if (!content) break;
        budget.components--;
        budget.text -= content.length;
        copied.push({ type: ComponentType.TextDisplay, content });
        break;
      }
      case ComponentType.Container: {
        budget.components--;
        const children = copyQuoteComponents(component.components, message, budget)
          .filter((child) => child.type !== ComponentType.Container);
        if (children.length) {
          copied.push({ type: ComponentType.Container, spoiler: component.spoiler, components: children });
        } else {
          budget.components++;
        }
        break;
      }
      case ComponentType.Section: {
        const thumbnail = component.accessory.type === ComponentType.Thumbnail ? component.accessory : null;
        const url = thumbnail ? quoteMediaUrl(thumbnail.media, message) : null;
        const withThumbnail = url && budget.components >= 3;
        if (withThumbnail) budget.components -= 2;
        const children = copyQuoteComponents(component.components, message, budget)
          .filter((child) => child.type === ComponentType.TextDisplay);
        if (withThumbnail && children.length) {
          copied.push({
            type: ComponentType.Section,
            components: children,
            accessory: { type: ComponentType.Thumbnail, media: { url }, description: thumbnail?.description, spoiler: thumbnail?.spoiler },
          });
        } else {
          if (withThumbnail) budget.components += 2;
          copied.push(...children);
        }
        break;
      }
      case ComponentType.MediaGallery: {
        const items = component.items.flatMap((item) => {
          const url = quoteMediaUrl(item.media, message);
          return url ? [{ media: { url }, description: item.description, spoiler: item.spoiler }] : [];
        });
        if (items.length) {
          budget.components--;
          copied.push({ type: ComponentType.MediaGallery, items });
        }
        break;
      }
      case ComponentType.File: {
        const url = quoteMediaUrl(component.file, message);
        if (!url) break;
        // File components require a new upload; quote the original attachment URL instead.
        const content = component.spoiler ? `||<${url}>||` : `<${url}>`;
        if (content.length > budget.text) break;
        budget.components--;
        budget.text -= content.length;
        copied.push({ type: ComponentType.TextDisplay, content });
        break;
      }
      case ComponentType.Separator:
        budget.components--;
        copied.push({ type: ComponentType.Separator, divider: component.divider, spacing: component.spacing });
        break;
    }
  }
  return copied;
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
    .setURL(targetMessage.url)
    .setTimestamp(targetMessage.createdAt)
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
  } else if (targetMessage.embeds.length === 0 && targetMessage.attachments.size === 0 && targetMessage.components.length === 0) {
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

  const payload = componentCardsPayload(cards);
  return {
    ...payload,
    components: copyQuoteComponents([
      ...payload.components,
      ...targetMessage.components.map((component) => component.toJSON()),
    ], targetMessage),
    allowedMentions: { parse: [], repliedUser: false },
  };
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
    .setThumbnail(member.displayAvatarURL());

  await channel.send({ ...componentCardsPayload([embed]) }).catch((err: unknown) => {
    ctx.log.warn({ err: String(err) }, "leave notifier channel.send failed");
  });
}

export class LeaveNotifierMessageHandler {
  constructor(private readonly ctx: BotContext, private readonly replyExpansion?: ExpansionReply) {}

  hasLinks(message: Message): boolean {
    return Boolean(message.guildId && !message.author?.bot && !looksLikePrefixCommandLine(message.content)
      && message.content.match(MESSAGE_LINK_RE)?.length);
  }

  async onMessage(message: Message): Promise<void> {
    if (message.author?.bot) {
      return;
    }
    if (!message.guild) {
      return;
    }
    if (looksLikePrefixCommandLine(message.content)) {
      return;
    }
    const matches = [...String(message.content || "").matchAll(MESSAGE_LINK_RE)];
    if (matches.length === 0) return;

    const s = await getGuildSettingsData(this.ctx.db, message.guild.id);
    if (s.auto_reply_excluded_channel_ids?.includes(message.channelId)) {
      return;
    }

    for (const [index, m] of matches.entries()) {
      const guildId = m[1]!;
      const channelId = m[2]!;
      const messageId = m[3]!;
      const sourceGuild = this.ctx.client.guilds.cache.get(guildId);
      if (!sourceGuild) continue;
      try {
        const fetchedChannel = await this.ctx.client.channels.fetch(channelId);
        if (!fetchedChannel?.isTextBased() || fetchedChannel.isDMBased() || fetchedChannel.guildId !== guildId) {
          continue;
        }
        const sourceMember = await sourceGuild.members.fetch(message.author.id).catch(ignoreMissingQuoteResource);
        if (!sourceMember) continue;
        const sourcePerms = fetchedChannel.permissionsFor(sourceMember);
        if (!sourcePerms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) {
          continue;
        }
        if (fetchedChannel.type === ChannelType.PrivateThread && !sourcePerms.has(PermissionFlagsBits.ManageThreads)) {
          const threadMember = await fetchedChannel.members.fetch(sourceMember.id).catch(ignoreMissingQuoteResource);
          if (!threadMember) continue;
        }
        const botMember = sourceGuild.members.me ?? await sourceGuild.members.fetchMe();
        if (!fetchedChannel.permissionsFor(botMember)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) {
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
        if (this.replyExpansion) await this.replyExpansion(message, `discord:${index}`, payload, targetMessage);
        else await replyCh.send(payload);
      } catch (err) {
        this.ctx.log.warn({ err: String(err) }, "message link fetch failed");
        if (this.replyExpansion && !(err instanceof CyclicQuoteError) && !isMissingQuoteResource(err)) throw err;
      }
    }
  }
}
