import assert from "node:assert/strict";
import type { PacchiRepositoryLike } from "./pacchi.repository.js";
import { buildPacchiGeneratedReply } from "./pacchi.generator.js";

async function run(): Promise<void> {
  const guildId = "guild";
  const repo = {
    async pickWord() { return "話題"; },
    async relatedWords() { return []; },
    async randomSentencePattern() { return { surface_pattern: "{NOUN}は{ADJECTIVE}かも" }; },
    async topLexiconByPos(_guildId: string, pos: string) {
      if (pos === "固有名詞") return [{ base: "原神", count: 1, is_proper_noun: 1 }];
      if (pos === "名詞") return [{ base: "猫", count: 1, is_proper_noun: 0 }];
      if (pos === "形容詞") return [{ base: "速い", count: 1, is_proper_noun: 0 }];
      return [];
    },
  } as unknown as PacchiRepositoryLike;

  const originalRandom = Math.random;
  Math.random = () => 0;
  try {
    const fixed = await buildPacchiGeneratedReply(repo, guildId, "template");
    assert.ok(fixed.length > 0);
    assert.equal(fixed.includes("草"), false);

    const slot = await buildPacchiGeneratedReply(repo, guildId, "slot-template");
    assert.match(slot, /原神|猫|速い|話題/);
    assert.equal(slot.includes("草"), false);

    const learned = await buildPacchiGeneratedReply(repo, guildId, "learned-pattern");
    assert.match(learned, /猫/);
    assert.match(learned, /速い/);
    assert.equal(learned.includes("草"), false);

    const duplicateA = await buildPacchiGeneratedReply(repo, "duplicate-guild", "template");
    const duplicateB = await buildPacchiGeneratedReply(repo, "duplicate-guild", "template");
    assert.notEqual(duplicateA, duplicateB);
  } finally {
    Math.random = originalRandom;
  }
}

void run()
  .then(() => {
    console.log("pacchi.generator.spec.ts: all assertions passed");
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
