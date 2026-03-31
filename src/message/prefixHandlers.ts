import type { Message } from "discord.js";
import type { BotContext } from "../bot/context.js";
import { BOT_SEMVER, PREFIX_COMMAND_MIN_BOT_VERSION } from "../core/releaseVersions.js";
import { isOwner } from "../core/permission.js";
import { isVersionAllowed, versionBlockedMessage } from "../core/semverGate.js";
import { buildSetupEntryButtonRow } from "../features/panels/setupWizard.js";

const PREFIX = "!";

export async function handlePrefixMessage(message: Message, ctx: BotContext): Promise<boolean> {
  if (message.author.bot) return false;
  if (!message.guildId || message.guildId !== ctx.config.GUILD_ID) return false;
  const raw = message.content.trim();
  if (!raw.startsWith(PREFIX)) return false;
  const without = raw.slice(PREFIX.length).trim();
  const [cmd, ..._rest] = without.split(/\s+/);
  const lower = cmd.toLowerCase();
  const botVersion = ctx.config.BOT_VERSION ?? BOT_SEMVER;

  if (lower === "setup") {
    if (!isVersionAllowed(botVersion, PREFIX_COMMAND_MIN_BOT_VERSION.setup ?? "0.0.0")) {
      await message.reply(versionBlockedMessage());
      ctx.log.info({ command: "setup", userId: message.author.id, outcome: "version_blocked" }, "prefix command");
      return true;
    }
    if (!isOwner(message.author.id, ctx.config)) {
      await message.reply("OWNER専用です。");
      ctx.log.info({ command: "setup", userId: message.author.id, outcome: "not_owner" }, "prefix command");
      return true;
    }
    if (!message.guildId) {
      await message.reply("ギルド内でのみ実行できます。");
      return true;
    }
    await message.reply({
      content:
        "**OWNER向け:** **ADMIN 用**（メッセージログ・リアクションロール管理など）と **USER 用**（VC作成・Modmail/チケットなど）の送信先チャンネルを設定するには、下のボタンから続行してください。",
      components: [buildSetupEntryButtonRow()],
    });
    ctx.log.info({ command: "setup", userId: message.author.id, outcome: "setup_prompt_sent" }, "prefix command");
    return true;
  }

  if (["start", "kill", "guard", "see"].includes(lower)) {
    if (!isVersionAllowed(botVersion, PREFIX_COMMAND_MIN_BOT_VERSION[lower] ?? "0.0.0")) {
      await message.reply(versionBlockedMessage());
      ctx.log.info({ command: lower, userId: message.author.id, outcome: "version_blocked" }, "prefix command");
      return true;
    }
    await message.reply("人狼コマンドは準備中です。");
    ctx.log.info({ command: lower, userId: message.author.id, outcome: "stub" }, "prefix command");
    return true;
  }

  if (lower === "reply") {
    if (!isVersionAllowed(botVersion, PREFIX_COMMAND_MIN_BOT_VERSION.reply ?? "0.0.0")) {
      await message.reply(versionBlockedMessage());
      ctx.log.info({ command: "reply", userId: message.author.id, outcome: "version_blocked" }, "prefix command");
      return true;
    }
    if (!message.channel?.isThread()) {
      await message.reply("Modmail の !reply はチケットスレッド内でのみ使用できます。");
      ctx.log.info({ command: "reply", userId: message.author.id, outcome: "not_thread" }, "prefix command");
      return true;
    }
    /** スレッド内は messageCreate で Modmail 処理済み。ここには通常届かない。 */
    ctx.log.debug({ command: "reply", userId: message.author.id }, "prefix !reply after thread handler");
    return true;
  }

  return false;
}
