import assert from "node:assert/strict";
import { test } from "node:test";
import { ButtonStyle, ComponentType, MessageFlags } from "discord.js";
import type { PreviewTranslationStateV1 } from "./previewState.repository.js";
import {
  handlePreviewInteraction,
  previewToggleMode,
} from "./previewInteractions.js";

const state: PreviewTranslationStateV1 = {
  version: 1,
  messageId: "message-1",
  guildId: "guild-1",
  channelId: "channel-1",
  sourceUrl: "https://www.youtube.com/watch?v=abcdefghijk",
  document: {
    version: 1,
    source: "youtube",
    url: "https://www.youtube.com/watch?v=abcdefghijk",
    openLabel: "YouTubeで開く",
    blocks: [
      { type: "text", id: "summary", lines: [{ parts: [{ text: "Hello", translationKey: "title" }] }] },
      { type: "media", id: "media", items: [{ url: "https://origin.example/video.mp4" }] },
    ],
  },
  translations: {
    model: "test-model",
    translations: {
      title: { shouldTranslate: true, sourceLanguage: "en", confidence: 0.9, translatedText: "こんにちは" },
    },
  },
};

function components(toggleId = "preview:show-original") {
  return [{
    type: ComponentType.Container,
    components: [
      { type: ComponentType.TextDisplay, id: 2_140_000_000, content: "こんにちは" },
      { type: ComponentType.MediaGallery, items: [{ media: { url: "https://vps.example/current.mp4" } }] },
      { type: ComponentType.TextDisplay, id: 2_140_000_100, content: "-# attribution" },
      {
        type: ComponentType.ActionRow,
        components: [
          { type: ComponentType.Button, style: ButtonStyle.Link, label: "YouTubeで開く", url: state.sourceUrl },
          { type: ComponentType.Button, style: ButtonStyle.Secondary, label: "原文を表示", custom_id: toggleId },
        ],
      },
    ],
  }];
}

function fetchedComponents(apiComponents = components()) {
  return apiComponents.map((component) => ({
    toJSON: () => structuredClone(component),
  }));
}

function interaction(overrides: Record<string, unknown> = {}) {
  const calls: Array<{ method: string; payload?: unknown }> = [];
  const value = {
    customId: "preview:show-original",
    guildId: "guild-1",
    channelId: "channel-1",
    deferred: false,
    replied: false,
    message: {
      id: "message-1",
      author: { id: "bot-1" },
      components: fetchedComponents(),
      async fetch() { return this; },
    },
    async deferUpdate() { value.deferred = true; calls.push({ method: "deferUpdate" }); },
    async editReply(payload: unknown) { calls.push({ method: "editReply", payload }); },
    async reply(payload: unknown) { value.replied = true; calls.push({ method: "reply", payload }); },
    async followUp(payload: unknown) { calls.push({ method: "followUp", payload }); },
    ...overrides,
  };
  return { value, calls };
}

const ctx = {
  config: { GUILD_ID: "guild-1" },
  client: { user: { id: "bot-1" } },
  db: {},
  log: { warn() {} },
} as never;

test("toggle mode accepts exact common and legacy ids only", () => {
  assert.equal(previewToggleMode("preview:show-original"), "original");
  assert.equal(previewToggleMode("preview:show-translation"), "translation");
  assert.equal(previewToggleMode("vxpreview:show-original"), "original");
  assert.equal(previewToggleMode("vxpreview:show-translation"), "translation");
  assert.equal(previewToggleMode("preview:show-original:extra"), null);
});

test("unknown ids and invalid guild, channel, or author are not consumed", async () => {
  for (const overrides of [
    { customId: "other:button" },
    { guildId: "other-guild" },
    { channelId: null },
    { message: { id: "message-1", author: { id: "human" }, components: components() } },
  ]) {
    const item = interaction(overrides);
    assert.equal(await handlePreviewInteraction(item.value as never, ctx, { getState: async () => state }), false);
    assert.deepEqual(item.calls, []);
  }
});

test("legacy ids fall through without acknowledgement when common v1 state is missing or legacy", async () => {
  const missing = interaction({ customId: "vxpreview:show-original" });
  assert.equal(await handlePreviewInteraction(missing.value as never, ctx, { getState: async () => null }), false);
  assert.deepEqual(missing.calls, []);

  const legacy = interaction({ customId: "vxpreview:show-translation" });
  assert.equal(await handlePreviewInteraction(legacy.value as never, ctx, {
    getState: async () => ({
      version: 0,
      messageId: "message-1",
      guildId: "guild-1",
      channelId: "channel-1",
      sourceUrl: "https://x.com/user/status/123",
      document: { version: 0, source: "x", legacyTweet: {} },
      translations: { version: 0, source: "x", legacyTranslations: {} },
    }),
  }), false);
  assert.deepEqual(legacy.calls, []);
});

test("a new id with no usable state is consumed with an ephemeral explanation", async () => {
  const item = interaction();
  assert.equal(await handlePreviewInteraction(item.value as never, ctx, {
    getState: async () => {
      assert.equal(item.value.deferred, true);
      return null;
    },
  }), true);
  assert.deepEqual(item.calls, [
    { method: "deferUpdate" },
    {
      method: "followUp",
      payload: {
      content: "保存されたプレビュー情報が見つからないため、表示を切り替えられませんでした。",
      flags: MessageFlags.Ephemeral,
      },
    },
  ]);
});

test("missing common state is rebuilt by an injected source dispatcher and patches only latest text", async () => {
  const latest = components();
  const latestContainer = latest[0] as any;
  latestContainer.components[1].items[0].media.url = "https://vps.example/refreshed.mp4";
  let refreshCalls = 0;
  let saveCalls = 0;
  const item = interaction({
    message: {
      id: "message-1",
      author: { id: "bot-1" },
      components: fetchedComponents(components()),
      async fetch() { return { ...this, components: fetchedComponents(latest) }; },
    },
  });
  assert.equal(await handlePreviewInteraction(item.value as never, ctx, {
    getState: async () => null,
    refreshState: async ({ message }) => {
      refreshCalls += 1;
      assert.equal(message.components.length, 1);
      return state;
    },
    saveState: async (_db, refreshed) => {
      saveCalls += 1;
      assert.equal(refreshed.messageId, "message-1");
    },
  }), true);
  assert.equal(refreshCalls, 1);
  assert.equal(saveCalls, 1);
  const payload = item.calls.at(-1)?.payload as { components: any[] };
  assert.equal(payload.components[0].components[0].content, "Hello");
  assert.equal(payload.components[0].components[1].items[0].media.url, "https://vps.example/refreshed.mp4");
});

test("state guild or channel mismatch is consumed for new ids and falls through for legacy ids", async () => {
  for (const cached of [
    { ...state, guildId: "other" },
    { ...state, channelId: "other" },
  ]) {
    const item = interaction();
    assert.equal(await handlePreviewInteraction(item.value as never, ctx, { getState: async () => cached }), true);
    assert.deepEqual(item.calls.map((call) => call.method), ["deferUpdate", "followUp"]);

    const legacy = interaction({ customId: "vxpreview:show-original" });
    assert.equal(await handlePreviewInteraction(legacy.value as never, ctx, { getState: async () => cached }), false);
    assert.deepEqual(legacy.calls, []);
  }
});

test("toggle patches only preview text and button while preserving current media and link", async () => {
  const item = interaction();
  assert.equal(await handlePreviewInteraction(item.value as never, ctx, { getState: async () => state }), true);
  assert.equal(item.calls[0]?.method, "deferUpdate");
  const payload = item.calls[1]?.payload as { components: any[] };
  const container = payload.components[0];
  assert.equal(container.components[0].content, "Hello");
  assert.equal(container.components[1].items[0].media.url, "https://vps.example/current.mp4");
  assert.equal(container.components[3].components[0].url, state.sourceUrl);
  assert.equal(container.components[3].components[1].custom_id, "preview:show-translation");
  assert.equal(container.components[3].components[1].label, "翻訳を表示");
});

test("toggle refetches the message and preserves cache-repaired media and flattened structure", async () => {
  const stale = components();
  const staleContainer = stale[0] as any;
  staleContainer.components[1].items[0].media.url = "https://stale.example/video.mp4";
  staleContainer.components[0] = {
    type: ComponentType.Section,
    components: [{ type: ComponentType.TextDisplay, id: 2_140_000_000, content: "こんにちは" }],
    accessory: { type: ComponentType.Thumbnail, media: { url: "https://stale.example/thumbnail.jpg" } },
  } as never;
  const latest = components();
  const latestContainer = latest[0] as any;
  latestContainer.components[1].items[0].media.url = "https://vps.example/repaired.mp4";
  const order: string[] = [];
  const item = interaction({
    message: {
      id: "message-1",
      author: { id: "bot-1" },
      components: fetchedComponents(stale),
      async fetch() {
        order.push("fetch");
        return { ...this, components: fetchedComponents(latest) };
      },
    },
    async editReply(payload: unknown) { order.push("edit"); item.calls.push({ method: "editReply", payload }); },
  });
  assert.equal(await handlePreviewInteraction(item.value as never, ctx, {
    getState: async () => { order.push("state"); return state; },
  }), true);
  assert.deepEqual(order, ["state", "fetch", "edit"]);
  const payload = item.calls.at(-1)?.payload as { components: any[] };
  const container = payload.components[0];
  assert.equal(container.components[0].type, ComponentType.TextDisplay);
  assert.equal(container.components[0].content, "Hello");
  assert.equal(container.components[1].items[0].media.url, "https://vps.example/repaired.mp4");
  assert.equal(container.components[3].components[0].url, state.sourceUrl);
  assert.equal(container.components[3].components[1].custom_id, "preview:show-translation");
});

test("toggle converts fetched discord.js component objects through toJSON before patching", async () => {
  const latest = components();
  const latestContainer = latest[0] as any;
  latestContainer.components[1].items[0].media.url = "https://vps.example/to-json.mp4";
  const item = interaction({
    message: {
      id: "message-1",
      author: { id: "bot-1" },
      components: fetchedComponents(components()),
      async fetch() {
        return { ...this, components: fetchedComponents(latest) };
      },
    },
  });
  assert.equal(await handlePreviewInteraction(item.value as never, ctx, { getState: async () => state }), true);
  const payload = item.calls.at(-1)?.payload as { components: any[] };
  const container = payload.components[0];
  assert.equal(container.type, ComponentType.Container);
  assert.equal(container.components[0].content, "Hello");
  assert.equal(container.components[1].items[0].media.url, "https://vps.example/to-json.mp4");
  assert.equal(container.components[3].components[1].custom_id, "preview:show-translation");
});

test("a v1 state reached through a legacy id is handled by the common patcher", async () => {
  const item = interaction({
    customId: "vxpreview:show-original",
    message: {
      id: "message-1",
      author: { id: "bot-1" },
      components: fetchedComponents(components("vxpreview:show-original")),
      async fetch() { return this; },
    },
  });
  assert.equal(await handlePreviewInteraction(item.value as never, ctx, { getState: async () => state }), true);
  const payload = item.calls[1]?.payload as { components: any[] };
  assert.equal(payload.components[0].components[3].components[1].custom_id, "preview:show-translation");
});

test("edits for the same message are serialized", async () => {
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const order: string[] = [];
  const first = interaction({
    async editReply() { order.push("first:start"); await firstGate; order.push("first:end"); },
  });
  const second = interaction({
    customId: "preview:show-translation",
    async editReply() { order.push("second:start"); },
  });
  const firstPromise = handlePreviewInteraction(first.value as never, ctx, { getState: async () => state });
  await new Promise((resolve) => setImmediate(resolve));
  const secondPromise = handlePreviewInteraction(second.value as never, ctx, { getState: async () => state });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["first:start"]);
  releaseFirst();
  await Promise.all([firstPromise, secondPromise]);
  assert.deepEqual(order, ["first:start", "first:end", "second:start"]);
});

test("toggle failures are logged and reported after acknowledgement", async () => {
  const warnings: unknown[] = [];
  const item = interaction({ async editReply() { throw new Error("edit failed"); } });
  assert.equal(await handlePreviewInteraction(item.value as never, {
    config: { GUILD_ID: "guild-1" },
    client: { user: { id: "bot-1" } },
    db: {},
    log: { warn: (value: unknown) => { warnings.push(value); } },
  } as never, { getState: async () => state }), true);
  assert.equal(warnings.length, 1);
  assert.equal(item.calls.some((call) => call.method === "followUp"), true);
});

test("message refetch failures use the acknowledged error path without editing a stale snapshot", async () => {
  const warnings: unknown[] = [];
  const item = interaction({
    message: {
      id: "message-1",
      author: { id: "bot-1" },
      components: fetchedComponents(),
      async fetch() { throw new Error("fetch failed"); },
    },
  });
  assert.equal(await handlePreviewInteraction(item.value as never, {
    config: { GUILD_ID: "guild-1" },
    client: { user: { id: "bot-1" } },
    db: {},
    log: { warn: (value: unknown) => { warnings.push(value); } },
  } as never, { getState: async () => state }), true);
  assert.equal(warnings.length, 1);
  assert.deepEqual(item.calls.map((call) => call.method), ["deferUpdate", "followUp"]);
});

test("fetched component toJSON failures use the acknowledged error path", async () => {
  const warnings: unknown[] = [];
  const item = interaction({
    message: {
      id: "message-1",
      author: { id: "bot-1" },
      components: [{ toJSON() { throw new Error("invalid component"); } }],
      async fetch() { return this; },
    },
  });
  assert.equal(await handlePreviewInteraction(item.value as never, {
    config: { GUILD_ID: "guild-1" },
    client: { user: { id: "bot-1" } },
    db: {},
    log: { warn: (value: unknown) => { warnings.push(value); } },
  } as never, { getState: async () => state }), true);
  assert.equal(warnings.length, 1);
  assert.deepEqual(item.calls.map((call) => call.method), ["deferUpdate", "followUp"]);
});
