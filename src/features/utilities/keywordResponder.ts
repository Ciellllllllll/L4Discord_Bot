import type { Message } from "discord.js";
import type { CoreDeps } from "../../core/deps.js";
import { getGuildSettingsData } from "../../core/guildSettings.js";
import { looksLikePrefixCommandLine } from "../../core/commandLike.js";
import { parseGifAutoReplySetting } from "./gifAutoReply.js";

// KeywordResponder が使う依存。
type KeywordResponderDeps = Pick<CoreDeps, "config" | "db" | "log" | "client">;

// メッセージ本文に含まれていれば反応する語

const TRIGGER = "ばっちぃ";

// 返信本文

const REPLY = "ぱっちぃ君だよ！！！！";

function hasConfiguredGif(message: Message, triggerUrl: string): boolean {
  const contentMatch = String(message.content || "")
    .split(/[\s\u3000]+/)
    .some((token) => token === triggerUrl || token === `<${triggerUrl}>`);
  const attachmentMatch = message.attachments.some(
    (attachment) => attachment.url === triggerUrl || attachment.proxyURL === triggerUrl,
  );
  const embedMatch = message.embeds.some(
    (embed) => embed.data.type === "gifv" && embed.url === triggerUrl,
  );
  return contentMatch || attachmentMatch || embedMatch;
}

export class KeywordResponder {
  constructor(private readonly ctx: KeywordResponderDeps) {}

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
    const settings = await getGuildSettingsData(this.ctx.db, message.guild.id);
    if (settings.auto_reply_excluded_channel_ids?.includes(message.channelId)) {
      return;
    }

    const gifSetting = parseGifAutoReplySetting(settings.gif_auto_reply);
    if (gifSetting && hasConfiguredGif(message, gifSetting.trigger_url)) {
      try {
        await message.reply({ content: gifSetting.response_url, allowedMentions: { parse: [], repliedUser: false } });
      } catch (err) {
        this.ctx.log.warn({ err: String(err) }, "KeywordResponder GIF reply failed");
      }
      return;
    }

    const content = String(message.content || "");
    if (!content.includes(TRIGGER)) {
      return;
    }

    try {
      await message.reply({ content: REPLY, allowedMentions: { repliedUser: false } });
    } catch (err) {
      this.ctx.log.warn({ err: String(err) }, "KeywordResponder reply failed");
    }
  }
}
