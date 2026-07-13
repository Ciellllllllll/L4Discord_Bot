import assert from "node:assert/strict";
import { isSafePacchiReply, isUnsafeForPacchiLearning } from "./pacchi.safety.js";

async function run(): Promise<void> {
  assert.equal(isUnsafeForPacchiLearning("https://example.com"), true);
  assert.equal(isUnsafeForPacchiLearning("<@123456789012345678> こんにちは"), true);
  assert.equal(isUnsafeForPacchiLearning("猫 <:x:123456789012345678>"), true);
  assert.equal(isUnsafeForPacchiLearning("```ts\nconsole.log(1)\n```"), true);
  assert.equal(isUnsafeForPacchiLearning("草"), true);
  assert.equal(isUnsafeForPacchiLearning("猫はかわいい"), false);

  assert.equal(isSafePacchiReply("猫、たぶんすごい"), true);
  assert.equal(isSafePacchiReply("https://example.com"), false);
  assert.equal(isSafePacchiReply("<@123456789012345678>"), false);
  assert.equal(isSafePacchiReply("草"), false);
  assert.equal(isSafePacchiReply("!!!!!!!!"), false);
}

void run()
  .then(() => {
    console.log("pacchi.safety.spec.ts: all assertions passed");
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
