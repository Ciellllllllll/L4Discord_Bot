import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import type { Message } from "discord.js";
import { countAmbiguousInReading, countMora } from "./senryu.counter.js";
import {
  buildSenryuAiReviewUserBlock,
  formatKuromojiSpanForAiReview,
  parseSenryuAiReviewVerdict,
} from "./senryu.aiReview.js";
import {
  detectFirst575,
  extractAll575,
  pickSenryuCandidate,
  senryuCandidate575MismatchScore,
} from "./senryu.detector.js";
import { deleteSenryu, saveSenryu } from "./senryu.repository.js";
import { replySenryu } from "./senryu.reply.js";
import { senryuCandidateMatchesJsHaiku575 } from "./senryu.jsHaikuVerify.js";
import { normalizeSenryuText } from "./senryu.normalizer.js";
import { buildSenryuReviewContextExcerpt } from "./senryu.reviewContext.js";
import { containsDiscordTokens, containsSpoiler, stripSpoilerMarkers } from "./senryu.regex.js";
import type { KuromojiToken } from "./senryu.types.js";

const _dir = dirname(fileURLToPath(import.meta.url));
const migration013 = join(_dir, "..", "..", "..", "migrations", "sqlite", "013_senryu.up.sql");

function tok(
  surface: string,
  reading: string,
  pos: [string, string, string, string] = ["名詞", "一般", "*", "*"],
): KuromojiToken {
  return {
    surface,
    pos,
    cType: "*",
    cForm: "*",
    lemma: surface,
    reading,
    pronunciation: reading,
    isKnown: true,
  };
}

async function run(): Promise<void> {
  assert.equal(containsDiscordTokens("hello https://x.com/y"), true);
  assert.equal(containsDiscordTokens("hello"), false);
  assert.equal(containsDiscordTokens("<@123>"), true);
  assert.equal(containsDiscordTokens("<#456>"), true);
  assert.equal(containsDiscordTokens("<@&789>"), true);
  assert.equal(containsDiscordTokens("plain"), false);
  assert.equal(containsDiscordTokens("a <:name:123456789012345678>"), true);

  assert.equal(containsSpoiler("||x||"), true);
  assert.equal(stripSpoilerMarkers("||abc||def"), "abcdef");
  assert.equal(stripSpoilerMarkers("||a|| ||b||"), "a b");

  assert.equal(countMora("シャ"), 1);
  assert.equal(countMora("キョウ"), 2);

  assert.equal(countAmbiguousInReading("ガッキー"), 2);

  assert.equal(normalizeSenryuText("ねこが、すき"), "ねこがすき");
  assert.equal(normalizeSenryuText("ねこが,すき"), "ねこがすき");
  assert.equal(normalizeSenryuText("ねこが すき"), "ねこがすき");
  assert.equal(normalizeSenryuText("ねこが　すき"), "ねこがすき");

  const five = "アイウエオ";
  const seven = "カキクケコアイ";
  const five2 = "サシスセソ";
  assert.equal(countMora(five), 5);
  assert.equal(countMora(seven), 7);
  assert.equal(countMora(five2), 5);

  const threePhrase = [tok(five, five), tok(seven, seven), tok(five2, five2)];
  const punctBetween: KuromojiToken[] = [
    tok(five, five),
    tok("、", "", ["記号", "読点", "*", "*"]),
    tok(seven, seven),
    tok(" ", "", ["記号", "空白", "*", "*"]),
    tok(five2, five2),
  ];
  assert.ok(extractAll575(punctBetween).length >= 1);
  assert.equal(detectFirst575(punctBetween)?.formatted, `${five} ${seven} ${five2}`);

  const all = extractAll575(threePhrase);
  assert.ok(all.length >= 1);
  const first575 = detectFirst575(threePhrase);
  assert.equal(first575?.formatted, all[0]?.formatted);
  assert.deepEqual(first575?.tokenSpan, { start: 0, end: 3 });
  assert.deepEqual(first575?.moraUsed, [5, 7, 5]);

  const threePhraseHiraSurface = [
    tok("あいうえお", "アイウエオ"),
    tok("かきくけこあい", "カキクケコアイ"),
    tok("さしすせそ", "サシスセソ"),
  ];
  const candJs = detectFirst575(threePhraseHiraSurface);
  assert.ok(candJs);
  assert.equal(senryuCandidateMatchesJsHaiku575(threePhraseHiraSurface, candJs), true);
  assert.equal(
    senryuCandidateMatchesJsHaiku575(threePhraseHiraSurface, {
      ...candJs,
      formatted: "ノノノ ノノノノノ ノノノ",
    }),
    false,
  );

  const fourMora = "アイウエ";
  assert.equal(countMora(fourMora), 4);
  const looseOpen: KuromojiToken[] = [
    tok(fourMora, fourMora),
    tok(seven, seven),
    tok(five2, five2),
  ];
  assert.equal(extractAll575(looseOpen, 0).length, 0);
  const looseCandidates = extractAll575(looseOpen, 1);
  assert.ok(looseCandidates.length >= 1);
  assert.deepEqual(looseCandidates[0]!.moraUsed, [4, 7, 5]);
  assert.equal(senryuCandidate575MismatchScore(looseCandidates[0]!), 1);

  const twoExact: KuromojiToken[] = [
    ...looseOpen,
    tok("ノ", "ノ"),
    tok(five, five),
    tok(seven, seven),
    tok(five2, five2),
  ];
  const pickLooseFirst = pickSenryuCandidate(twoExact, { moraTolerance: 1, bestCandidate: false });
  assert.equal(pickLooseFirst?.tokenSpan.start, 0);
  const pickBest = pickSenryuCandidate(twoExact, { moraTolerance: 1, bestCandidate: true });
  assert.equal(pickBest?.tokenSpan.start, 4);
  assert.deepEqual(pickBest?.moraUsed, [5, 7, 5]);
  assert.equal(senryuCandidate575MismatchScore(pickBest!), 0);

  const pad = "0".repeat(120);
  const needle = `${five}${seven}${five2}`;
  const longNorm = `${pad}${needle}${pad}`;
  const excerpt = buildSenryuReviewContextExcerpt(longNorm, {
    kamigo: five,
    nakashichi: seven,
    shimogo: five2,
    formatted: `${five} ${seven} ${five2}`,
    tokenSpan: { start: 0, end: 3 },
    moraUsed: [5, 7, 5],
  });
  assert.ok(excerpt.includes(needle));
  assert.ok(excerpt.length < longNorm.length);

  const excerptFallback = buildSenryuReviewContextExcerpt("まったく別", {
    kamigo: five,
    nakashichi: seven,
    shimogo: five2,
    formatted: `${five} ${seven} ${five2}`,
    tokenSpan: { start: 0, end: 3 },
    moraUsed: [5, 7, 5],
  });
  assert.ok(excerptFallback.length > 0);

  const twoCandidates: KuromojiToken[] = [
    ...threePhrase,
    tok("ノ", "ノ"),
    tok(five, five),
    tok(seven, seven),
    tok(five2, five2),
  ];
  const multi = extractAll575(twoCandidates);
  assert.ok(multi.length >= 2);
  assert.equal(detectFirst575(twoCandidates)?.formatted, multi[0]?.formatted);
  assert.deepEqual(multi[1]?.tokenSpan, { start: 4, end: 7 });

  assert.equal(parseSenryuAiReviewVerdict('{"verdict":"accept"}'), "accept");
  assert.equal(parseSenryuAiReviewVerdict("```json\n{\"verdict\":\"reject\"}\n```"), "reject");
  assert.equal(parseSenryuAiReviewVerdict("not json"), null);

  const spanText = formatKuromojiSpanForAiReview(threePhrase, {
    kamigo: five,
    nakashichi: seven,
    shimogo: five2,
    formatted: `${five} ${seven} ${five2}`,
    tokenSpan: { start: 0, end: 3 },
    moraUsed: [5, 7, 5],
  });
  assert.ok(spanText.includes("候補:"));
  assert.ok(spanText.includes(five));

  const reviewUser = buildSenryuAiReviewUserBlock("近傍だけ", threePhrase, {
    kamigo: five,
    nakashichi: seven,
    shimogo: five2,
    formatted: `${five} ${seven} ${five2}`,
    tokenSpan: { start: 0, end: 3 },
    moraUsed: [5, 7, 5],
  });
  assert.ok(reviewUser.includes("上句:"));
  assert.ok(reviewUser.includes("周辺文脈"));

  const mem = new Database(":memory:");
  mem.exec(readFileSync(migration013, "utf8"));
  const saved = await saveSenryu(mem, {
    guildId: "g",
    channelId: "c",
    messageId: "m",
    authorId: "a",
    kamigo: "x",
    nakashichi: "y",
    shimogo: "z",
    formatted: "x y z",
    sourceContent: "src",
    spoiler: false,
    detectedAt: new Date().toISOString(),
  });
  const row = mem.prepare("SELECT id FROM senryu_records WHERE id = ?").get(saved.id) as { id: string };
  assert.equal(row.id, saved.id);

  let replied = "";
  const fakeMessage = {
    reply: async (opts: { content: string }) => {
      replied = opts.content;
    },
  } as unknown as Message;
  await replySenryu(
    fakeMessage,
    {
      kamigo: "a",
      nakashichi: "b",
      shimogo: "c",
      formatted: "a b c",
      tokenSpan: { start: 0, end: 0 },
      moraUsed: [1, 1, 1],
    },
    false,
  );
  assert.ok(replied.includes("川柳を検出しました"));
  assert.ok(replied.includes("「a b c」"));

  await replySenryu(
    fakeMessage,
    {
      kamigo: "a",
      nakashichi: "b",
      shimogo: "c",
      formatted: "a b c",
      tokenSpan: { start: 0, end: 0 },
      moraUsed: [1, 1, 1],
    },
    true,
  );
  assert.ok(replied.includes("||"));

  await deleteSenryu(mem, saved.id);
  const gone = mem.prepare("SELECT id FROM senryu_records WHERE id = ?").get(saved.id);
  assert.equal(gone, undefined);

  mem.close();
}

void run()
  .then(() => {
    console.log("senryu.spec.ts: all assertions passed");
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
