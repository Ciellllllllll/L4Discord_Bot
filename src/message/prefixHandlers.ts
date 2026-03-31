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
  if (message.author.bot) return false;
  if (!message.guildId || message.guildId !== ctx.config.GUILD_ID) return false;
  const raw = message.content.trim();
  if (!raw.startsWith(PREFIX)) return false;
  const without = raw.slice(PREFIX.length).trim();
  const [cmd, ..._rest] = without.split(/\s+/);
  const lower = cmd.toLowerCase();

  if (lower === "setup") {
    if (!isVersionAllowed(ctx.config.BOT_VERSION, SETUP_INTRODUCED)) {
      await message.reply(versionBlockedMessage());
      ctx.log.info({ command: "setup", userId: message.author.id, outcome: "version_blocked" }, "prefix command");
      return true;
    }
    if (!isOwner(message.author.id, ctx.config)) {
      await message.reply("OWNER専用です。");
      ctx.log.info({ command: "setup", userId: message.author.id, outcome: "not_owner" }, "prefix command");
      return true;
    }
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("panels:setupHub:main").setLabel("Setupを開く").setStyle(ButtonStyle.Primary),
    );
    await message.reply({ content: "管理用セットアップ:", components: [row] });
    ctx.log.info({ command: "setup", userId: message.author.id, outcome: "hub_sent" }, "prefix command");
    return true;
  }

  if (["start", "kill", "guard", "see"].includes(lower)) {
    if (!isVersionAllowed(ctx.config.BOT_VERSION, WOLF_INTRODUCED)) {
      await message.reply(versionBlockedMessage());
      ctx.log.info({ command: lower, userId: message.author.id, outcome: "version_blocked" }, "prefix command");
      return true;
    }
    await message.reply("人狼コマンドは準備中です。");
    ctx.log.info({ command: lower, userId: message.author.id, outcome: "stub" }, "prefix command");
    return true;
  }

  if (lower === "reply") {
    if (!isVersionAllowed(ctx.config.BOT_VERSION, REPLY_INTRODUCED)) {
      await message.reply(versionBlockedMessage());
      ctx.log.info({ command: "reply", userId: message.author.id, outcome: "version_blocked" }, "prefix command");
      return true;
    }
    let member = message.member as GuildMember | null;
    if (!member && message.guildId) {
      const g =
        message.guild ?? (await ctx.client.guilds.fetch(message.guildId).catch(() => null));
      member = g ? await g.members.fetch(message.author.id).catch(() => null) : null;
    }
    if (!member?.permissions.has(PermissionFlagsBits.ManageMessages)) {
      await message.reply("権限がありません。");
      ctx.log.info({ command: "reply", userId: message.author.id, outcome: "no_permission" }, "prefix command");
      return true;
    }
    await message.reply("Modmail返信予約は準備中です。");
    ctx.log.info({ command: "reply", userId: message.author.id, outcome: "stub" }, "prefix command");
    return true;
  }

  return false;
}
