import assert from "node:assert/strict";
import { ButtonStyle, ComponentType } from "discord.js";
import type { PreviewDocument } from "./previewDocument.js";
import type { PreviewDocumentTranslations } from "./previewTranslationGate.js";
import {
  buildPreviewComponents,
  patchPreviewTextComponents,
  PREVIEW_SHOW_ORIGINAL_ID,
  PREVIEW_SHOW_TRANSLATION_ID,
  replacePreviewMedia,
} from "./previewRenderer.js";

const document: PreviewDocument = {
  version: 1,
  source: "youtube",
  url: "https://www.youtube.com/watch?v=example",
  openLabel: "YouTubeで開く",
  blocks: [
    {
      type: "text",
      id: "summary",
      thumbnailUrl: "https://example.test/channel.jpg",
      thumbnailDescription: "チャンネルアイコン",
      lines: [
        {
          prefix: "投稿者: ",
          parts: [
            { text: "Example channel", strong: true },
            { text: " — " },
            { text: "Hello world", translationKey: "title" },
          ],
        },
        {
          parts: [{ text: "Description", translationKey: "description" }],
        },
      ],
    },
    {
      type: "media",
      id: "video",
      items: [{ url: "https://expired.example/video.mp4", description: "動画", spoiler: true }],
    },
  ],
};

const translations: PreviewDocumentTranslations = {
  model: "gpt-5.4-mini",
  translations: {
    title: {
      shouldTranslate: true,
      sourceLanguage: "en",
      confidence: 0.99,
      translatedText: "こんにちは世界",
    },
    description: {
      shouldTranslate: false,
      sourceLanguage: "en",
      confidence: 0.4,
      translatedText: "説明",
    },
  },
};

function containerChildren(components: readonly unknown[]): Array<Record<string, unknown>> {
  const container = components[0] as { type?: number; components?: Array<Record<string, unknown>> } | undefined;
  assert.equal(container?.type, ComponentType.Container);
  assert.ok(Array.isArray(container.components));
  return container.components;
}

function textContents(value: unknown): string[] {
  const contents: string[] = [];
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    if (!candidate || typeof candidate !== "object") return;
    const component = candidate as { type?: number; content?: unknown; components?: unknown[] };
    if (component.type === ComponentType.TextDisplay && typeof component.content === "string") {
      contents.push(component.content);
    }
    for (const child of component.components ?? []) visit(child);
  };
  visit(value);
  return contents;
}

function findButton(components: readonly unknown[], customId?: string): Record<string, unknown> | undefined {
  let result: Record<string, unknown> | undefined;
  const visit = (candidate: unknown): void => {
    if (result || !candidate || typeof candidate !== "object") return;
    const component = candidate as Record<string, unknown>;
    if (component.type === ComponentType.Button && (customId === undefined || component.custom_id === customId)) {
      result = component;
      return;
    }
    if (Array.isArray(component.components)) component.components.forEach(visit);
  };
  components.forEach(visit);
  return result;
}

function textDisplays(value: unknown): Array<Record<string, unknown>> {
  const displays: Array<Record<string, unknown>> = [];
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    if (!candidate || typeof candidate !== "object") return;
    const component = candidate as Record<string, unknown>;
    if (component.type === ComponentType.TextDisplay) displays.push(component);
    if (Array.isArray(component.components)) component.components.forEach(visit);
  };
  visit(value);
  return displays;
}

{
  const components = buildPreviewComponents(document, translations);
  const children = containerChildren(components);
  assert.equal(children[0]?.type, ComponentType.Section);
  assert.deepEqual(textContents(components), [
    "投稿者: **Example channel** — こんにちは世界\nDescription",
    "-# この投稿は gpt-5.4-mini によって翻訳されました。Made by Ciel",
  ]);
  assert.equal(children[1]?.type, ComponentType.MediaGallery);
  assert.deepEqual(children[1]?.items, [{
    media: { url: "https://expired.example/video.mp4" },
    description: "動画",
    spoiler: true,
  }]);
  const link = findButton(components);
  assert.deepEqual(link, {
    type: ComponentType.Button,
    style: ButtonStyle.Link,
    label: "YouTubeで開く",
    url: "https://www.youtube.com/watch?v=example",
  });
  const toggle = findButton(components, PREVIEW_SHOW_ORIGINAL_ID);
  assert.equal(toggle?.label, "原文を表示");
  assert.equal(toggle?.style, ButtonStyle.Secondary);
}

{
  const components = buildPreviewComponents(document, translations, "original");
  assert.deepEqual(textContents(components), [
    "投稿者: **Example channel** — Hello world\nDescription",
    "-# この投稿は gpt-5.4-mini によって翻訳されました。Made by Ciel",
  ]);
  assert.equal(findButton(components, PREVIEW_SHOW_TRANSLATION_ID)?.label, "翻訳を表示");
}

{
  const components = buildPreviewComponents(document, { translations: {} });
  assert.deepEqual(textContents(components), [
    "投稿者: **Example channel** — Hello world\nDescription",
  ]);
  assert.equal(findButton(components, PREVIEW_SHOW_ORIGINAL_ID), undefined);
  assert.equal(findButton(components, PREVIEW_SHOW_TRANSLATION_ID), undefined);
  const children = containerChildren(components);
  const row = children.at(-1) as { components?: unknown[] };
  assert.equal(row.components?.length, 1);
}

{
  const rendered = buildPreviewComponents(document, translations);
  const replaced = replacePreviewMedia(rendered, "https://media.example/shared.mp4", { fallback: true });
  const json = JSON.stringify(replaced);
  assert.equal(json.includes("https://media.example/shared.mp4"), true);
  assert.equal(json.includes("https://expired.example/video.mp4"), false);
  assert.equal(json.includes(`\"type\":${ComponentType.Section}`), true);
  assert.equal(json.includes("https://example.test/channel.jpg"), true);
  assert.equal(json.includes("こんにちは世界"), true);
  assert.equal(findButton(replaced, PREVIEW_SHOW_ORIGINAL_ID)?.label, "原文を表示");
}

{
  const rendered = buildPreviewComponents(document, translations);
  const repaired = replacePreviewMedia(
    rendered,
    "https://media.example/repaired.mp4",
    { fallback: true },
  );
  const repairedBeforeToggle = structuredClone(repaired);
  const patched = patchPreviewTextComponents(repaired, document, translations, "original");

  assert.deepEqual(textContents(patched), [
    "投稿者: **Example channel** — Hello world\nDescription",
    "-# この投稿は gpt-5.4-mini によって翻訳されました。Made by Ciel",
  ]);
  assert.equal(JSON.stringify(patched).includes("https://media.example/repaired.mp4"), true);
  assert.equal(JSON.stringify(patched).includes("https://expired.example/video.mp4"), false);
  assert.equal(JSON.stringify(patched).includes(`\"type\":${ComponentType.Section}`), true);
  assert.equal(findButton(patched, PREVIEW_SHOW_TRANSLATION_ID)?.label, "翻訳を表示");

  const beforeChildren = containerChildren(repairedBeforeToggle);
  const afterChildren = containerChildren(patched);
  assert.deepEqual(
    beforeChildren.filter((component) => component.type === ComponentType.MediaGallery),
    afterChildren.filter((component) => component.type === ComponentType.MediaGallery),
  );
  assert.deepEqual(findButton(repairedBeforeToggle), findButton(patched));
}

{
  const rendered = buildPreviewComponents(document, translations);
  const repaired = replacePreviewMedia(
    rendered,
    "https://media.example/repaired-with-id.mp4",
    { fallback: true },
  );
  const repairedChildren = containerChildren(repaired);
  repairedChildren.unshift({
    type: ComponentType.TextDisplay,
    id: 100,
    content: "外部バナー",
  });
  repairedChildren.splice(2, 0, {
    type: ComponentType.TextDisplay,
    id: 101,
    content: "外部注記",
  });

  const rendererIds = textDisplays(rendered)
    .map((component) => component.id)
    .filter((id): id is number => typeof id === "number");
  assert.equal(rendererIds.length, 2);
  assert.equal(new Set(rendererIds).size, rendererIds.length);
  assert.equal(textDisplays(repaired).some((component) => rendererIds.includes(component.id as number)), true);

  const patched = patchPreviewTextComponents(repaired, document, translations, "original");
  const patchedDisplays = textDisplays(patched);
  assert.equal(patchedDisplays.find((component) => component.id === 100)?.content, "外部バナー");
  assert.equal(patchedDisplays.find((component) => component.id === 101)?.content, "外部注記");
  assert.equal(
    patchedDisplays.find((component) => component.id === rendererIds[0])?.content,
    "投稿者: **Example channel** — Hello world\nDescription",
  );
  assert.equal(
    patchedDisplays.find((component) => component.id === rendererIds[1])?.content,
    "-# この投稿は gpt-5.4-mini によって翻訳されました。Made by Ciel",
  );
  assert.equal(JSON.stringify(patched).includes("https://media.example/repaired-with-id.mp4"), true);
}

{
  const whitespaceModel = { ...translations, model: "   " };
  const translated = buildPreviewComponents(document, whitespaceModel);
  assert.deepEqual(textContents(translated), [
    "投稿者: **Example channel** — こんにちは世界\nDescription",
  ]);
  assert.equal(findButton(translated, PREVIEW_SHOW_ORIGINAL_ID)?.label, "原文を表示");

  const original = patchPreviewTextComponents(translated, document, whitespaceModel, "original");
  assert.deepEqual(textContents(original), [
    "投稿者: **Example channel** — Hello world\nDescription",
  ]);
  assert.equal(findButton(original, PREVIEW_SHOW_TRANSLATION_ID)?.label, "翻訳を表示");

  const translatedAgain = patchPreviewTextComponents(original, document, whitespaceModel, "translation");
  assert.deepEqual(textContents(translatedAgain), [
    "投稿者: **Example channel** — こんにちは世界\nDescription",
  ]);
  assert.equal(findButton(translatedAgain, PREVIEW_SHOW_ORIGINAL_ID)?.label, "原文を表示");
}

{
  const oversizedDocument: PreviewDocument = {
    version: 1,
    source: "youtube",
    url: "https://www.youtube.com/watch?v=oversized",
    openLabel: "YouTubeで開く",
    blocks: [
      { type: "media", id: "empty-media", items: [] },
      ...Array.from({ length: 11 }, (_, index) => ({
        type: "text" as const,
        id: `text-${index}`,
        lines: [{ parts: [{
          text: `Text ${index}`,
          ...(index === 0 ? { translationKey: "visible" } : {}),
        }] }],
      })),
    ],
  };
  const components = buildPreviewComponents(oversizedDocument, {
    model: "gpt-5.4-mini",
    translations: {
      visible: {
        shouldTranslate: true,
        sourceLanguage: "en",
        confidence: 1,
        translatedText: "表示される翻訳",
      },
    },
  });
  const children = containerChildren(components);
  assert.equal(children.length, 10);
  assert.equal(children.some((component) => (
    component.type === ComponentType.MediaGallery
    && Array.isArray(component.items)
    && component.items.length === 0
  )), false);
  assert.equal(textContents(components).includes("表示される翻訳"), true);
  assert.equal(findButton(components, PREVIEW_SHOW_ORIGINAL_ID)?.label, "原文を表示");
}

console.log("previewRenderer.spec.ts: all assertions passed");
