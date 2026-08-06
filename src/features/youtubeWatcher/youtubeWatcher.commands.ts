import { MessageFlags, type ChatInputCommandInteraction, type GuildMember } from "discord.js";
import type { BotContext } from "../../bot/context.js";
import { isAdmin } from "../../core/permission.js";
import { parseYouTubeChannelUrl } from "./youtubeRss.js";
import { PostgresYouTubeWatcherRepository } from "./youtubeWatcher.repository.js";
import { scanYouTubeWatcher, youtubeSubscriptionSummary } from "./youtubeWatcher.watcher.js";

function allowed(interaction: ChatInputCommandInteraction, ctx: BotContext, member: GuildMember | null): boolean {
  if (member && isAdmin(member, ctx.config)) return true;
  void interaction.reply({ content: "この操作には管理者権限が必要です。", flags: MessageFlags.Ephemeral });
  return false;
}

export async function handleAdhdCommand(interaction: ChatInputCommandInteraction, ctx: BotContext, member: GuildMember | null): Promise<void> {
  if (!allowed(interaction, ctx, member)) return;
  const subcommand = interaction.options.getSubcommand(true);
  const repo = new PostgresYouTubeWatcherRepository(ctx.mainPgPool);
  if (subcommand === "list") {
    const subscriptions = await repo.list(interaction.guildId!);
    await interaction.reply({ content: subscriptions.length ? subscriptions.map(youtubeSubscriptionSummary).join("\n\n").slice(0, 1900) : "YouTube監視は登録されていません。", flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    return;
  }
  if (subcommand === "scan_now") {
    await interaction.deferReply({ ephemeral: true });
    await scanYouTubeWatcher(ctx);
    await interaction.editReply("YouTube監視を実行しました。");
    return;
  }
  const parsed = parseYouTubeChannelUrl(interaction.options.getString("url", true));
  if (!parsed) {
    await interaction.reply({ content: "`https://www.youtube.com/channel/UC…` 形式のチャンネルURLを指定してください。", flags: MessageFlags.Ephemeral });
    return;
  }
  if (subcommand === "remove") {
    const removed = await repo.disable(interaction.guildId!, parsed.channelId, interaction.channelId);
    await interaction.reply({ content: removed ? "この場所へのYouTube通知を停止しました。" : "この場所には該当するYouTube監視がありません。", flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  await repo.add({ guildId: interaction.guildId!, youtubeChannelId: parsed.channelId, sourceUrl: parsed.canonicalUrl, discordChannelId: interaction.channelId });
  await scanYouTubeWatcher(ctx);
  await interaction.editReply("YouTube監視を登録しました。取得できる既存投稿もこの場所へ通知しました。");
}
