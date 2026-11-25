import { ComponentCardBuilder, componentCardsPayload } from "../../core/componentCard.js";
import {
  type ChatInputCommandInteraction,
} from "discord.js";
import type { BotContext } from "../../bot/context.js";

export async function handlePacchiHelp(
  interaction: ChatInputCommandInteraction,
  _ctx: BotContext,
): Promise<void> {
  const embed = new ComponentCardBuilder()
    .setTitle("ぱっちぃ ヘルプ")
    .addFields(
      {
        name: "通常の呼びかけ",
        value: [
          "「ぱっちぃ」と呼ぶと返事します。",
          "会話にたまに相槌します。",
          "サーバー内の言葉を覚えて返答に混ぜます。",
        ].join("\n"),
      },
      {
        name: "自然文トリガー",
        value: [
          "グー、チョキ、パーでじゃんけんできます。",
          "おやすみ、おはようで睡眠時間を計測できます。",
          "「〇〇ってなんやねん」で簡単な説明を返します。",
          "「ぱっちぃ 575」「ぱっちぃ 詩 575」で短い詩を作ります。",
          "「ぱっちぃ 日報開始」「ぱっちぃ 日報終了」で日報を記録します。",
        ].join("\n"),
      },
      {
        name: "全員向けコマンド",
        value: [
          "`/pacchi_help`",
          "`!pacchi_poem 575`",
          "`!pacchi_work_start 今日の目標`",
          "`!pacchi_work_end 今日の進捗`",
          "`!pacchi_sleep`",
        ].join("\n"),
      },
      {
        name: "管理者向けコマンド",
        value: [
          "`!pacchi_on` / `!pacchi_off`",
          "`!pacchi_channel learn on talk off`",
          "`!pacchi_rate silent|low|normal|high|unlimited`",
          "`!pacchi_status`",
          "`!pacchi_memory` / `!pacchi_words`",
          "`!pacchi_forget word 単語` / `!pacchi_forget all confirm`",
          "`!pacchi_export` / `!pacchi_import`",
        ].join("\n"),
      },
    );
  await interaction.reply({ ...componentCardsPayload([embed]), allowedMentions: { parse: [] } });
}
