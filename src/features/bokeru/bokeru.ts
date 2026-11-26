import { randomUUID } from "node:crypto";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
} from "discord.js";
import type { CoreDeps } from "../../core/deps.js";
import { parseCustomId } from "../../core/parseCustomId.js";
import { BOKETE_THREAD_ID } from "../bokete/bokete.slash.js";
import { ComponentCardBuilder, componentCardsPayload } from "../../core/componentCard.js";
import { judgeBokeruAnswer } from "./bokeruJudge.js";
import { loadBokeruOdaiList, pickBokeruOdai, type BokeruOdai } from "./bokeruOdai.js";
import {
  BOKERU_VOTE_POINTS,
  closeBokeruRound,
  countBokeruOdaiUsage,
  createBokeruRound,
  getBokeruAnswer,
  getBokeruBestAnswers,
  getBokeruRound,
  getBokeruUserRanking,
  hasBokeruAnswer,
  insertBokeruAnswer,
  isBokeruRoundOpen,
  listDueBokeruRoundIds,
  setBokeruAnswerJudgement,
  setBokeruAnswerMessage,
  setBokeruRoundMessage,
  toggleBokeruVote,
  type BokeruResult,
} from "./bokeruRepository.js";

export const BOKERU_ROUND_MS = 5 * 60_000;
// Bokeru の出題・回答・締め切り処理が使う依存。
type BokeruDeps = Pick<CoreDeps, "config" | "log" | "client" | "mainPgPool">;
const BOKERU_NOTIFY_ROLE_ID = "1556559586956156990";
const ANSWER_INPUT_ID = "answer";
const ANSWER_MAX_LENGTH = 200;
const NO_MENTIONS = { parse: [] as [] };

function ephemeral(content: string) {
  return { content, flags: MessageFlags.Ephemeral } as const;
}

function quote(text: string, max = 60): string {
  const oneLine = text.replace(/\s+/g, " ");
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function renderOdai(roundId: string, odai: BokeruOdai, closesAt: Date, open: boolean) {
  const card = new ComponentCardBuilder().setTitle("Bokeru お題");
  if (odai.type === "text") card.addTextDisplays(`# ${odai.text}`);
  else card.setImage(odai.imageUrl);
  const unix = Math.floor(closesAt.getTime() / 1000);
  card.addBottomTextDisplays(open ? `締切 <t:${unix}:R>（1人1回・👍1票=${BOKERU_VOTE_POINTS}点）` : "締め切りました");
  if (open) {
    card.addBottomActionRows(new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`bokeru:answer:${roundId}`).setLabel("回答する").setStyle(ButtonStyle.Primary),
    ));
  }
  return { ...componentCardsPayload([card]), allowedMentions: NO_MENTIONS };
}

function renderAnswer(answer: { id: string; user_id: string; text: string; ai_score: number | null; ai_comment: string | null }, votes: number) {
  const ai = answer.ai_score === null
    ? "AI採点: 採点できませんでした（0点）"
    : `AI採点: **${answer.ai_score}点**${answer.ai_comment ? `「${answer.ai_comment}」` : ""}`;
  const card = new ComponentCardBuilder()
    .addTextDisplays(`<@${answer.user_id}> の回答`, `## ${answer.text}`, ai)
    .addBottomActionRows(new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`bokeru:vote:${answer.id}`)
        .setLabel(`👍 ${votes}`)
        .setStyle(ButtonStyle.Secondary),
    ));
  return { ...componentCardsPayload([card]), allowedMentions: NO_MENTIONS };
}

function renderResults(odai: BokeruOdai, results: BokeruResult[]) {
  const lines = results.map((r, i) => {
    const votes = Math.round((r.final_score - (r.ai_score ?? 0)) / BOKERU_VOTE_POINTS);
    return `${i + 1}. <@${r.user_id}>「${quote(r.text)}」 **${r.final_score}点**（AI ${r.ai_score ?? 0} + 👍${votes}）`;
  });
  const card = new ComponentCardBuilder()
    .setTitle("Bokeru 結果発表")
    .addTextDisplays(
      odai.type === "text" ? `お題: ${odai.text}` : "お題: 画像",
      lines.length > 0 ? lines.join("\n") : "回答はありませんでした",
    );
  return { ...componentCardsPayload([card]), allowedMentions: NO_MENTIONS };
}

async function fetchSendableChannel(ctx: Pick<CoreDeps, "client">, channelId: string) {
  const channel = await ctx.client.channels.fetch(channelId).catch(() => null);
  return channel?.isSendable() ? channel : null;
}

export async function finalizeBokeruRound(ctx: BokeruDeps, roundId: string): Promise<void> {
  const results = await closeBokeruRound(ctx.mainPgPool, roundId);
  if (!results) return;
  const round = await getBokeruRound(ctx.mainPgPool, roundId);
  if (!round) return;
  const channel = await fetchSendableChannel(ctx, round.channel_id);
  if (!channel) {
    ctx.log.warn({ roundId, channelId: round.channel_id }, "bokeru: result channel unavailable");
    return;
  }
  if (round.message_id && "messages" in channel) {
    await channel.messages.edit(round.message_id, renderOdai(round.id, round.odai, round.closes_at, false))
      .catch((err) => ctx.log.warn({ err, roundId }, "bokeru: failed to close odai message"));
  }
  await channel.send(renderResults(round.odai, results));
}

// 再起動などでタイマーが失われたお題を締め切る（reminder scheduler の tick から呼ぶ）。
export async function finalizeDueBokeruRounds(ctx: BokeruDeps): Promise<void> {
  for (const id of await listDueBokeruRoundIds(ctx.mainPgPool)) {
    await finalizeBokeruRound(ctx, id).catch((err) => ctx.log.error({ err, roundId: id }, "bokeru: finalize failed"));
  }
}

async function handleStart(interaction: ChatInputCommandInteraction, ctx: BokeruDeps): Promise<void> {
  if (interaction.channelId !== BOKETE_THREAD_ID || !interaction.guildId) {
    await interaction.reply(ephemeral("このコマンドは指定スレッドでのみ利用できます。"));
    return;
  }
  await interaction.deferReply();
  await finalizeDueBokeruRounds(ctx);

  let odaiList: BokeruOdai[];
  try {
    odaiList = await loadBokeruOdaiList();
  } catch (err) {
    ctx.log.error({ err }, "bokeru: failed to load Bokete.json");
    await interaction.editReply({ content: "お題を読み込めませんでした。" });
    return;
  }
  const odai = pickBokeruOdai(odaiList, await countBokeruOdaiUsage(ctx.mainPgPool, interaction.guildId));
  const roundId = randomUUID();
  const closesAt = new Date(Date.now() + BOKERU_ROUND_MS);
  const created = await createBokeruRound(ctx.mainPgPool, {
    id: roundId,
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    odai,
    closesAt,
  });
  if (!created) {
    await interaction.editReply({ content: "進行中のお題があります。締切までお待ちください。" });
    return;
  }
  const message = await interaction.editReply(renderOdai(roundId, odai, closesAt, true));
  await setBokeruRoundMessage(ctx.mainPgPool, roundId, message.id);
  // 遅延応答の編集では通知が飛ばないため、メンションは新規メッセージで送る
  await interaction.followUp({
    content: `<@&${BOKERU_NOTIFY_ROLE_ID}> 新しいお題が出ました！`,
    allowedMentions: { roles: [BOKERU_NOTIFY_ROLE_ID] },
  }).catch((err) => ctx.log.warn({ err, roundId }, "bokeru: failed to notify role"));
  // ponytail: プロセス内タイマー。再起動で失われた分は finalizeDueBokeruRounds が30秒以内に拾う
  setTimeout(() => {
    void finalizeBokeruRound(ctx, roundId).catch((err) => ctx.log.error({ err, roundId }, "bokeru: finalize failed"));
  }, BOKERU_ROUND_MS).unref();
}

async function handleRanking(interaction: ChatInputCommandInteraction, ctx: Pick<CoreDeps, "mainPgPool">): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply(ephemeral("サーバー内で実行してください。"));
    return;
  }
  const [users, best] = await Promise.all([
    getBokeruUserRanking(ctx.mainPgPool, interaction.guildId),
    getBokeruBestAnswers(ctx.mainPgPool, interaction.guildId),
  ]);
  const userLines = users.map((u, i) => `${i + 1}. <@${u.user_id}> **${u.total}点**（${u.answers}回答）`);
  const bestLines = best.map((b, i) => `${i + 1}. <@${b.user_id}>「${quote(b.text)}」 **${b.final_score}点**`);
  const card = new ComponentCardBuilder()
    .setTitle("Bokeru ランキング")
    .addTextDisplays(
      `### 合計点\n${userLines.join("\n") || "まだ記録がありません"}`,
      `### 歴代ベスト回答\n${bestLines.join("\n") || "まだ記録がありません"}`,
    );
  await interaction.reply({ ...componentCardsPayload([card]), allowedMentions: NO_MENTIONS });
}

export async function handleBokeruSlash(interaction: ChatInputCommandInteraction, ctx: BokeruDeps): Promise<void> {
  if (interaction.options.getSubcommand() === "ranking") return handleRanking(interaction, ctx);
  return handleStart(interaction, ctx);
}

export async function handleBokeruButton(interaction: ButtonInteraction, ctx: Pick<CoreDeps, "mainPgPool">): Promise<boolean> {
  const parsed = parseCustomId(interaction.customId);
  if (!parsed || parsed.domain !== "bokeru") return false;

  if (parsed.action === "answer") {
    const round = await getBokeruRound(ctx.mainPgPool, parsed.shortId);
    if (!round || !isBokeruRoundOpen(round)) {
      await interaction.reply(ephemeral("このお題は締め切られました。"));
    } else if (await hasBokeruAnswer(ctx.mainPgPool, round.id, interaction.user.id)) {
      await interaction.reply(ephemeral("このお題には回答済みです。"));
    } else {
      await interaction.showModal(new ModalBuilder()
        .setCustomId(`bokeru:submit:${round.id}`)
        .setTitle("Bokeruに回答")
        .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId(ANSWER_INPUT_ID)
            .setLabel("ボケ")
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMaxLength(ANSWER_MAX_LENGTH),
        )));
    }
    return true;
  }

  if (parsed.action === "vote") {
    const answer = await getBokeruAnswer(ctx.mainPgPool, parsed.shortId);
    if (!answer) {
      await interaction.reply(ephemeral("回答が見つかりませんでした。"));
      return true;
    }
    const open = isBokeruRoundOpen({ status: answer.round_status, closes_at: answer.closes_at });
    if (!open) {
      await interaction.reply(ephemeral("投票は締め切られました。"));
      return true;
    }
    if (answer.user_id === interaction.user.id) {
      await interaction.reply(ephemeral("自分の回答には投票できません。"));
      return true;
    }
    const result = await toggleBokeruVote(ctx.mainPgPool, answer.id, interaction.user.id);
    if (!result) {
      await interaction.reply(ephemeral("投票は締め切られました。"));
      return true;
    }
    await interaction.update(renderAnswer(answer, result.votes));
    return true;
  }

  return false;
}

export async function handleBokeruModal(interaction: ModalSubmitInteraction, ctx: BokeruDeps): Promise<boolean> {
  const parsed = parseCustomId(interaction.customId);
  if (!parsed || parsed.domain !== "bokeru" || parsed.action !== "submit") return false;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const text = interaction.fields.getTextInputValue(ANSWER_INPUT_ID).trim();
  const round = await getBokeruRound(ctx.mainPgPool, parsed.shortId);
  if (!text || !round) {
    await interaction.editReply({ content: "回答を受け付けられませんでした。" });
    return true;
  }
  const answerId = randomUUID();
  if (!await insertBokeruAnswer(ctx.mainPgPool, { id: answerId, roundId: round.id, userId: interaction.user.id, text })) {
    const already = await hasBokeruAnswer(ctx.mainPgPool, round.id, interaction.user.id);
    await interaction.editReply({ content: already ? "このお題には回答済みです。" : "このお題は締め切られました。" });
    return true;
  }

  const judgement = await judgeBokeruAnswer(ctx.config, round.odai, text).catch((err) => {
    ctx.log.warn({ err, roundId: round.id }, "bokeru: AI judge failed");
    return null;
  });
  await setBokeruAnswerJudgement(ctx.mainPgPool, answerId, judgement);

  const channel = await fetchSendableChannel(ctx, round.channel_id);
  if (!channel) {
    await interaction.editReply({ content: "回答は記録しましたが、投稿できませんでした。" });
    return true;
  }
  const message = await channel.send(renderAnswer({
    id: answerId,
    user_id: interaction.user.id,
    text,
    ai_score: judgement?.score ?? null,
    ai_comment: judgement?.comment ?? null,
  }, 0));
  await setBokeruAnswerMessage(ctx.mainPgPool, answerId, message.id);
  await interaction.editReply({ content: "回答を投稿しました。" });
  return true;
}
