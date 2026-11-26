import assert from "node:assert/strict";
import { ComponentType } from "discord.js";
import type { PreviewTranslationState } from "../shared/previewState.repository.js";
import { handleVxTwitterPreviewButton } from "./vxtwitterPreviewInteractions.js";

const legacyTweet = {
  id: "1",
  url: "https://twitter.com/example/status/1",
  text: "Hello",
  author: { name: "Example", screenName: "example" },
  sensitive: false,
  media: [],
};
const legacyTranslations = {
  model: "test-model",
  main: { shouldTranslate: true, sourceLanguage: "en", confidence: 1, translatedText: "こんにちは" },
};
const legacyState: PreviewTranslationState = {
  version: 0,
  messageId: "message-1",
  guildId: "guild-1",
  channelId: "channel-1",
  sourceUrl: legacyTweet.url,
  document: { version: 0, source: "x", legacyTweet },
  translations: { version: 0, source: "x", legacyTranslations },
};

function interaction() {
  const calls: Array<{ method: string; payload?: unknown }> = [];
  return {
    calls,
    value: {
      customId: "vxpreview:show-original",
      guildId: "guild-1",
      channelId: "channel-1",
      message: {
        id: "message-1",
        author: { id: "bot-1" },
        components: [{
          type: ComponentType.ActionRow,
          components: [{ type: ComponentType.Button, label: "Xで開く", url: legacyTweet.url }],
        }],
      },
      async deferUpdate() { calls.push({ method: "deferUpdate" }); },
      async editReply(payload: unknown) { calls.push({ method: "editReply", payload }); },
      async followUp(payload: unknown) { calls.push({ method: "followUp", payload }); },
    },
  };
}

const ctx = {
  config: { GUILD_ID: "guild-1" },
  client: { user: { id: "bot-1" } },
  db: {},
  log: { warn() {} },
};

{
  const item = interaction();
  const saved: unknown[] = [];
  assert.equal(await handleVxTwitterPreviewButton(item.value as never, ctx as never, {
    getCommonState: async () => legacyState,
    getLegacyState: async () => null,
    saveCommonState: async (_db, state) => { saved.push(state); },
  }), true);
  assert.equal(saved.length, 1);
  const migrated = saved[0] as { version: number; document: { source: string }; translations: { translations: Record<string, unknown> } };
  assert.equal(migrated.version, 1);
  assert.equal(migrated.document.source, "x");
  assert.deepEqual(Object.keys(migrated.translations.translations), ["main"]);
  const edit = item.calls.find((call) => call.method === "editReply")?.payload;
  assert.equal(JSON.stringify(edit).includes("Hello"), true);
  assert.equal(JSON.stringify(edit).includes("preview:show-translation"), true);
}

{
  const item = interaction();
  let builds = 0;
  let saves = 0;
  assert.equal(await handleVxTwitterPreviewButton(item.value as never, ctx as never, {
    getCommonState: async () => null,
    getLegacyState: async () => null,
    buildReplyPayloads: async () => {
      builds += 1;
      return [{
        components: [],
        previewState: {
          document: {
            version: 1,
            source: "x",
            url: legacyTweet.url,
            openLabel: "Xで開く",
            blocks: [{ type: "text", id: "body", lines: [{ parts: [{ text: "Hello", translationKey: "main" }] }] }],
          },
          translations: { model: "test-model", translations: { main: legacyTranslations.main } },
        },
      }];
    },
    saveCommonState: async () => { saves += 1; },
  }), true);
  assert.equal(builds, 1);
  assert.equal(saves, 1);
  assert.equal(JSON.stringify(item.calls.find((call) => call.method === "editReply")?.payload).includes("preview:show-translation"), true);
}

console.log("vxtwitterPreviewInteractions.spec.ts: all assertions passed");
