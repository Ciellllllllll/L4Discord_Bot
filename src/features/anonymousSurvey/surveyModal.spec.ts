import assert from "node:assert/strict";
import { ComponentType, TextInputStyle } from "discord.js";
import { SURVEY_TEXT_MAX_LENGTH, parseAnonymousSurveySubmission } from "./surveyService.js";
import {
  SURVEY_BUG_REPORT_FIELD_ID,
  SURVEY_IMPROVEMENT_FIELD_ID,
  SURVEY_MODAL_PREFIX,
  SURVEY_RATING_FIELD_ID,
  buildAnonymousSurveyContinueMessage,
  buildAnonymousSurveyModal,
} from "./surveyUi.js";
import {
  ANONYMOUS_SURVEY_VIEW_PAGE_SIZE,
  ANONYMOUS_SURVEY_VIEW_TEXT_PREVIEW_LENGTH,
  buildAnonymousSurveyViewMessage,
  formatAnonymousSurveyResponse,
  formatSurveyFeedbackPreview,
} from "./surveyView.js";

// モーダルの構成
const modal = buildAnonymousSurveyModal("session-1").toJSON();
assert.equal(modal.custom_id, `${SURVEY_MODAL_PREFIX}session-1`);
assert.equal(modal.title, "匿名アンケート");
assert.equal(modal.components[0]?.type, ComponentType.TextDisplay);
const labels = modal.components.filter((component) => component.type === ComponentType.Label);
assert.equal(labels.length, 3);
const [ratingLabel, improvementLabel, bugLabel] = labels;
assert.equal(ratingLabel?.component.type, ComponentType.StringSelect);
if (ratingLabel?.component.type === ComponentType.StringSelect) {
  assert.equal(ratingLabel.component.custom_id, SURVEY_RATING_FIELD_ID);
  assert.equal(ratingLabel.component.required, false);
  assert.equal(ratingLabel.component.min_values, 0);
  assert.equal(ratingLabel.component.max_values, 1);
  assert.deepEqual(ratingLabel.component.options.map((option) => option.value).sort(), ["1", "2", "3", "4", "5"]);
}
for (const [label, customId] of [[improvementLabel, SURVEY_IMPROVEMENT_FIELD_ID], [bugLabel, SURVEY_BUG_REPORT_FIELD_ID]] as const) {
  assert.equal(label?.component.type, ComponentType.TextInput);
  if (label?.component.type === ComponentType.TextInput) {
    assert.equal(label.component.custom_id, customId);
    assert.equal(label.component.style, TextInputStyle.Paragraph);
    assert.equal(label.component.required, false);
    assert.equal(label.component.max_length, SURVEY_TEXT_MAX_LENGTH);
  }
}
// カスタム ID は Discord の上限（100 文字）に収まる
assert.ok(buildAnonymousSurveyModal("00000000-0000-0000-0000-000000000000").toJSON().custom_id.length <= 100);

// 送信内容の判定
assert.deepEqual(parseAnonymousSurveySubmission([], "", "   "), { kind: "skip" });
assert.deepEqual(parseAnonymousSurveySubmission([], null, null), { kind: "skip" });
assert.deepEqual(parseAnonymousSurveySubmission(["4"], "", ""), { kind: "answer", rating: 4, improvement: null, bugReport: null });
assert.deepEqual(
  parseAnonymousSurveySubmission([], "  もっと速く  ", "\n/foo が落ちる\n"),
  { kind: "answer", rating: null, improvement: "もっと速く", bugReport: "/foo が落ちる" },
);
// 不正な評価値は未選択として扱う
assert.deepEqual(parseAnonymousSurveySubmission(["9"], "", ""), { kind: "skip" });
assert.deepEqual(parseAnonymousSurveySubmission(["2.5"], "改善", ""), { kind: "answer", rating: null, improvement: "改善", bugReport: null });
const longText = parseAnonymousSurveySubmission(["1"], "a".repeat(SURVEY_TEXT_MAX_LENGTH + 50), "");
assert.equal(longText.kind === "answer" ? longText.improvement?.length : -1, SURVEY_TEXT_MAX_LENGTH);

// 「コマンドを実行」ボタン
const continueMessage = JSON.stringify(buildAnonymousSurveyContinueMessage("answer", "session-2").components);
assert.ok(continueMessage.includes("anon_survey:continue:session-2"));

// 結果表示
const preview = formatSurveyFeedbackPreview(`**太字**\n${"あ".repeat(ANONYMOUS_SURVEY_VIEW_TEXT_PREVIEW_LENGTH + 10)}`);
assert.ok(preview.startsWith("\\*\\*太字\\*\\* "));
assert.ok(preview.endsWith("…"));
assert.equal(preview.includes("\n"), false);
assert.equal(formatSurveyFeedbackPreview("😀".repeat(ANONYMOUS_SURVEY_VIEW_TEXT_PREVIEW_LENGTH + 1)), `${"😀".repeat(ANONYMOUS_SURVEY_VIEW_TEXT_PREVIEW_LENGTH)}…`);

// 匿名の自由記述はリンクやメンションとして描画されない
assert.equal(
  formatSurveyFeedbackPreview("[公式](https://evil.example) <@&123> <https://x.example>"),
  "\\[公式](https://evil.example) \\<@&123> \\<https://x.example>",
);

const createdAt = "2026-09-24T00:00:00.000Z";
assert.equal(
  formatAnonymousSurveyResponse({ rating: null, improvement: "改善", bugReport: "バグ", createdAt }, 3),
  "3. 評価: - / <t:1790208000:f>\n└ 改善要望: 改善\n└ バグ報告: バグ",
);
assert.equal(
  formatAnonymousSurveyResponse({ rating: 5, improvement: null, bugReport: null, createdAt }, 1),
  "1. 評価: 5 / <t:1790208000:f>",
);

// 1 ページ分が最大長の自由記述でも、メッセージ全体のテキスト上限（4000 字）に収まる
const worstText = "<".repeat(SURVEY_TEXT_MAX_LENGTH);
const worstView = buildAnonymousSurveyViewMessage({
  totalResponses: 100,
  averageRating: 3.5,
  ratingCounts: [20, 20, 20, 20, 20],
  improvementCount: 100,
  bugReportCount: 100,
  responses: Array.from({ length: ANONYMOUS_SURVEY_VIEW_PAGE_SIZE }, () => ({ rating: 3, improvement: worstText, bugReport: worstText, createdAt })),
  page: 0,
  totalPages: 20,
});
function collectText(value: unknown): number {
  if (Array.isArray(value)) return value.reduce<number>((sum, item) => sum + collectText(item), 0);
  if (!value || typeof value !== "object") return 0;
  const record = value as Record<string, unknown>;
  const own = record.type === ComponentType.TextDisplay && typeof record.content === "string" ? record.content.length : 0;
  return own + Object.values(record).reduce<number>((sum, item) => sum + collectText(item), 0);
}
assert.ok(collectText(worstView.components) <= 4000, `text length ${collectText(worstView.components)}`);

console.log("surveyModal.spec.ts: all assertions passed");
