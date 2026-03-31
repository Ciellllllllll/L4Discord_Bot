import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  type MessageCreateOptions,
} from "discord.js";

export function buildAdminHubPayload(): MessageCreateOptions {
  const embed = new EmbedBuilder()
    .setTitle("管理パネル")
    .setDescription("メニューから操作を選んでください。")
    .setColor(0x5865f2);
  const select = new StringSelectMenuBuilder()
    .setCustomId("panels:s:admin")
    .setPlaceholder("管理メニュー")
    .addOptions(
      { label: "メッセージログ検索", value: "ml", description: "全文検索（FTS）" },
      { label: "チケット一覧", value: "tk", description: "tickets を一覧" },
      { label: "Modmailスレッド", value: "mm", description: "modmail_threads" },
      { label: "VCパネル設定", value: "vc_cfg", description: "登録カテゴリの確認・未設定時の案内" },
      { label: "Detecter / 異議", value: "dm", description: "インシデント・申請" },
      { label: "絵文字制限ユーザー", value: "em", description: "guild_settings" },
      { label: "経済サマリ", value: "ec", description: "上位口座" },
      { label: "人狼ゲーム", value: "wl", description: "進行中の募集" },
      { label: "投票", value: "pl", description: "polls" },
      { label: "リマインダー", value: "rm", description: "reminders" },
      { label: "お知らせ", value: "an", description: "announcements" },
      { label: "リアクションロール", value: "rr", description: "登録メッセージ" },
      { label: "AI履歴", value: "ah", description: "ai_history 件数" },
    );
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("panels:b:rec").setLabel("パネル再同期").setStyle(ButtonStyle.Secondary),
  );
  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
      row2,
    ],
  };
}

export function buildUserHubPayload(): MessageCreateOptions {
  const embed = new EmbedBuilder()
    .setTitle("ユーザーパネル")
    .setDescription("よく使う機能への入口です。")
    .setColor(0x57f287);
  const select = new StringSelectMenuBuilder()
    .setCustomId("panels:s:user")
    .setPlaceholder("ユーザーメニュー")
    .addOptions(
      { label: "Modmailを始める", value: "mm", description: "相談の受付" },
      { label: "チケットを作る", value: "tk", description: "一般チケット" },
      { label: "残高を見る", value: "bl", description: "economy_accounts" },
      { label: "ボイスチャンネル作成の案内", value: "vc", description: "参加用カテゴリの案内" },
      { label: "人狼に参加", value: "wj", description: "ロビー募集" },
      { label: "スタンプ集計（自分）", value: "st", description: "/stamp_count 相当" },
      { label: "VCランキング", value: "vr", description: "/vc_rank 相当" },
    );
  return {
    embeds: [embed],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
  };
}
