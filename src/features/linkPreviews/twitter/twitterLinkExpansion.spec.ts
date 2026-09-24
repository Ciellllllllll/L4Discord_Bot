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

// 記事カード付きの投稿：記事画像・カードの文・「記事を開く」ボタンを出し、カードのタイトルと説明も翻訳する
{
  const cardFetch = async (): Promise<Response> => new Response(JSON.stringify({
    code: 200,
    tweet: {
      id: "1",
      url: tweet.url,
      text: "Read this https://example.com/news/1",
      author: { name: "Example", screen_name: "example" },
      card: {
        url: "https://example.com/news/1",
        title: "Breaking news",
        description: "Something happened",
        domain: "example.com",
        image: { url: "https://pbs.twimg.com/card_img/1/abc?format=jpg&name=800x419" },
      },
    },
  }), { status: 200 });
  let translatedKeys: string[] = [];
  const payloads = await buildTwitterReplyPayloads([target], {
    fetcher: cardFetch,
    translate: async (document) => {
      translatedKeys = document.blocks.flatMap((block) => block.type === "text"
        ? block.lines.flatMap((line) => line.parts.flatMap((part) => part.translationKey ? [part.translationKey] : []))
        : []);
      return {
        model: "test-model",
        translations: {
          "card-title": { shouldTranslate: true, sourceLanguage: "en", confidence: 1, translatedText: "速報" },
          "card-description": { shouldTranslate: true, sourceLanguage: "en", confidence: 1, translatedText: "何かが起きた" },
        },
      };
    },
  });
  assert.deepEqual(translatedKeys, ["main", "card-title", "card-description"]);
  const json = JSON.stringify(payloads[0]?.components);
  assert.equal(json.includes("速報"), true);
  assert.equal(json.includes("何かが起きた"), true);
  assert.equal(json.includes("https://pbs.twimg.com/card_img/1/abc?format=jpg&name=800x419"), true);
  assert.equal(json.includes(`"type":${ComponentType.MediaGallery}`), true);
  assert.equal(json.includes("記事を開く"), true);
  assert.equal(json.includes("\"url\":\"https://example.com/news/1\""), true);
  assert.equal(payloads[0]?.previewState?.document.secondaryAction?.url, "https://example.com/news/1");
}
