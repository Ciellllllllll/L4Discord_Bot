import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type ButtonInteraction, type ChatInputCommandInteraction, type GuildMember } from "discord.js";
import { sql, type Kysely } from "kysely";
import type { BotContext } from "../../bot/context.js";
import type { Database } from "../../core/db/types.js";
import { isAdmin } from "../../core/permission.js";
import { ComponentCardBuilder, componentCardsPayload, ephemeralComponentPayload } from "../panels/componentCard.js";

export const ANONYMOUS_SURVEY_VIEW_PAGE_SIZE = 20;
export const ANONYMOUS_SURVEY_VIEW_PREFIX = "anon_survey:view:";

export type AnonymousSurveyView = {
  totalResponses: number;
  averageRating: number | null;
  ratingCounts: [number, number, number, number, number];
  responses: Array<{ rating: number; createdAt: string }>;
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
    if (row.rating >= 1 && row.rating <= 5) ratingCounts[row.rating - 1] = toFiniteNumber(row.count);
  }
  const rows = await db
    .selectFrom("anonymous_survey_responses")
    .select(["rating", "created_at"])
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
    responses: rows.map((row) => ({ rating: row.rating, createdAt: toCreatedAt(row.created_at) })),
    page,
    totalPages,
  };
}

function formatResponse(createdAt: string, rating: number, index: number): string {
  const timestamp = new Date(createdAt).getTime();
  const date = Number.isFinite(timestamp) ? `<t:${Math.floor(timestamp / 1000)}:f>` : createdAt;
  return `${index}. 評価: ${rating} / ${date}`;
}

export function buildAnonymousSurveyViewMessage(view: AnonymousSurveyView) {
  const summary = [
    `回答数: **${view.totalResponses}件**`,
    `平均評価: **${view.averageRating === null ? "-" : view.averageRating.toFixed(2)}**`,
    `評価分布: 1=${view.ratingCounts[0]} / 2=${view.ratingCounts[1]} / 3=${view.ratingCounts[2]} / 4=${view.ratingCounts[3]} / 5=${view.ratingCounts[4]}`,
  ].join("\n");
  const card = new ComponentCardBuilder()
    .setTitle("匿名アンケート結果")
    .setDescription(summary)
    .setFooter({ text: view.totalResponses === 0 ? "回答はまだありません。" : `${view.page + 1} / ${view.totalPages} ページ` });
  if (view.responses.length > 0) {
    card.addTextDisplays(
      view.responses.map((response, index) => formatResponse(
        response.createdAt,
        response.rating,
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
