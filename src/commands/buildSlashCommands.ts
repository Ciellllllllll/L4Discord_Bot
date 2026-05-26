import {
  PermissionFlagsBits,
  SlashCommandBuilder,
  type RESTPostAPIApplicationCommandsJSONBody,
} from "discord.js";

export function buildSlashCommands(): RESTPostAPIApplicationCommandsJSONBody[] {
  return [
    new SlashCommandBuilder()
      .setName("q")
      .setDescription("BOTとおしゃべり")
      .addStringOption((o) =>
        o.setName("text").setDescription("質問").setRequired(true).setMaxLength(2000),
      )
      .toJSON(),
    new SlashCommandBuilder().setName("ping").setDescription("応答時間計測用コマンド(DEBUG用です)").toJSON(),

    new SlashCommandBuilder()
      .setName("vc_rank")
      .setDescription("VCの接続ランキングを閲覧できます")
      .addStringOption((o) =>
        o
          .setName("period")
          .setDescription("集計範囲を選んでください。")
          .setRequired(true)
          .addChoices(
            { name: "今日（その日0時〜）", value: "day" },
            { name: "週間（月曜0時〜）", value: "week" },
            { name: "月間（1日0時〜）", value: "month" },
            { name: "全期間（累計）", value: "all" },
          ),
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName("afk")
      .setDescription("同じVCにいる寝落ちユーザーを確認付きで切断します")
      .addUserOption((o) => o.setName("target").setDescription("切断対象の寝落ちユーザー").setRequired(true))
      .toJSON(),
    new SlashCommandBuilder()
      .setName("member_count_setup")
      .setDescription("メンバー数表示用のカテゴリとVCチャンネルを作成します")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .toJSON(),
    new SlashCommandBuilder()
      .setName("create_werewolfgame")
      .setDescription("人狼募集開始")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .toJSON(),
    new SlashCommandBuilder()
      .setName("end_werewolfgame")
      .setDescription("人狼募集終了")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .toJSON(),
    new SlashCommandBuilder()
      .setName("処刑")
      .setDescription("処刑投票フローを開始")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addUserOption((o) => o.setName("target").setDescription("対象").setRequired(true))
      .toJSON(),
    new SlashCommandBuilder()
      .setName("タイムアウト延長")
      .setDescription("タイムアウト延長の投票フロー")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addUserOption((o) => o.setName("target").setDescription("対象（タイムアウト中のユーザー）").setRequired(true))
      .toJSON(),
    new SlashCommandBuilder()
      .setName("disable_emoji")
      .setDescription("対象ユーザーの絵文字利用を制限")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addUserOption((o) => o.setName("user").setDescription("対象").setRequired(true))
      .toJSON(),
    new SlashCommandBuilder()
      .setName("enable_emoji")
      .setDescription("絵文字制限を解除")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addUserOption((o) => o.setName("user").setDescription("対象").setRequired(true))
      .toJSON(),

    new SlashCommandBuilder().setName("stamp_rank").setDescription("スタンプランキング").toJSON(),
    new SlashCommandBuilder().setName("stamp_count").setDescription("スタンプ使用回数を表示").toJSON(),

    new SlashCommandBuilder()
      .setName("ticket_users")
      .setDescription("Ticket 利用者を既存データから集計します")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addIntegerOption((o) =>
        o
          .setName("limit")
          .setDescription("表示件数")
          .setRequired(false)
          .setMinValue(1)
          .setMaxValue(25),
      )
      .toJSON(),

    new SlashCommandBuilder()
      .setName("change_prompt")
      .setDescription("自分用の AI システムプロンプトを書き換えます")
      .toJSON(),

    new SlashCommandBuilder()
      .setName("show_prompt")
      .setDescription("自分が /q で使用している AI システムプロンプトを表示します")
      .toJSON(),

    new SlashCommandBuilder()
      .setName("mute")
      .setDescription("このチャンネル・スレッドでの川柳機能をオフにします")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .toJSON(),
  ];
}
