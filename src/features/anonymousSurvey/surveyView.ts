import { ActionRowBuilder, ButtonBuilder, ButtonStyle, escapeMarkdown, type ButtonInteraction, type ChatInputCommandInteraction, type GuildMember } from "discord.js";
import { sql, type Kysely } from "kysely";
import type { BotContext } from "../../bot/context.js";
import type { Database } from "../../core/db/types.js";
import { isAdmin } from "../../core/permission.js";
import { ComponentCardBuilder, componentCardsPayload, ephemeralComponentPayload } from "../panels/componentCard.js";

// 自由記述を含むため、メッセージ全体のテキスト上限（4000 字）に収まる件数にする
export const ANONYMOUS_SURVEY_VIEW_PAGE_SIZE = 5;
export const ANONYMOUS_SURVEY_VIEW_TEXT_PREVIEW_LENGTH = 150;
export const ANONYMOUS_SURVEY_VIEW_PREFIX = "anon_survey:view:";

export type AnonymousSurveyView = {
  totalResponses: number;
  averageRating: number | null;
  ratingCounts: [number, number, number, number, number];
  improvementCount: number;
  bugReportCount: number;
  responses: Array<{ rating: number | null; improvement: string | null; bugReport: string | null; createdAt: string }>;
  page: number;
  totalPages: number;
};

function toFiniteNumber(value: unknown): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

function toCreatedAt(value: Date | string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

export async function getAnonymousSurveyView(
  db: Kysely<Database>,
  guildId: string,
  requestedPage: number,
): Promise<AnonymousSurveyView> {
  const summary = await db
    .selectFrom("anonymous_survey_responses")
    .select([
      sql<number>`count(*)`.as("totalResponses"),
      sql<number | null>`avg(rating)`.as("averageRating"),
      sql<number>`count(improvement)`.as("improvementCount"),
      sql<number>`count(bug_report)`.as("bugReportCount"),
    ])
    .where("guild_id", "=", guildId)
    .executeTakeFirstOrThrow();
  const totalResponses = toFiniteNumber(summary.totalResponses);
  const totalPages = Math.max(1, Math.ceil(totalResponses / ANONYMOUS_SURVEY_VIEW_PAGE_SIZE));
  const page = Math.min(Math.max(0, Math.trunc(requestedPage)), totalPages - 1);
  const countRows = await db
    .selectFrom("anonymous_survey_responses")
    .select("rating")
    .select((expressionBuilder) => expressionBuilder.fn.count<number>("id").as("count"))
    .where("guild_id", "=", guildId)
    .groupBy("rating")
    .execute();
  const ratingCounts: [number, number, number, number, number] = [0, 0, 0, 0, 0];
  for (const row of countRows) {
    if (row.rating !== null && row.rating >= 1 && row.rating <= 5) ratingCounts[row.rating - 1] = toFiniteNumber(row.count);
  }
  const rows = await db
    .selectFrom("anonymous_survey_responses")
    .select(["rating", "improvement", "bug_report", "created_at"])
    .where("guild_id", "=", guildId)
    .orderBy("created_at", "desc")
    .orderBy("id", "desc")
    .limit(ANONYMOUS_SURVEY_VIEW_PAGE_SIZE)
    .offset(page * ANONYMOUS_SURVEY_VIEW_PAGE_SIZE)
    .execute();
  const averageRating = summary.averageRating === null ? null : toFiniteNumber(summary.averageRating);
  return {
    totalResponses,
    averageRating,
    ratingCounts,
    improvementCount: toFiniteNumber(summary.improvementCount),
    bugReportCount: toFiniteNumber(summary.bugReportCount),
    responses: rows.map((row) => ({
      rating: row.rating,
      improvement: row.improvement,
      bugReport: row.bug_report,
      createdAt: toCreatedAt(row.created_at),
    })),
    page,
    totalPages,
  };
}

export function formatSurveyFeedbackPreview(text: string): string {
  const chars = Array.from(text.replace(/\s+/g, " ").trim());
  const preview = chars.length > ANONYMOUS_SURVEY_VIEW_TEXT_PREVIEW_LENGTH
    ? `${chars.slice(0, ANONYMOUS_SURVEY_VIEW_TEXT_PREVIEW_LENGTH).join("")}…`
    : chars.join("");
  // 匿名の自由記述がリンクやメンションとして描画されないようにする
  // （URL の自動リンクと @everyone / @here はゼロ幅スペースで無効化する）
  return escapeMarkdown(preview, { maskedLink: true })
    .replace(/</g, "\\<")
    .replace(/:\/\//g, ":​//")
    .replace(/@(everyone|here)/gi, "@​$1");
}

export function formatAnonymousSurveyResponse(response: AnonymousSurveyView["responses"][number], index: number): string {
  const timestamp = new Date(response.createdAt).getTime();
  const date = Number.isFinite(timestamp) ? `<t:${Math.floor(timestamp / 1000)}:f>` : response.createdAt;
  const lines = [`${index}. 評価: ${response.rating ?? "-"} / ${date}`];
  if (response.improvement) lines.push(`└ 改善要望: ${formatSurveyFeedbackPreview(response.improvement)}`);
  if (response.bugReport) lines.push(`└ バグ報告: ${formatSurveyFeedbackPreview(response.bugReport)}`);
  return lines.join("\n");
}

export function buildAnonymousSurveyViewMessage(view: AnonymousSurveyView) {
  const summary = [
    `回答数: **${view.totalResponses}件**`,
    `平均評価: **${view.averageRating === null ? "-" : view.averageRating.toFixed(2)}**`,
    `評価分布: 1=${view.ratingCounts[0]} / 2=${view.ratingCounts[1]} / 3=${view.ratingCounts[2]} / 4=${view.ratingCounts[3]} / 5=${view.ratingCounts[4]}`,
    `改善要望あり: **${view.improvementCount}件** / バグ報告あり: **${view.bugReportCount}件**`,
  ].join("\n");
  const card = new ComponentCardBuilder()
    .setTitle("匿名アンケート結果")
    .setDescription(summary)
    .setFooter({ text: view.totalResponses === 0 ? "回答はまだありません。" : `${view.page + 1} / ${view.totalPages} ページ` });
  if (view.responses.length > 0) {
    card.addTextDisplays(
      view.responses.map((response, index) => formatAnonymousSurveyResponse(
        response,
        view.page * ANONYMOUS_SURVEY_VIEW_PAGE_SIZE + index + 1,
      )).join("\n"),
    );
  }
  if (view.totalResponses > 0) {
    const controls = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${ANONYMOUS_SURVEY_VIEW_PREFIX}${view.page - 1}`)
        .setLabel("前へ")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(view.page === 0),
      new ButtonBuilder()
        .setCustomId(`${ANONYMOUS_SURVEY_VIEW_PREFIX}${view.page + 1}`)
        .setLabel("次へ")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(view.page >= view.totalPages - 1),
    );
    return componentCardsPayload([card], [controls]);
  }
  return componentCardsPayload([card]);
}

function memberFromInteraction(interaction: ChatInputCommandInteraction | ButtonInteraction): GuildMember | null {
  return interaction.member && "roles" in interaction.member ? interaction.member as GuildMember : null;
}

function accessDeniedPayload() {
  return ephemeralComponentPayload(componentCardsPayload([
    new ComponentCardBuilder().setTitle("匿名アンケート結果").setDescription("この操作には管理者権限が必要です。"),
  ]));
}

export async function handleAnonymousSurveyViewCommand(
  interaction: ChatInputCommandInteraction,
  ctx: BotContext,
  member: GuildMember | null,
): Promise<void> {
  if (!member || !isAdmin(member, ctx.config)) {
    await interaction.reply(accessDeniedPayload());
    return;
  }
  const view = await getAnonymousSurveyView(ctx.db, interaction.guildId!, 0);
  await interaction.reply(ephemeralComponentPayload(buildAnonymousSurveyViewMessage(view)));
}

function parsePage(customId: string): number | null {
  if (!customId.startsWith(ANONYMOUS_SURVEY_VIEW_PREFIX)) return null;
  const page = Number(customId.slice(ANONYMOUS_SURVEY_VIEW_PREFIX.length));
  return Number.isInteger(page) && page >= 0 ? page : null;
}

export async function handleAnonymousSurveyViewButton(interaction: ButtonInteraction, ctx: BotContext): Promise<boolean> {
  const page = parsePage(interaction.customId);
  if (page === null) return false;
  const member = memberFromInteraction(interaction);
  if (!interaction.inGuild() || !interaction.guildId || !member || !isAdmin(member, ctx.config)) {
    await interaction.reply(accessDeniedPayload());
    return true;
  }
  const view = await getAnonymousSurveyView(ctx.db, interaction.guildId, page);
  await interaction.update(buildAnonymousSurveyViewMessage(view));
  return true;
}
