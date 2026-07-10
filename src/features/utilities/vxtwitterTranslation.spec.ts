import assert from "node:assert/strict";

async function run(): Promise<void> {
  const mod = await import("./vxtwitterTranslation.js").catch(() => null);
  assert.ok(mod, "vxtwitterTranslation.ts が未実装です");

  const parsed = mod.parseDeepSeekJsonResponse(`
\`\`\`json
{"shouldTranslate":true,"sourceLanguage":"en","confidence":0.98,"translatedText":"こんにちは"}
\`\`\`
`);
  assert.equal(parsed.shouldTranslate, true);
  assert.equal(parsed.sourceLanguage, "en");
  assert.equal(parsed.translatedText, "こんにちは");

  let called = 0;
  const skipped = await mod.translateVxTwitterTexts(
    {
      mainText: "Hello",
      quoteText: "Quoted",
    },
    {
      config: { DEEPSEEK_API_KEY: "" },
      log: { warn() {} },
      chat: async () => {
        called += 1;
        return { content: "", ms: 0, model: "deepseek-test" };
      },
    },
  );
  assert.equal(called, 1, "DeepSeekキーだけでAI翻訳を早期終了しない");
  assert.equal(skipped.main, undefined);
  assert.equal(skipped.quote, undefined);

  const translated = await mod.translateVxTwitterTexts(
    {
      mainText: "We won the finals",
      quoteText: "Meme phrase only",
    },
    {
      config: { DEEPSEEK_API_KEY: "test-key" },
      log: { warn() {} },
      chat: async () => ({
        content: JSON.stringify({
          main: {
            shouldTranslate: true,
            sourceLanguage: "en",
            confidence: 0.99,
            translatedText: "決勝に勝った",
          },
          quote: {
            shouldTranslate: false,
            sourceLanguage: "und",
            confidence: 0.3,
            translatedText: "",
          },
        }),
        ms: 12,
        model: "deepseek-test",
      }),
    },
  );
  assert.equal(translated.main?.translatedText, "決勝に勝った");
  assert.equal(translated.quote, undefined);

  const invalidJson = await mod.translateVxTwitterTexts(
    {
      mainText: "This should not throw",
      quoteText: "Even with broken JSON",
    },
    {
      config: { DEEPSEEK_API_KEY: "test-key" },
      log: { warn() {} },
      chat: async () => ({
        content: "{invalid json",
        ms: 3,
        model: "deepseek-test",
      }),
    },
  );
  assert.deepEqual(invalidJson, {});

  const decisionCases = [
    {
      name: "日本語 sourceLanguage は翻訳なし",
      input: { mainText: "そのまま", quoteText: "" },
      response: {
        main: {
          shouldTranslate: true,
          sourceLanguage: "ja",
          confidence: 0.99,
          translatedText: "翻訳されるべきではない",
        },
      },
    },
    {
      name: "unknown は翻訳なし",
      input: { mainText: "mystery", quoteText: "" },
      response: {
        main: {
          shouldTranslate: true,
          sourceLanguage: "unknown",
          confidence: 0.99,
          translatedText: "翻訳されるべきではない",
        },
      },
    },
    {
      name: "und は翻訳なし",
      input: { mainText: "mystery", quoteText: "" },
      response: {
        main: {
          shouldTranslate: true,
          sourceLanguage: "und",
          confidence: 0.99,
          translatedText: "翻訳されるべきではない",
        },
      },
    },
    {
      name: "confidence < 0.75 は翻訳なし",
      input: { mainText: "Hello", quoteText: "" },
      response: {
        main: {
          shouldTranslate: true,
          sourceLanguage: "en",
          confidence: 0.74,
          translatedText: "こんにちは",
        },
      },
    },
    {
      name: "translatedText 空は翻訳なし",
      input: { mainText: "Hello", quoteText: "" },
      response: {
        main: {
          shouldTranslate: true,
          sourceLanguage: "en",
          confidence: 0.99,
          translatedText: "",
        },
      },
    },
    {
      name: "original と translatedText が実質同文なら翻訳なし",
      input: { mainText: "Hello   world", quoteText: "" },
      response: {
        main: {
          shouldTranslate: true,
          sourceLanguage: "en",
          confidence: 0.99,
          translatedText: "Hello world",
        },
      },
    },
    {
      name: "英語高信頼は翻訳あり",
      input: { mainText: "Hello world", quoteText: "" },
      response: {
        main: {
          shouldTranslate: true,
          sourceLanguage: "en",
          confidence: 0.99,
          translatedText: "こんにちは世界",
        },
      },
    },
  ] as const;

  for (const testCase of decisionCases) {
    const result = await mod.translateVxTwitterTexts(
      testCase.input,
      {
        config: { DEEPSEEK_API_KEY: "test-key" },
        log: { warn() {} },
        chat: async () => ({
          content: JSON.stringify(testCase.response),
          ms: 1,
          model: "deepseek-test",
        }),
      },
    );
    if (testCase.name === "英語高信頼は翻訳あり") {
      assert.equal(result.main?.translatedText, "こんにちは世界", testCase.name);
    } else {
      assert.equal(result.main, undefined, testCase.name);
    }
  }
}

run()
  .then(() => {
    console.log("vxtwitterTranslation.spec.ts: all assertions passed");
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
