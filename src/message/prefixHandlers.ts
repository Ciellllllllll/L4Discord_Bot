import type { Message } from "discord.js";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type GuildMember,
  PermissionFlagsBits,
} from "discord.js";
import type { BotContext } from "../bot/context.js";
import { isOwner } from "../core/permission.js";
import { isVersionAllowed, versionBlockedMessage } from "../core/semverGate.js";

const PREFIX = "!";
const SETUP_INTRODUCED = "0.1.0";
const WOLF_INTRODUCED = "0.1.0";
const REPLY_INTRODUCED = "0.1.0";

export async function handlePrefixMessage(message: Message, ctx: BotContext): Promise<boolean> {
  if (!message.guild || message.author.bot) return false;
  if (message.guild.id !== ctx.config.GUILD_ID) return false;
  const raw = message.content.trim();
  if (!raw.startsWith(PREFIX)) return false;
  const without = raw.slice(PREFIX.length).trim();
  const [cmd, ..._rest] = without.split(/\s+/);
  const lower = cmd.toLowerCase();

  if (lower === "setup") {
    if (!isVersionAllowed(ctx.config.BOT_VERSION, SETUP_INTRODUCED)) {
      await message.reply(versionBlockedMessage());
      return true;
    }
    if (!isOwner(message.author.id, ctx.config)) {
      await message.reply("OWNER専用です。");
      return true;
    }
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("panels:setupHub:main").setLabel("Setupを開く").setStyle(ButtonStyle.Primary),
    );
    await message.reply({ content: "管理用セットアップ:", components: [row] });
    return true;
  }

  if (["start", "kill", "guard", "see"].includes(lower)) {
    if (!isVersionAllowed(ctx.config.BOT_VERSION, WOLF_INTRODUCED)) {
      await message.reply(versionBlockedMessage());
      return true;
    }
    await message.reply("人狼コマンドは準備中です。");
    return true;
  }

  if (lower === "reply") {
    if (!isVersionAllowed(ctx.config.BOT_VERSION, REPLY_INTRODUCED)) {
      await message.reply(versionBlockedMessage());
      return true;
    }
    const member = message.member as GuildMember | null;
    if (!member?.permissions.has(PermissionFlagsBits.ManageMessages)) {
      await message.reply("権限がありません。");
      return true;
    }
    await message.reply("Modmail返信予約は準備中です。");
    return true;
  }

  return false;
}
