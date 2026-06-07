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
      .setName("pacchi_help")
      .setDescription("ぱっちぃ機能の使い方を表示します")
      .toJSON(),

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
      .setName("create_prompt")
      .setDescription("条件から /q 用の AI システムプロンプトを作成します")
      .toJSON(),

    new SlashCommandBuilder()
      .setName("show_prompt")
      .setDescription("自分が /q で使用している AI システムプロンプトを表示します")
      .toJSON(),

    new SlashCommandBuilder()
      .setName("thinking")
      .setDescription("自分、または管理者が指定ユーザーの Thinking を切り替えます")
      .addBooleanOption((o) =>
        o.setName("enabled").setDescription("Thinking を有効にするか").setRequired(true),
      )
      .addUserOption((o) =>
        o.setName("user").setDescription("対象ユーザー（管理者のみ指定可）").setRequired(false),
      )
      .toJSON(),

    new SlashCommandBuilder()
      .setName("mute")
      .setDescription("このチャンネル・スレッドでの川柳機能をオフにします")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .toJSON(),

    new SlashCommandBuilder()
      .setName("game_on")
      .setDescription("このチャンネルでSteam/Epicの無料検知通知を有効化します")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .toJSON(),
    new SlashCommandBuilder()
      .setName("game_now")
      .setDescription("Steam/Epicの無料ゲーム候補を即時取得します")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .toJSON(),
    new SlashCommandBuilder()
      .setName("game_off")
      .setDescription("Steam/Epicの無料検知通知を無効化します")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .toJSON(),
    new SlashCommandBuilder()
      .setName("sub")
      .setDescription("Steam/Epicゲームの割引・無料化監視を登録します")
      .addStringOption((o) =>
        o
          .setName("link")
          .setDescription("Steam または Epic Games Store のゲームURL")
          .setRequired(true)
          .setMaxLength(500),
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName("sub_list")
      .setDescription("自分の割引・無料化監視リストを表示します")
      .toJSON(),
    new SlashCommandBuilder()
      .setName("lol_watch")
      .setDescription("LoL試合監視を管理します")
      .addSubcommand((sub) =>
        sub
          .setName("add")
          .setDescription("監視対象アカウントを追加します")
          .addStringOption((o) =>
            o.setName("key").setDescription("Riot ID（例: name#tag）").setRequired(true).setMaxLength(200),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("remove")
          .setDescription("自分の監視対象アカウントを無効化します"),
      )
      .addSubcommand((sub) => sub.setName("list").setDescription("監視対象と最新statusを表示します"))
      .addSubcommand((sub) => sub.setName("scan_now").setDescription("LoL試合監視を即時scanします"))
      .toJSON(),
  ];
}
