import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createPacchiRepository } from "./pacchi.repository.js";
import { toLearnableLexiconTokens } from "./pacchi.japaneseLearning.js";
import type { AnalyzeMorphResponse } from "../japaneseAnalysis/japaneseAnalysis.types.js";

function morph(tokens: AnalyzeMorphResponse["tokens"]): AnalyzeMorphResponse {
  return { tokens, error: null };
}

async function run(): Promise<void> {
  const db = new Database(":memory:");
  const repo = createPacchiRepository(db);
  const guildId = "guild";

  const learnable = toLearnableLexiconTokens(morph([
    {
      surface: "原神",
      base: "原神",
      reading: "ゲンシン",
      pos: ["名詞", "固有名詞", "一般"],
      isProperNoun: true,
      isOov: false,
    },
    {
      surface: "猫",
      base: "猫",
      reading: "ネコ",
      pos: ["名詞", "普通名詞", "一般"],
      isProperNoun: false,
      isOov: false,
    },
    {
      surface: "走る",
      base: "走る",
      reading: "ハシル",
      pos: ["動詞", "一般"],
      isProperNoun: false,
      isOov: false,
    },
    {
      surface: "は",
      base: "は",
      reading: "ハ",
      pos: ["助詞", "係助詞"],
      isProperNoun: false,
      isOov: false,
    },
    {
      surface: "です",
      base: "です",
      reading: "デス",
      pos: ["助動詞"],
      isProperNoun: false,
      isOov: false,
    },
    {
      surface: "123",
      base: "123",
      reading: "123",
      pos: ["名詞", "数詞"],
      isProperNoun: false,
      isOov: false,
    },
  ]));

  assert.deepEqual(learnable.map((token) => token.base), ["原神", "走る"]);
  repo.learnMorph(guildId, learnable);

  const lexiconRows = db.prepare("SELECT base, is_proper_noun FROM pacchi_lexicon ORDER BY base").all() as {
    base: string;
    is_proper_noun: number;
  }[];
  assert.deepEqual(lexiconRows, [
    { base: "原神", is_proper_noun: 1 },
    { base: "走る", is_proper_noun: 0 },
  ]);

  const userDictionaryRows = db.prepare("SELECT surface, reason FROM pacchi_user_dictionary_entries").all() as {
    surface: string;
    reason: string;
  }[];
  assert.deepEqual(userDictionaryRows, [{ surface: "原神", reason: "proper_noun" }]);

  const cooccurrences = db.prepare("SELECT word_a, word_b FROM pacchi_cooccurrences").all() as {
    word_a: string;
    word_b: string;
  }[];
  assert.deepEqual(cooccurrences, [{ word_a: "原神", word_b: "走る" }]);

  db.close();
}

void run()
  .then(() => {
    console.log("pacchi.lexicon.spec.ts: all assertions passed");
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
