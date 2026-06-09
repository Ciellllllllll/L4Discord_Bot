import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createPacchiRepository } from "./pacchi.repository.js";
import { buildPacchiGeneratedReply } from "./pacchi.generator.js";

async function run(): Promise<void> {
  const db = new Database(":memory:");
  const repo = createPacchiRepository(db);
  const guildId = "guild";
  repo.learn(guildId, ["話題"], null);
  repo.learnMorph(guildId, [
    {
      surface: "原神",
      base: "原神",
      reading: "ゲンシン",
      pos: ["名詞", "固有名詞", "一般"],
      isProperNoun: true,
      isOov: false,
      source: "spec",
    },
    {
      surface: "猫",
      base: "猫",
      reading: "ネコ",
      pos: ["名詞", "普通名詞", "一般"],
      isProperNoun: false,
      isOov: false,
      source: "spec",
    },
    {
      surface: "速い",
      base: "速い",
      reading: "ハヤイ",
      pos: ["形容詞"],
      isProperNoun: false,
      isOov: false,
      source: "spec",
    },
  ]);
  repo.learnSentencePattern(guildId, {
    surfacePattern: "{NOUN}は{ADJECTIVE}かも",
    slots: ["NOUN", "ADJECTIVE"],
    ending: "かも",
    sourceKind: "spec",
    safeLevel: 1,
  });

  const originalRandom = Math.random;
  Math.random = () => 0;
  try {
    const fixed = buildPacchiGeneratedReply(repo, guildId, "template");
    assert.ok(fixed.length > 0);
    assert.equal(fixed.includes("草"), false);

    const slot = buildPacchiGeneratedReply(repo, guildId, "slot-template");
    assert.match(slot, /原神|猫|速い|話題/);
    assert.equal(slot.includes("草"), false);

    const learned = buildPacchiGeneratedReply(repo, guildId, "learned-pattern");
    assert.match(learned, /猫/);
    assert.match(learned, /速い/);
    assert.equal(learned.includes("草"), false);

    const duplicateA = buildPacchiGeneratedReply(repo, "duplicate-guild", "template");
    const duplicateB = buildPacchiGeneratedReply(repo, "duplicate-guild", "template");
    assert.notEqual(duplicateA, duplicateB);
  } finally {
    Math.random = originalRandom;
  }

  db.close();
}

void run()
  .then(() => {
    console.log("pacchi.generator.spec.ts: all assertions passed");
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
