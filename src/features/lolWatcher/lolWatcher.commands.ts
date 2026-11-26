import { MessageFlags, type ChatInputCommandInteraction, type GuildMember } from "discord.js";
import type { CoreDeps } from "../../core/deps.js";
import { isAdmin } from "../../core/permission.js";
import { createLolWatcherRepository } from "./lolWatcher.repository.js";
import { getLolWatcherController, scanLolWatcher, validateAndPrepareLolWatcher } from "./lolWatcher.watcher.js";
import { normalizeLolWatcherAccountKey, parseRiotId } from "./lolWatcher.types.js";

function scanSummary(result: Awaited<ReturnType<typeof scanLolWatcher>>): string {
  const base = [
    `監視対象: ${result.scannedAccounts}`,
    `失敗: ${result.failedAccounts}`,
    `開始投稿: ${result.startedGames}`,
    `終了反映: ${result.completedGames}`,
    `stale化: ${result.staleGames}`,
  ].join(" / ");
  if (result.errors.length === 0) return base;
  return `${base}\nエラー: ${result.errors.slice(0, 5).join(" | ")}`.slice(0, 1900);
}

async function ensureLolWatcherAdmin(
  interaction: ChatInputCommandInteraction,
  ctx: Pick<CoreDeps, "config" | "log" | "mainPgPool">,
  member: GuildMember | null,
): Promise<boolean> {
  if (member && isAdmin(member, ctx.config)) return true;
  await interaction.reply({ content: "権限がありません。", flags: MessageFlags.Ephemeral });
  return false;
}

export async function handleLolWatchCommand(
  interaction: ChatInputCommandInteraction,
  ctx: Pick<CoreDeps, "config" | "log" | "client" | "mainPgPool">,
  member: GuildMember | null,
): Promise<void> {
  const subcommand = interaction.options.getSubcommand(true);
  if ((subcommand === "list" || subcommand === "scan_now") && !(await ensureLolWatcherAdmin(interaction, ctx, member))) return;
  if (!ctx.config.DEEPLOL_WATCHER_ENABLED) {
    const message = "lol watcher は無効です。DEEPLOL_WATCHER_ENABLED=true で有効化してください。";
    if (subcommand === "scan_now") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await interaction.editReply(message);
    } else {
      await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
    }
    return;
  }
  const repo = createLolWatcherRepository(ctx);
  if (subcommand === "add") {
    const accountKey = interaction.options.getString("key", true).trim();
    const accountKeyNorm = normalizeLolWatcherAccountKey(accountKey);
    if (!accountKeyNorm || !parseRiotId(accountKey)) {
      await interaction.reply({ content: "key は Riot ID 形式（例: name#tag）で指定してください。", flags: MessageFlags.Ephemeral });
      return;
    }
    const result = await repo.upsertUserAccount(interaction.user.id, accountKey, accountKeyNorm);
    if (!result.ok) {
      const content =
        result.reason === "already_registered"
          ? `既に登録があります: ${result.account.accountKeyNorm}\n変更する場合は先に /lol_watch remove を実行してください。`
          : `このRiot IDは既に登録されています: ${accountKeyNorm}`;
      await interaction.reply({ content, flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.reply({
      content: result.created
        ? `監視対象を追加しました: ${accountKeyNorm}\n通知先は \`!lol\` を使ったチャンネルになります。`
        : `監視対象を有効化しました: ${accountKeyNorm}\n通知先は \`!lol\` を使ったチャンネルになります。`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (subcommand === "remove") {
    const account = await repo.disableAccountForUser(interaction.user.id);
    await interaction.reply({
      content: account ? `監視対象を無効化しました: ${account.accountKeyNorm}` : "あなたの監視対象は登録されていません。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (subcommand === "list") {
    const accounts = await repo.listAccounts(true);
    const statuses = await repo.listStatus();
    const notificationChannelId = await repo.getNotificationChannelId();
    const accountLines = accounts.slice(0, 30).map((account, index) => {
      const owner = account.userId ? `<@${account.userId}>` : "-";
      return `${index + 1}. ${account.enabled ? "ON" : "OFF"} ${account.accountKeyNorm} (${account.accountKey}) / user=${owner}`;
    });
    const statusLines = statuses.slice(0, 10).map((status) => `${status.key}: ${status.value ?? "-"}`);
    await interaction.reply({
      content: [
        `通知先: ${notificationChannelId ? `<#${notificationChannelId}>` : "未設定"}`,
        "\n",
        accountLines.length > 0 ? accountLines.join("\n") : "監視対象はありません。",
        statusLines.length > 0 ? `\nstatus:\n${statusLines.join("\n")}` : "",
      ].join("").slice(0, 1900),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (subcommand === "scan_now") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const controller = getLolWatcherController();
    if (controller?.isRunning()) {
      await interaction.editReply("lol watcher は実行中です。");
      return;
    }
    if (controller) {
      const result = await controller.scanNow();
      await interaction.editReply(result.started ? scanSummary(result.result) : result.reason);
      return;
    }
    if (!(await validateAndPrepareLolWatcher(ctx))) {
      await interaction.editReply("lol watcher は無効、または必須env不足のため起動できません。");
      return;
    }
    await interaction.editReply(scanSummary(await scanLolWatcher(ctx)));
  }
}

export async function handleLolAdminAddCommand(
  interaction: ChatInputCommandInteraction,
  ctx: Pick<CoreDeps, "config" | "log" | "mainPgPool">,
  member: GuildMember | null,
): Promise<void> {
  if (!ensureLolWatcherAdmin(interaction, ctx, member)) return;
  if (!ctx.config.DEEPLOL_WATCHER_ENABLED) {
    await interaction.reply({
      content: "lol watcher は無効です。DEEPLOL_WATCHER_ENABLED=true で有効化してください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const accountKey = interaction.options.getString("key", true).trim();
  const accountKeyNorm = normalizeLolWatcherAccountKey(accountKey);
  if (!accountKeyNorm || !parseRiotId(accountKey)) {
    await interaction.reply({ content: "key は Riot ID 形式（例: name#tag）で指定してください。", flags: MessageFlags.Ephemeral });
    return;
  }
  const repo = createLolWatcherRepository(ctx);
  const result = await repo.upsertAccount(accountKey, accountKeyNorm);
  await interaction.reply({
    content: result.created ? `監視対象を追加しました: ${accountKeyNorm}` : `監視対象を有効化しました: ${accountKeyNorm}`,
    flags: MessageFlags.Ephemeral,
  });
}

export async function handleLolAdminRemoveCommand(
  interaction: ChatInputCommandInteraction,
  ctx: Pick<CoreDeps, "config" | "log" | "mainPgPool">,
  member: GuildMember | null,
): Promise<void> {
  if (!ensureLolWatcherAdmin(interaction, ctx, member)) return;
  if (!ctx.config.DEEPLOL_WATCHER_ENABLED) {
    await interaction.reply({
      content: "lol watcher は無効です。DEEPLOL_WATCHER_ENABLED=true で有効化してください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const accountKeyNorm = normalizeLolWatcherAccountKey(interaction.options.getString("key", true));
  const repo = createLolWatcherRepository(ctx);
  const changes = await repo.disableAccount(accountKeyNorm);
  await interaction.reply({
    content: changes > 0 ? `監視対象を無効化しました: ${accountKeyNorm}` : `監視対象が見つかりません: ${accountKeyNorm}`,
    flags: MessageFlags.Ephemeral,
  });
}
