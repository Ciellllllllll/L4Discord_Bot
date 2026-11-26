import assert from "node:assert/strict";
import {
  parseDeepSeekJsonResponse,
  translateVxTwitterTexts,
} from "./vxtwitterTranslation.js";

assert.equal(parseDeepSeekJsonResponse("```json\n{\"ok\":true}\n```").ok, true);

{
  let task = "";
  let userMessage = "";
  const translated = await translateVxTwitterTexts({
    mainText: "Hello",
    quoteText: "Quoted",
  }, {
    config: { DEEPSEEK_API_KEY: "test-key" },
    guildId: "guild-1",
    router: {
      async chat(_guildId: string, receivedTask: string, messages: Array<{ role: string; content: string }>) {
        task = receivedTask;
        userMessage = messages.at(-1)?.content ?? "";
        return {
          content: JSON.stringify({
            translations: {
              main: { shouldTranslate: true, sourceLanguage: "en", confidence: 1, translatedText: "こんにちは" },
              quote: { shouldTranslate: false, sourceLanguage: "ja", confidence: 1, translatedText: "" },
            },
          }),
          model: "test-model",
          ms: 1,
        };
      },
    } as never,
  });
  assert.equal(task, "preview_translation");
  assert.equal(JSON.parse(userMessage).segments.main, "Hello");
  assert.equal(JSON.parse(userMessage).segments.quote, "Quoted");
  assert.equal(translated.main?.translatedText, "こんにちは");
  assert.equal(translated.quote, undefined);
  assert.equal(translated.model, "test-model");
}

{
  const invalid = await translateVxTwitterTexts({ mainText: "Hello" }, {
    config: { DEEPSEEK_API_KEY: "test-key" },
    log: { warn() {} },
    chat: async () => ({ content: "{", model: "test-model", ms: 1 }),
  });
  assert.deepEqual(invalid, {});
}

console.log("vxtwitterTranslation.spec.ts: all assertions passed");
