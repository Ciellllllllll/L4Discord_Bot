import assert from "node:assert/strict";
import { test } from "node:test";
import { MessageFlags, ComponentType } from "discord.js";
import { buildSteamReplyPayloads } from "./steamLinkExpansion.js";

function componentJson(value: unknown): string {
  return JSON.stringify(value);
}

test("Steam返信はComponents v2、メンションなし、翻訳状態、Steam Clientボタンを持つ", async () => {
  const payloads = await buildSteamReplyPayloads([{
    canonicalUrl: "https://store.steampowered.com/app/730/Counter_Strike_2/",
    appid: "730",
  }], {
    client: {
      fetchPagePreview: async () => ({
        canonicalUrl: "https://store.steampowered.com/app/730/Counter_Strike_2/",
        appid: "730",
        title: "Counter-Strike 2",
        body: "A tactical shooter.",
        price: { kind: "paid" as const, usd: 9.99 },
        rating: { label: "Mostly Positive", percent: 76, reviewCount: 78_889 },
      }),
    },
    exchangeRate: async () => 150.15015015015015,
    config: { DEEPSEEK_API_KEY: "" } as never,
    translate: async () => ({
      model: "test-model",
      translations: {
        body: { shouldTranslate: true, sourceLanguage: "en", confidence: 1, translatedText: "戦術シューター。" },
        rating: { shouldTranslate: true, sourceLanguage: "en", confidence: 1, translatedText: "非常に好評" },
      },
    }),
  });

  assert.equal(payloads.length, 1);
  const payload = payloads[0]!;
  assert.equal(payload.flags, MessageFlags.IsComponentsV2);
  assert.deepEqual(payload.embeds, []);
  assert.equal("content" in payload, false);
  assert.deepEqual(payload.allowedMentions, { parse: [], repliedUser: false });
  assert.equal(payload.previewState?.document.source, "steam");
  assert.equal(componentJson(payload.components).includes("評価: 非常に好評 - 76%"), true);
  assert.equal(componentJson(payload.components).includes("Steam Clientで開く"), true);
  assert.equal(componentJson(payload.components).includes("https://s.team/a/730"), true);
  assert.equal(componentJson(payload.components).includes(`"type":${ComponentType.Container}`), true);
});

test("Steam評価はAI結果が使えない場合だけ標準の日本語へ戻す", async () => {
  const cases = [
    { name: "省略", label: "Mostly Positive", rating: undefined, expected: "やや好評" },
    {
      name: "翻訳不要",
      label: "Mostly Positive",
      rating: { shouldTranslate: false, sourceLanguage: "en", confidence: 1, translatedText: "" },
      expected: "やや好評",
    },
    {
      name: "空文字",
      label: "Mostly Positive",
      rating: { shouldTranslate: true, sourceLanguage: "en", confidence: 1, translatedText: "  " },
      expected: "やや好評",
    },
    { name: "未知ラベル", label: "New Rating", rating: undefined, expected: "New Rating" },
  ];

  for (const testCase of cases) {
    const [payload] = await buildSteamReplyPayloads([{
      canonicalUrl: "https://store.steampowered.com/app/730/Counter_Strike_2/",
      appid: "730",
    }], {
      client: {
        fetchPagePreview: async () => ({
          canonicalUrl: "https://store.steampowered.com/app/730/Counter_Strike_2/",
          appid: "730",
          title: "Counter-Strike 2",
          body: "A tactical shooter.",
          price: { kind: "paid" as const, usd: 9.99 },
          rating: { label: testCase.label, percent: 76, reviewCount: 78_889 },
        }),
      },
      exchangeRate: 150,
      translate: async () => ({
        model: "test-model",
        translations: {
          body: { shouldTranslate: true, sourceLanguage: "en", confidence: 1, translatedText: "戦術シューター。" },
          ...(testCase.rating ? { rating: testCase.rating } : {}),
        },
      }),
    });

    const components = componentJson(payload?.components);
    assert.equal(components.includes(`評価: ${testCase.expected} - 76%`), true, testCase.name);
  }
});
