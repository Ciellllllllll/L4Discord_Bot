import assert from "node:assert/strict";
import { ComponentType } from "discord.js";
import type { PreviewDocument } from "./previewDocument.js";
import type { PreviewDocumentTranslations } from "./previewTranslationGate.js";
import { buildTranslatedPreview } from "./previewPipeline.js";

const document: PreviewDocument = {
  version: 1,
  source: "x",
  url: "https://x.com/example/status/1",
  openLabel: "Xで開く",
  blocks: [{
    type: "text",
    id: "body",
    lines: [{ parts: [{ text: "Hello", translationKey: "body" }] }],
  }],
};

const usefulTranslations: PreviewDocumentTranslations = {
  model: "gpt-5.4-mini",
  translations: {
    body: {
      shouldTranslate: true,
      sourceLanguage: "en",
      confidence: 1,
      translatedText: "こんにちは",
    },
  },
};

{
  let calls = 0;
  const result = await buildTranslatedPreview(document, {
    translate: async (received) => {
      calls += 1;
      assert.equal(received, document);
      return usefulTranslations;
    },
  });

  assert.equal(calls, 1);
  assert.deepEqual(result.state, { document, translations: usefulTranslations });
  assert.equal(result.components[0]?.type, ComponentType.Container);
  assert.equal(JSON.stringify(result.components).includes("こんにちは"), true);
  assert.equal("flags" in result, false);
}

{
  let calls = 0;
  const result = await buildTranslatedPreview(document, {
    translate: async () => {
      calls += 1;
      return { translations: {} };
    },
  });

  assert.equal(calls, 1);
  assert.equal(result.state, undefined);
  assert.equal(JSON.stringify(result.components).includes("Hello"), true);
  assert.equal(JSON.stringify(result.components).includes("原文を表示"), false);
}

{
  const oversizedDocument: PreviewDocument = {
    version: 1,
    source: "youtube",
    url: "https://www.youtube.com/watch?v=hidden-translation",
    openLabel: "YouTubeで開く",
    blocks: Array.from({ length: 10 }, (_, index) => ({
      type: "text" as const,
      id: `text-${index}`,
      lines: [{ parts: [{
        text: `Text ${index}`,
        ...(index === 9 ? { translationKey: "hidden" } : {}),
      }] }],
    })),
  };
  const result = await buildTranslatedPreview(oversizedDocument, {
    translate: async () => ({
      model: "gpt-5.4-mini",
      translations: {
        hidden: {
          shouldTranslate: true,
          sourceLanguage: "en",
          confidence: 1,
          translatedText: "表示範囲外の翻訳",
        },
      },
    }),
  });

  const container = result.components[0] as { components?: unknown[] };
  assert.equal((container.components?.length ?? 0) <= 10, true);
  assert.equal(JSON.stringify(result.components).includes("表示範囲外の翻訳"), false);
  assert.equal(JSON.stringify(result.components).includes("原文を表示"), false);
  assert.equal(JSON.stringify(result.components).includes("によって翻訳されました"), false);
  assert.equal(result.state, undefined);
}

console.log("previewPipeline.spec.ts: all assertions passed");
