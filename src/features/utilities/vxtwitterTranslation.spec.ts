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
      name: "unknown でも翻訳あり",
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
      name: "und でも翻訳あり",
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
      name: "低信頼の非日本語でも翻訳あり",
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
    if (["英語高信頼は翻訳あり", "unknown でも翻訳あり", "und でも翻訳あり", "低信頼の非日本語でも翻訳あり"].includes(testCase.name)) {
      assert.ok(result.main?.translatedText, testCase.name);
    } else {
      assert.equal(result.main, undefined, testCase.name);
    }
  }

  const logs: Array<{ obj: unknown; message?: string }> = [];
  const noDecision = await mod.translateVxTwitterTexts(
    { mainText: "한국어", quoteText: "" },
    {
      config: { DEEPSEEK_API_KEY: "test-key" },
      log: { warn() {}, info(obj: unknown, message?: string) { logs.push({ obj, message }); } },
      chat: async () => ({ content: JSON.stringify({ main: { shouldTranslate: false, sourceLanguage: "ko", confidence: 0.99, translatedText: "" } }), ms: 1, model: "deepseek-test" }),
    },
  );
  assert.equal(noDecision.main, undefined);
  assert.equal(logs[0]?.message, "vxtwitter translation skipped");
}

run()
  .then(() => {
    console.log("vxtwitterTranslation.spec.ts: all assertions passed");
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
