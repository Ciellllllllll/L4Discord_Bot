import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createPacchiRepository } from "./pacchi.repository.js";
import { buildSentencePattern } from "./pacchi.japaneseLearning.js";
import type { AnalyzeMorphResponse, JapaneseMorphToken } from "../japaneseAnalysis/japaneseAnalysis.types.js";

function token(surface: string, pos: string[], extra?: Partial<JapaneseMorphToken>): JapaneseMorphToken {
  return {
    surface,
    base: surface,
    reading: surface,
    pos,
    isProperNoun: false,
    isOov: false,
    ...extra,
  };
}

function morph(tokens: JapaneseMorphToken[]): AnalyzeMorphResponse {
  return { tokens, error: null };
}

async function run(): Promise<void> {
  const pattern = buildSentencePattern("猫は速く走る", morph([
    token("猫", ["名詞", "普通名詞"]),
    token("は", ["助詞", "係助詞"]),
    token("速く", ["形容詞"]),
    token("走る", ["動詞"]),
  ]));
  assert.ok(pattern);
  assert.equal(pattern.surfacePattern, "{NOUN}は{ADJECTIVE}{VERB}");
  assert.deepEqual(pattern.slots, ["NOUN", "ADJECTIVE", "VERB"]);

  assert.equal(buildSentencePattern("猫から走る", morph([
    token("猫", ["名詞", "普通名詞"]),
    token("から", ["助詞"]),
    token("走る", ["動詞"]),
  ]))?.surfacePattern, "{NOUN}{VERB}");

  assert.equal(buildSentencePattern("https://example.com 猫は走る", morph([
    token("猫", ["名詞", "普通名詞"]),
    token("走る", ["動詞"]),
  ])), null);

  assert.equal(buildSentencePattern("原神", morph([
    token("原神", ["名詞", "固有名詞"], { isProperNoun: true }),
  ])), null);

  const db = new Database(":memory:");
  const repo = createPacchiRepository(db);
  repo.learnSentencePattern("guild", pattern);
  const row = db.prepare("SELECT surface_pattern, slots_json FROM pacchi_sentence_patterns").get() as {
    surface_pattern: string;
    slots_json: string;
  };
  assert.equal(row.surface_pattern, "{NOUN}は{ADJECTIVE}{VERB}");
  assert.deepEqual(JSON.parse(row.slots_json) as string[], ["NOUN", "ADJECTIVE", "VERB"]);
  db.close();
}

void run()
  .then(() => {
    console.log("pacchi.pattern.spec.ts: all assertions passed");
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
