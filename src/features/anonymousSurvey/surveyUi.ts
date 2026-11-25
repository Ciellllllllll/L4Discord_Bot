import { ComponentCardBuilder, componentCardsPayload } from "../../core/componentCard.js";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  LabelBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { SURVEY_TEXT_MAX_LENGTH } from "./surveyService.js";

export const SURVEY_CUSTOM_ID_PREFIX = "anon_survey";
export const SURVEY_MODAL_PREFIX = `${SURVEY_CUSTOM_ID_PREFIX}:modal:`;
export const SURVEY_CONTINUE_PREFIX = `${SURVEY_CUSTOM_ID_PREFIX}:continue:`;
// 旧 Components v2 版アンケートのボタン（デプロイ前に表示されたメッセージ用）
export const SURVEY_LEGACY_BUTTON_PREFIXES = [
  `${SURVEY_CUSTOM_ID_PREFIX}:rating:`,
  `${SURVEY_CUSTOM_ID_PREFIX}:submit:`,
  `${SURVEY_CUSTOM_ID_PREFIX}:skip:`,
] as const;

export const SURVEY_RATING_FIELD_ID = "anon_survey_rating";
export const SURVEY_IMPROVEMENT_FIELD_ID = "anon_survey_improvement";
export const SURVEY_BUG_REPORT_FIELD_ID = "anon_survey_bug_report";

const RATING_LABELS: Record<number, string> = {
  1: "1 - 不満",
  2: "2 - やや不満",
  3: "3 - ふつう",
  4: "4 - やや満足",
  5: "5 - 満足",
};

export function buildAnonymousSurveyModal(sessionId: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`${SURVEY_MODAL_PREFIX}${sessionId}`)
    .setTitle("匿名アンケート")
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "BOTの使い心地を教えてください。回答は匿名で保存されます。\n満足度を選ばず、何も書かずに送信するとスキップになります。",
      ),
    )
    .addLabelComponents(
      new LabelBuilder()
        .setLabel("満足度")
        .setStringSelectMenuComponent(
          new StringSelectMenuBuilder()
            .setCustomId(SURVEY_RATING_FIELD_ID)
            .setPlaceholder("1〜5 から選択")
            .setRequired(false)
            .setMinValues(0)
            .setMaxValues(1)
            .addOptions(
              [5, 4, 3, 2, 1].map((rating) =>
                new StringSelectMenuOptionBuilder().setLabel(RATING_LABELS[rating]!).setValue(String(rating)),
              ),
            ),
        ),
      new LabelBuilder()
        .setLabel("改善してほしい点（任意）")
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId(SURVEY_IMPROVEMENT_FIELD_ID)
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(false)
            .setMaxLength(SURVEY_TEXT_MAX_LENGTH),
        ),
      new LabelBuilder()
        .setLabel("バグ報告（任意）")
        .setDescription("どのコマンドで何が起きたかを書いてもらえると助かります。")
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId(SURVEY_BUG_REPORT_FIELD_ID)
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(false)
            .setMaxLength(SURVEY_TEXT_MAX_LENGTH),
        ),
    );
}

export function buildAnonymousSurveyExpiredMessage() {
  return {
    content: "期限切れのため、もう一度コマンドを実行してください。",
    embeds: [],
    components: [],
  };
}

export function buildAnonymousSurveyCompletedMessage(action: "answer" | "skip") {
  const message = action === "answer"
    ? "アンケートを送信しました。ご協力ありがとうございます。"
    : "アンケートをスキップしました。";
  return componentCardsPayload([
    new ComponentCardBuilder()
      .setTitle("匿名アンケート")
      .setDescription(message),
  ]);
}

// モーダル送信への応答では別のモーダルを開けないため、モーダルを使うコマンドはボタンから続行する
export function buildAnonymousSurveyContinueMessage(action: "answer" | "skip", sessionId: string) {
  const message = action === "answer"
    ? "アンケートを送信しました。下のボタンからコマンドを実行してください。"
    : "アンケートをスキップしました。下のボタンからコマンドを実行してください。";
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${SURVEY_CONTINUE_PREFIX}${sessionId}`)
      .setLabel("コマンドを実行")
      .setStyle(ButtonStyle.Primary),
  );
  return componentCardsPayload([
    new ComponentCardBuilder()
      .setTitle("匿名アンケート")
      .setDescription(message),
  ], [row]);
}
