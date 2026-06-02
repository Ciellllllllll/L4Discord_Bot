import type { Message } from "discord.js";
import type { BotContext } from "../bot/context.js";
import { BOT_SEMVER, PREFIX_COMMAND_MIN_BOT_VERSION } from "../core/releaseVersions.js";
import { isAdmin, isOwner } from "../core/permission.js";
import { isVersionAllowed, versionBlockedMessage } from "../core/semverGate.js";
import { buildSetupEntryButtonRow } from "../features/panels/setupWizard.js";
import { reloadPanelsFromGuildSettings } from "../features/panels/panelService.js";
import { runNologToggleAndBuildEmbed } from "../features/messageLog/messageLogNolog.js";
import { handlePacchiPrefixMessage } from "../features/pacchi/pacchi.prefix.js";

const PREFIX = "!";

function isPrefixVersionAllowed(ctx: BotContext, botVersion: string, command: string): boolean {
  if (ctx.config.BOT_PROFILE === "debug") return true;
  return isVersionAllowed(botVersion, PREFIX_COMMAND_MIN_BOT_VERSION[command] ?? "0.0.0");
}

export async function handlePrefixMessage(message: Message, ctx: BotContext): Promise<boolean> {
  if (message.author.bot) return false;
  if (!message.guildId || message.guildId !== ctx.config.GUILD_ID) return false;
  const raw = message.content.trim();
  if (!raw.startsWith(PREFIX)) return false;
  const without = raw.slice(PREFIX.length).trim();
  const [cmd, ..._rest] = without.split(/\s+/);
  const lower = cmd.toLowerCase();
  const args = _rest;
  const botVersion = ctx.config.BOT_VERSION ?? BOT_SEMVER;

  if (lower.startsWith("pacchi_")) {
    if (!isPrefixVersionAllowed(ctx, botVersion, lower)) {
      await message.reply(versionBlockedMessage());
      ctx.log.info({ command: lower, userId: message.author.id, outcome: "version_blocked" }, "prefix command");
      return true;
    }
    return await handlePacchiPrefixMessage(message, ctx, lower, args);
  }

  if (lower === "setup") {
    if (!isPrefixVersionAllowed(ctx, botVersion, "setup")) {
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
        "**OWNER向け:** **ADMIN 用**（メッセージログ・リアクションロール管理など）、**VC 用**（仮チャンネル作成）、**Modmail 用**（お問い合わせ）の送信先をそれぞれ選ぶには、下のボタンから続行してください。",
      components: [buildSetupEntryButtonRow()],
    });
    ctx.log.info({ command: "setup", userId: message.author.id, outcome: "setup_prompt_sent" }, "prefix command");
    return true;
  }

  if (lower === "nolog") {
    if (!isPrefixVersionAllowed(ctx, botVersion, "nolog")) {
      await message.reply(versionBlockedMessage());
      ctx.log.info({ command: "nolog", userId: message.author.id, outcome: "version_blocked" }, "prefix command");
      return true;
    }
    if (!message.guildId || !message.channelId) {
      await message.reply("ギルド内のチャンネルでのみ使用できます。");
      return true;
    }
    if (!message.member) {
      await message.reply("メンバー情報を取得できませんでした。");
      return true;
    }
    if (!isAdmin(message.member, ctx.config)) {
      await message.reply("このコマンドは管理者のみ使用できます。");
      ctx.log.info({ command: "nolog", userId: message.author.id, outcome: "not_admin" }, "prefix command");
      return true;
    }
    const embed = await runNologToggleAndBuildEmbed(
      ctx.db,
      message.guildId,
      message.channelId,
      message.author.id,
    );
    const ch = message.channel;
    try {
      if (ch.isTextBased() && !ch.isDMBased()) {
        await ch.send({
          embeds: [embed],
          allowedMentions: { users: [message.author.id] },
        });
      }
      await message.delete().catch((err) => {
        ctx.log.warn({ err: String(err) }, "nolog command message delete failed");
      });
    } catch (e) {
      ctx.log.warn({ err: String(e) }, "nolog embed send failed");
      await message.reply("埋め込みの送信に失敗しました。設定は反映済みの場合があります。").catch(() => undefined);
    }
    ctx.log.info({ command: "nolog", userId: message.author.id, channelId: message.channelId }, "prefix command");
    return true;
  }

  if (lower === "reload") {
    if (!isPrefixVersionAllowed(ctx, botVersion, "reload")) {
      await message.reply(versionBlockedMessage());
      ctx.log.info({ command: "reload", userId: message.author.id, outcome: "version_blocked" }, "prefix command");
      return true;
    }
    if (!isOwner(message.author.id, ctx.config)) {
      await message.reply("OWNER専用です。");
      ctx.log.info({ command: "reload", userId: message.author.id, outcome: "not_owner" }, "prefix command");
      return true;
    }
    if (!message.guildId) {
      await message.reply("ギルド内でのみ実行できます。");
      return true;
    }
    const result = await reloadPanelsFromGuildSettings(ctx, message.guildId);
    if (!result.ok && result.reason === "no_channels") {
      await message.reply("先に !Setup でパネル送信先チャンネルを設定してください。");
      ctx.log.info({ command: "reload", userId: message.author.id, outcome: "no_channels" }, "prefix command");
      return true;
    }
    await message.reply("!Setup で保存したチャンネル設定のまま、常設パネルを再同期しました。");
    ctx.log.info({ command: "reload", userId: message.author.id, outcome: "ok" }, "prefix command");
    return true;
  }

  if (["start", "kill", "guard", "see"].includes(lower)) {
    if (!isPrefixVersionAllowed(ctx, botVersion, lower)) {
      await message.reply(versionBlockedMessage());
      ctx.log.info({ command: lower, userId: message.author.id, outcome: "version_blocked" }, "prefix command");
      return true;
    }
    await message.reply("人狼コマンドは準備中です。");
    ctx.log.info({ command: lower, userId: message.author.id, outcome: "stub" }, "prefix command");
    return true;
  }

  if (lower === "reply") {
    if (!isPrefixVersionAllowed(ctx, botVersion, "reply")) {
      await message.reply(versionBlockedMessage());
      ctx.log.info({ command: "reply", userId: message.author.id, outcome: "version_blocked" }, "prefix command");
      return true;
    }
    if (!message.channel?.isThread()) {
      await message.reply("Modmail の !reply はチケットスレッド内でのみ使用できます。");
      ctx.log.info({ command: "reply", userId: message.author.id, outcome: "not_thread" }, "prefix command");
      return true;
    }
        // スレッド内は messageCreate で Modmail 処理済み。ここには通常届かない。

    ctx.log.debug({ command: "reply", userId: message.author.id }, "prefix !reply after thread handler");
    return true;
  }

  return false;
}
