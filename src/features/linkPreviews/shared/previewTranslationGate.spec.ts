import assert from "node:assert/strict";
import type { AiProviderRouter, AiRouterChatOptions, AiTask } from "../../ai/aiProviderRouter.js";
import type { ChatMessage } from "../../ai/chatTypes.js";
import { translatePreviewDocument } from "./previewTranslationGate.js";
import type { PreviewDocument } from "./previewDocument.js";

const document: PreviewDocument = {
  version: 1,
  source: "youtube",
  url: "https://www.youtube.com/watch?v=example",
  openLabel: "YouTubeで開く",
  blocks: [
    {
      type: "text",
      id: "summary",
      lines: [
        { parts: [{ text: "Hello world", translationKey: "title" }] },
        { parts: [{ text: "First description", translationKey: "description" }] },
        { parts: [{ text: "Ignored label" }] },
        { parts: [{ text: "Different duplicate", translationKey: "description" }] },
      ],
    },
  ],
};

async function run(): Promise<void> {
  let request: Record<string, unknown> | undefined;
  const translated = await translatePreviewDocument(document, {
    config: { DEEPSEEK_API_KEY: "test-key" },
    chat: async (_config, messages) => {
      request = JSON.parse(messages[1]?.content ?? "{}") as Record<string, unknown>;
      return {
        content: `\`\`\`json
${JSON.stringify({
  translations: {
    title: { shouldTranslate: true, sourceLanguage: "en", confidence: 98, translatedText: "こんにちは世界" },
    description: { shouldTranslate: true, sourceLanguage: "en", confidence: 0.7, translatedText: "最初の説明" },
  },
})}
\`\`\``,
        ms: 1,
        model: "deepseek-test",
      };
    },
  });
  assert.deepEqual(request?.segments, {
    title: "Hello world",
    description: "First description",
  }, "同じ翻訳キーは最初の本文だけをAIへ送る");
  assert.deepEqual(translated, {
    model: "deepseek-test",
    translations: {
      title: { shouldTranslate: true, sourceLanguage: "en", confidence: 0.98, translatedText: "こんにちは世界" },
      description: { shouldTranslate: true, sourceLanguage: "en", confidence: 0.7, translatedText: "最初の説明" },
    },
  });

  let routedTask: string | undefined;
  let routedOptions: Record<string, unknown> | undefined;
  const routed = await translatePreviewDocument(document, {
    config: { DEEPSEEK_API_KEY: "test-key", AI_REQUEST_TIMEOUT_MS: 60_000 },
    guildId: "guild",
    router: {
      async chat(
        guildId: string,
        task: AiTask,
        _messages: ChatMessage[],
        options: AiRouterChatOptions,
      ) {
        assert.equal(guildId, "guild");
        routedTask = task;
        routedOptions = options;
        return {
          content: JSON.stringify({ translations: {
            title: { shouldTranslate: true, sourceLanguage: "en", confidence: 1, translatedText: "ルーター翻訳" },
          } }),
          ms: 1,
          model: "router-model",
          provider: "deepseek",
          fallbackReason: "openai_unconfigured",
        };
      },
    } as unknown as AiProviderRouter,
  });
  assert.equal(routedTask, "preview_translation");
  assert.deepEqual(routedOptions, {
    thinking: false,
    temperature: 0,
    sanitizeOutput: false,
    timeoutMs: 15_000,
  });
  assert.deepEqual(routed, {
    model: "router-model",
    translations: {
      title: { shouldTranslate: true, sourceLanguage: "en", confidence: 1, translatedText: "ルーター翻訳" },
    },
  });

  const partiallyTranslated = await translatePreviewDocument(document, {
    config: { DEEPSEEK_API_KEY: "test-key" },
    chat: async () => ({
      content: JSON.stringify({ translations: {
        title: { shouldTranslate: true, sourceLanguage: "en", confidence: 1, translatedText: "部分翻訳" },
        description: { shouldTranslate: false, sourceLanguage: "ja", confidence: 1, translatedText: "" },
      } }),
      ms: 1,
      model: "deepseek-test",
    }),
  });
  assert.deepEqual(partiallyTranslated, {
    model: "deepseek-test",
    translations: {
      title: { shouldTranslate: true, sourceLanguage: "en", confidence: 1, translatedText: "部分翻訳" },
    },
  });

  const noKeys = await translatePreviewDocument({ ...document, blocks: [{ type: "text", id: "plain", lines: [{ parts: [{ text: "日本語" }] }] }] }, {
    config: { DEEPSEEK_API_KEY: "test-key" },
    chat: async () => { throw new Error("翻訳キーがなければ呼ばれない"); },
  });
  assert.deepEqual(noKeys, { translations: {} });

  const unusable = await translatePreviewDocument(document, {
    config: { DEEPSEEK_API_KEY: "test-key" },
    chat: async () => ({
      content: JSON.stringify({ translations: {
        title: { shouldTranslate: true, sourceLanguage: "ja", confidence: 1, translatedText: "訳さない" },
        description: { shouldTranslate: true, sourceLanguage: "en", confidence: 1, translatedText: "First description" },
      } }),
      ms: 1,
      model: "deepseek-test",
    }),
  });
  assert.deepEqual(unusable, { translations: {} });

  const failed = await translatePreviewDocument(document, {
    config: { DEEPSEEK_API_KEY: "test-key" },
    log: { warn() {} },
    chat: async () => ({ content: "{invalid json", ms: 1, model: "deepseek-test" }),
  });
  assert.deepEqual(failed, { translations: {} });
}

run()
  .then(() => console.log("previewTranslationGate.spec.ts: all assertions passed"))
  .catch((error) => { console.error(error); process.exitCode = 1; });
