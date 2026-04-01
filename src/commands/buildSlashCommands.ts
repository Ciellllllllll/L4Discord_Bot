import {
  SlashCommandBuilder,
  type RESTPostAPIApplicationCommandsJSONBody,
} from "discord.js";

export function buildSlashCommands(): RESTPostAPIApplicationCommandsJSONBody[] {
  return [
    new SlashCommandBuilder()
      .setName("q")
      .setDescription("BOTに質問（DeepSeek）")
      .addStringOption((o) =>
        o.setName("text").setDescription("質問").setRequired(true).setMaxLength(2000),
      )
      .toJSON(),
    new SlashCommandBuilder().setName("ping").setDescription("AI応答時間計測").toJSON(),
    new SlashCommandBuilder()
      .setName("member_count_setup")
      .setDescription("Member Count用カテゴリ・ボイスチャンネル設置")
      .toJSON(),
    new SlashCommandBuilder()
      .setName("vc_rank")
      .setDescription("VC滞在ランキング")
      .addStringOption((o) =>
        o
          .setName("period")
          .setDescription("期間")
          .setRequired(true)
          .addChoices(
            { name: "今日", value: "day" },
            { name: "週間", value: "week" },
            { name: "月間", value: "month" },
            { name: "全期間", value: "all" },
          ),
      )
      .toJSON(),
    new SlashCommandBuilder().setName("create_werewolfgame").setDescription("人狼募集開始").toJSON(),
    new SlashCommandBuilder().setName("end_werewolfgame").setDescription("人狼募集終了").toJSON(),
    new SlashCommandBuilder()
      .setName("処刑")
      .setDescription("処刑投票フローを開始")
      .addUserOption((o) => o.setName("target").setDescription("対象").setRequired(true))
      .toJSON(),
    new SlashCommandBuilder()
      .setName("タイムアウト延長")
      .setDescription("タイムアウト延長の投票フロー")
      .toJSON(),
    new SlashCommandBuilder()
      .setName("disable_emoji")
      .setDescription("対象ユーザーの絵文字利用を制限")
      .addUserOption((o) => o.setName("user").setDescription("対象").setRequired(true))
      .toJSON(),
    new SlashCommandBuilder()
      .setName("enable_emoji")
      .setDescription("絵文字制限を解除")
      .addUserOption((o) => o.setName("user").setDescription("対象").setRequired(true))
      .toJSON(),
    new SlashCommandBuilder()
      .setName("stamp_count")
      .setDescription("スタンプ利用回数")
      .addUserOption((o) => o.setName("user").setDescription("対象（省略時は自分）"))
      .toJSON(),
    new SlashCommandBuilder().setName("stamp_ranking").setDescription("スタンプランキング").toJSON(),
  ];
}
