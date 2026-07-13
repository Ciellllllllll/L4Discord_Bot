import { ComponentCardBuilder, componentCardsPayload } from "../panels/componentCard.js";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";

export const SURVEY_CUSTOM_ID_PREFIX = "anon_survey";
export const SURVEY_RATING_PREFIX = `${SURVEY_CUSTOM_ID_PREFIX}:rating:`;
export const SURVEY_SUBMIT_PREFIX = `${SURVEY_CUSTOM_ID_PREFIX}:submit:`;
export const SURVEY_SKIP_PREFIX = `${SURVEY_CUSTOM_ID_PREFIX}:skip:`;

export function buildAnonymousSurveyMessage(sessionId: string, selectedRating?: number) {
  const embed = new ComponentCardBuilder()
    .setTitle("匿名アンケート")
    .setDescription("BOTの使い心地について、現在の満足度を教えてください。回答は匿名で保存されます。")
    .setFooter({ text: "回答後、またはスキップ後にコマンドを実行します。" });

  const ratingRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...[1, 2, 3, 4, 5].map((rating) =>
      new ButtonBuilder()
        .setCustomId(`${SURVEY_RATING_PREFIX}${sessionId}:${rating}`)
        .setLabel(String(rating))
        .setStyle(rating === selectedRating ? ButtonStyle.Primary : ButtonStyle.Secondary),
    ),
  );

  const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${SURVEY_SKIP_PREFIX}${sessionId}`)
      .setLabel("スキップ")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(selectedRating ? `${SURVEY_SUBMIT_PREFIX}${sessionId}:${selectedRating}` : `${SURVEY_SUBMIT_PREFIX}${sessionId}`)
      .setLabel("送信")
      .setStyle(ButtonStyle.Success)
      .setDisabled(!selectedRating),
  );

  return componentCardsPayload([embed], [ratingRow, actionRow]);
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
    ? "アンケートを送信しました。コマンドを実行します。"
    : "アンケートをスキップしました。コマンドを実行します。";
  return componentCardsPayload([
    new ComponentCardBuilder()
      .setTitle("匿名アンケート")
      .setDescription(message),
  ]);
}
