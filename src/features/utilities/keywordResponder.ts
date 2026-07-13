import type { Message } from "discord.js";
import type { BotContext } from "../../bot/context.js";
import { getGuildSettingsData } from "../../core/guildSettings.js";
import { looksLikePrefixCommandLine } from "../../message/commandLike.js";

// メッセージ本文に含まれていれば反応する語

const TRIGGER = "ばっちぃ";

// 返信本文

const REPLY = "ぱっちぃ君だよ！！！！";

export class KeywordResponder {
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
    const settings = await getGuildSettingsData(this.ctx.db, message.guild.id);
    if (settings.auto_reply_excluded_channel_ids?.includes(message.channelId)) {
      return;
    }

    const content = String(message.content || "");
    if (!content) {
      return;
    }

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
