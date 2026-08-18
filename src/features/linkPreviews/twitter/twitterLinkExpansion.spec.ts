import assert from "node:assert/strict";
import { ComponentType, MessageFlags } from "discord.js";
import type { PreviewDocumentTranslations } from "../shared/previewTranslationGate.js";
import {
  buildTwitterReplyPayloads,
  expandTwitterLinks,
} from "./twitterLinkExpansion.js";
import type { TweetPreview, TwitterReplyTarget } from "./twitterPreviewSource.js";

const tweet: TweetPreview = {
  id: "1",
  url: "https://twitter.com/example/status/1",
  text: "Hello",
  author: { name: "Example", screenName: "example" },
  sensitive: false,
  media: [],
};
const target: TwitterReplyTarget = {
  vxUrl: "https://vxtwitter.com/example/status/1",
  screenName: "example",
  statusId: "1",
};
const useful: PreviewDocumentTranslations = {
  model: "test-model",
  translations: {
    main: { shouldTranslate: true, sourceLanguage: "en", confidence: 1, translatedText: "こんにちは" },
  },
};

const okFetch = async (): Promise<Response> => new Response(JSON.stringify({
  code: 200,
  tweet: { id: "1", url: tweet.url, text: tweet.text, author: { name: "Example", screen_name: "example" } },
}), { status: 200 });

{
  let translations = 0;
  const payloads = await buildTwitterReplyPayloads([target], {
    fetcher: okFetch,
    translate: async () => { translations += 1; return useful; },
  });
  assert.equal(translations, 1);
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0]?.flags, MessageFlags.IsComponentsV2);
  assert.equal(JSON.stringify(payloads[0]?.components).includes("こんにちは"), true);
  assert.equal(JSON.stringify(payloads[0]?.components).includes("preview:show-original"), true);
  assert.deepEqual(payloads[0]?.previewState, {
    document: payloads[0]?.previewState?.document,
    translations: useful,
  });
}

{
  const payloads = await buildTwitterReplyPayloads([target], {
    fetcher: okFetch,
    translate: async () => ({ translations: {} }),
  });
  assert.equal(JSON.stringify(payloads[0]?.components).includes("Hello"), true);
  assert.equal(JSON.stringify(payloads[0]?.components).includes("によって翻訳されました"), false);
  assert.equal(JSON.stringify(payloads[0]?.components).includes("preview:show-original"), false);
  assert.equal(payloads[0]?.previewState, undefined);
}

{
  const events: string[] = [];
  let replies = 0;
  await expandTwitterLinks({
    guildId: "guild-1",
    channelId: "channel-1",
    async reply(payload: unknown) {
      replies += 1;
      events.push(`reply:${JSON.stringify(payload).includes("first") ? "first" : "second"}`);
      return { id: `reply-${replies}` };
    },
  } as never, [target, { ...target, vxUrl: "https://vxtwitter.com/example/status/2", statusId: "2" }], {
    db: {} as never,
    log: { warn() {} },
    buildReplyPayloads: async () => [
      { embeds: [], flags: MessageFlags.IsComponentsV2, components: [{ type: ComponentType.TextDisplay, content: "first" }], allowedMentions: { parse: [], repliedUser: false }, previewState: { document: { version: 1, source: "x", url: tweet.url, openLabel: "Xで開く", blocks: [{ type: "text", id: "body", lines: [{ parts: [{ text: "Hello", translationKey: "main" }] }] }] }, translations: useful } },
      { embeds: [], flags: MessageFlags.IsComponentsV2, components: [{ type: ComponentType.TextDisplay, content: "second" }], allowedMentions: { parse: [], repliedUser: false } },
    ],
    saveState: async (_db, state) => { events.push(`save:${state.messageId}`); },
  });
  assert.deepEqual(events, ["reply:first", "save:reply-1", "reply:second"]);
}

{
  let replies = 0;
  const warnings: unknown[] = [];
  await expandTwitterLinks({
    guildId: "guild-1",
    channelId: "channel-1",
    async reply() { replies += 1; return { id: "reply-1" }; },
  } as never, [target], {
    db: {} as never,
    log: { warn(value) { warnings.push(value); } },
    buildReplyPayloads: async () => [{
      embeds: [], flags: MessageFlags.IsComponentsV2, components: [], allowedMentions: { parse: [], repliedUser: false },
      previewState: { document: { version: 1, source: "x", url: tweet.url, openLabel: "Xで開く", blocks: [{ type: "text", id: "body", lines: [{ parts: [{ text: "Hello", translationKey: "main" }] }] }] }, translations: useful },
    }],
    saveState: async () => { throw new Error("save failed"); },
  });
  assert.equal(replies, 1);
  assert.equal(warnings.length, 1);
}

console.log("twitterLinkExpansion.spec.ts: all assertions passed");
