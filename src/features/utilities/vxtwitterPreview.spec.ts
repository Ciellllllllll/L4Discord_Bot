import assert from "node:assert/strict";
import {
  ButtonStyle,
  ComponentType,
  MessageFlags,
  type APIActionRowComponent,
  type APIButtonComponent,
  type APIContainerComponent,
  type APISectionComponent,
} from "discord.js";
import {
  buildVxTwitterFallbackReply,
  buildVxTwitterPreviewPayload,
  buildVxTwitterReplyPayloads,
  collectVxTwitterReplyTargets,
  fetchFixTweetPreview,
  normalizeFixTweetResponse,
  parseXStatusUrl,
} from "./vxtwitterPreview.js";

function collectContainerText(container: APIContainerComponent | undefined): string {
  const contents: string[] = [];
  for (const component of container?.components ?? []) {
    if (component.type === ComponentType.TextDisplay) {
      contents.push(component.content);
    } else if (component.type === ComponentType.Section) {
      contents.push(...(component as APISectionComponent).components.map((item) => item.content));
    }
  }
  return contents.join("\n");
}

async function run(): Promise<void> {
  assert.deepEqual(parseXStatusUrl("x.com/user/status/1234567890"), {
    id: "1234567890",
    screenName: "user",
    originalUrl: "https://x.com/user/status/1234567890",
    vxUrl: "https://vxtwitter.com/user/status/1234567890",
  });
  assert.deepEqual(parseXStatusUrl("https://twitter.com/user/status/123?s=20"), {
    id: "123",
    screenName: "user",
    originalUrl: "https://twitter.com/user/status/123?s=20",
    vxUrl: "https://vxtwitter.com/user/status/123?s=20",
  });
  assert.deepEqual(parseXStatusUrl("https://mobile.twitter.com/user/status/456/photo/1"), {
    id: "456",
    screenName: "user",
    originalUrl: "https://mobile.twitter.com/user/status/456/photo/1",
    vxUrl: "https://vxtwitter.com/user/status/456/photo/1",
  });
  assert.deepEqual(parseXStatusUrl("https://x.com/user/status/1234567890)"), {
    id: "1234567890",
    screenName: "user",
    originalUrl: "https://x.com/user/status/1234567890",
    vxUrl: "https://vxtwitter.com/user/status/1234567890",
  });
  assert.equal(parseXStatusUrl("https://example.com/user/status/123"), null);

  const targets = collectVxTwitterReplyTargets([
    "https://x.com/ok/status/7",
    "https://x.com/ok/status/7",
    "https://x.com/profile",
    "https://twitter.com/other",
  ]);
  assert.equal(targets.length, 3);
  assert.equal(targets[0]?.statusId, "7");
  assert.equal(targets[0]?.vxUrl, "https://vxtwitter.com/ok/status/7");
  assert.equal(targets[1]?.statusId, undefined);
  assert.equal(targets[1]?.vxUrl, "https://vxtwitter.com/profile");
  assert.equal(targets[2]?.vxUrl, "https://vxtwitter.com/other");

  const preview = normalizeFixTweetResponse({
    code: 200,
    message: "OK",
    tweet: {
      id: "123",
      url: "https://twitter.com/main/status/123",
      text: "本文\nhttps://t.co/short",
      created_timestamp: Date.parse("2026-07-07T08:00:01.000Z") / 1000,
      likes: 10,
      retweets: 2,
      replies: 1,
      views: 300,
      possibly_sensitive: true,
      author: {
        name: "Main User",
        screen_name: "main",
        avatar_url: "https://pbs.twimg.com/profile_images/main.jpg",
      },
      media: {
        all: [
          {
            type: "photo",
            url: "https://pbs.twimg.com/media/photo1.jpg",
            width: 1200,
            height: 800,
            altText: "photo alt",
          },
          {
            type: "video",
            url: "https://video.twimg.com/ext_tw_video/movie.mp4",
            thumbnail_url: "https://pbs.twimg.com/ext_tw_video_thumb/movie.jpg",
            width: 720,
            height: 1280,
            format: "video/mp4",
          },
          {
            type: "gif",
            url: "https://video.twimg.com/tweet_video/anim.mp4",
            thumbnail_url: "https://pbs.twimg.com/tweet_video_thumb/anim.jpg",
            width: 400,
            height: 300,
          },
        ],
      },
      quote: {
        id: "999",
        url: "https://twitter.com/quote/status/999",
        text: "引用本文がここに入ります",
        author: { name: "Quote User", screen_name: "quote" },
      },
    },
  });

  assert.equal(preview?.status, "ok");
  assert.equal(preview.tweet.id, "123");
  assert.equal(preview.tweet.author.screenName, "main");
  assert.equal(preview.tweet.media.length, 3);
  assert.equal(preview.tweet.media[0]?.kind, "photo");
  assert.equal(preview.tweet.media[1]?.kind, "video");
  assert.equal(preview.tweet.quote?.author.screenName, "quote");
  assert.equal(preview.tweet.sensitive, true);

  const extraMedia = normalizeFixTweetResponse({
    code: 200,
    message: "OK",
    tweet: {
      id: "321",
      text: "external and mosaic",
      author: { screen_name: "media" },
      media: {
        external: {
          type: "video",
          url: "https://video.example.com/player.mp4",
          width: 1280,
          height: 720,
        },
        mosaic: {
          type: "mosaic_photo",
          formats: {
            webp: "https://pbs.twimg.com/media/mosaic.webp",
          },
        },
      },
    },
  });
  assert.equal(extraMedia.status, "ok");
  assert.equal(extraMedia.tweet.media.length, 2);
  assert.equal(extraMedia.tweet.media[0]?.kind, "video");
  assert.equal(extraMedia.tweet.media[1]?.kind, "photo");

  const payload = buildVxTwitterPreviewPayload(preview.tweet, "https://vxtwitter.com/main/status/123", {
    model: "gpt-5.4-mini",
    main: {
      shouldTranslate: true,
      sourceLanguage: "en",
      confidence: 0.98,
      translatedText: "本文の日本語訳です。",
    },
    quote: {
      shouldTranslate: true,
      sourceLanguage: "en",
      confidence: 0.97,
      translatedText: "引用文の日本語訳です。",
    },
  });
  assert.deepEqual(payload.embeds, []);
  assert.equal(payload.flags, MessageFlags.IsComponentsV2);
  assert.equal("content" in payload, false);
  const container = payload.components[0];
  assert.equal(container?.type, ComponentType.Container);
  const text = collectContainerText(container);
  assert.match(text ?? "", /\*\*Main User \(@main\)\*\*/);
  assert.doesNotMatch(text ?? "", /## Main User \(@main\)/);
  assert.doesNotMatch(text ?? "", /本文\nhttps:\/\/t\.co\/short/);
  assert.doesNotMatch(text ?? "", /### 本文/);
  assert.match(text ?? "", /本文の日本語訳です。/);
  assert.match(text ?? "", /-# この投稿は gpt-5\.4-mini によって翻訳されました。Made by Ciel/);
  assert.doesNotMatch(text ?? "", /引用本文がここに入ります/);
  assert.match(text ?? "", /> 引用: @quote 引用文の日本語訳です。/);
  assert.match(text ?? "", /2026\/07\/07 \/ 💬 1 \/ 🔁 2 \/ ❤️ 10 \/ 👁️ 300/);
  assert.equal(text?.includes("https://vxtwitter.com/main/status/123"), false);
  const section = container?.components.find((component) => component.type === ComponentType.Section);
  assert.equal(section?.accessory.type, ComponentType.Thumbnail);
  assert.equal(section?.accessory.media.url, "https://pbs.twimg.com/profile_images/main.jpg");
  const gallery = container?.components.find((component) => component.type === ComponentType.MediaGallery);
  assert.equal(gallery?.items.length, 3);
  assert.equal(gallery?.items.every((item) => item.spoiler === true), true);
  assert.equal(gallery?.items[0]?.description, "photo alt");
  assert.equal(gallery?.items[1]?.media.url, "https://video.twimg.com/ext_tw_video/movie.mp4");
  assert.equal(gallery?.items[2]?.media.url, "https://video.twimg.com/tweet_video/anim.mp4");
  const row = container?.components.find((component) => component.type === ComponentType.ActionRow) as
    | APIActionRowComponent<APIButtonComponent>
    | undefined;
  const galleryIndex = container?.components.findIndex((component) => component.type === ComponentType.MediaGallery) ?? -1;
  const attributionIndex = container?.components.findIndex(
    (component) => component.type === ComponentType.TextDisplay && component.content.includes("Made by Ciel"),
  ) ?? -1;
  const metaIndex = container?.components.findIndex(
    (component) => component.type === ComponentType.TextDisplay && component.content.includes("2026/07/07"),
  ) ?? -1;
  const rowIndex = container?.components.findIndex((component) => component.type === ComponentType.ActionRow) ?? -1;
  assert.ok(attributionIndex > 0 && galleryIndex > attributionIndex && metaIndex > galleryIndex && rowIndex > metaIndex);
  assert.equal(row?.components.length, 2);
  assert.equal((row?.components[0] as { label?: string } | undefined)?.label, "Xで開く");
  assert.equal((row?.components[1] as { label?: string } | undefined)?.label, "原文を表示");
  assert.equal((row?.components[1] as { custom_id?: string } | undefined)?.custom_id, "vxpreview:show-original");

  const originalPayload = buildVxTwitterPreviewPayload(preview.tweet, "https://vxtwitter.com/main/status/123", {
    main: {
      shouldTranslate: true,
      sourceLanguage: "en",
      confidence: 0.98,
      translatedText: "本文の日本語訳です。",
    },
    quote: {
      shouldTranslate: true,
      sourceLanguage: "en",
      confidence: 0.97,
      translatedText: "引用文の日本語訳です。",
    },
  }, "original");
  const originalContainer = originalPayload.components[0] as APIContainerComponent | undefined;
  const originalText = collectContainerText(originalContainer);
  assert.match(originalText ?? "", /本文\nhttps:\/\/t\.co\/short/);
  assert.match(originalText ?? "", /> 引用: @quote 引用本文がここに入ります/);
  const originalRow = originalContainer?.components.find((component) => component.type === ComponentType.ActionRow) as
    | APIActionRowComponent<APIButtonComponent>
    | undefined;
  assert.equal((originalRow?.components[1] as { label?: string } | undefined)?.label, "翻訳を表示");
  assert.equal((originalRow?.components[1] as { custom_id?: string } | undefined)?.custom_id, "vxpreview:show-translation");
  assert.equal(row?.components[0]?.style, ButtonStyle.Link);
  assert.equal(row?.components[0]?.label, "Xで開く");

  assert.equal(normalizeFixTweetResponse({ code: 401, message: "PRIVATE_TWEET" })?.status, "fallback");
  assert.equal(normalizeFixTweetResponse({ code: 404, message: "NOT_FOUND" })?.status, "fallback");
  assert.equal(normalizeFixTweetResponse({ code: 500, message: "API_FAIL" })?.status, "fallback");
  assert.equal(normalizeFixTweetResponse({ code: 200, message: "OK" })?.status, "fallback");

  const okFetch = async (): Promise<Response> =>
    new Response(JSON.stringify({ code: 200, message: "OK", tweet: { id: "7", text: "ok", author: { screen_name: "u" } } }), {
      status: 200,
    });
  assert.equal((await fetchFixTweetPreview({ id: "7", screenName: "u" }, okFetch)).status, "ok");

  const badJsonFetch = async (): Promise<Response> => new Response("{", { status: 200 });
  assert.equal((await fetchFixTweetPreview({ id: "8", screenName: "u" }, badJsonFetch)).status, "fallback");
  const httpFailFetch = async (): Promise<Response> => new Response("no", { status: 503 });
  assert.equal((await fetchFixTweetPreview({ id: "9", screenName: "u" }, httpFailFetch)).status, "fallback");
  const rejectFetch = async (): Promise<Response> => {
    throw new Error("network");
  };
  assert.equal((await fetchFixTweetPreview({ id: "10", screenName: "u" }, rejectFetch)).status, "fallback");

  const fallback = buildVxTwitterFallbackReply(["https://vxtwitter.com/a/status/1", "https://vxtwitter.com/b/status/2"]);
  assert.equal(fallback.content, "https://vxtwitter.com/a/status/1\nhttps://vxtwitter.com/b/status/2");
  assert.deepEqual(fallback.allowedMentions, { parse: [], repliedUser: false });

  const replyPayloads = await buildVxTwitterReplyPayloads(
    ["https://x.com/ok/status/7", "https://x.com/private/status/8"],
    async (url): Promise<Response> => {
      if (url.includes("/ok/status/7")) {
        return new Response(JSON.stringify({
          code: 200,
          message: "OK",
          tweet: {
            id: "7",
            url: "https://twitter.com/ok/status/7",
            text: "v2 card",
            author: { screen_name: "ok" },
          },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ code: 401, message: "PRIVATE_TWEET" }), { status: 200 });
    },
  );
  assert.equal(replyPayloads.length, 2);
  assert.equal(replyPayloads[0]?.flags, MessageFlags.IsComponentsV2);
  assert.equal("content" in replyPayloads[0]!, false);
  assert.equal(replyPayloads[1]?.content, "https://vxtwitter.com/private/status/8");

  const nonStatusPayloads = await buildVxTwitterReplyPayloads(["https://x.com/profile"]);
  assert.equal(nonStatusPayloads.length, 1);
  assert.equal(nonStatusPayloads[0]?.content, "https://vxtwitter.com/profile");

  const malformedPayloads = await buildVxTwitterReplyPayloads(
    ["https://x.com/bad/status/11"],
    async (): Promise<Response> =>
      new Response(JSON.stringify({
        code: 200,
        message: "OK",
        tweet: {
          id: "11",
          url: "javascript:alert(1)",
          text: "bad urls",
          author: { screen_name: "bad" },
          media: {
            photos: [{ type: "photo", url: "not a url" }],
          },
        },
      }), { status: 200 }),
  );
  assert.equal(malformedPayloads.length, 1);
  assert.equal(malformedPayloads[0]?.flags, MessageFlags.IsComponentsV2);
  const malformedContainer = malformedPayloads[0]?.components?.[0] as APIContainerComponent | undefined;
  assert.equal(malformedContainer?.type, ComponentType.Container);
  assert.equal(
    malformedContainer?.components.some((component) => component.type === ComponentType.MediaGallery),
    false,
  );

  let translationCalls = 0;
  const translatedPayloads = await buildVxTwitterReplyPayloads(
    ["https://x.com/translate/status/12"],
    async (): Promise<Response> =>
      new Response(JSON.stringify({
        code: 200,
        message: "OK",
        tweet: {
          id: "12",
          url: "https://twitter.com/translate/status/12",
          text: "Hello from abroad",
          author: { screen_name: "translate" },
          quote: {
            id: "1200",
            text: "Quoted hello",
            author: { screen_name: "quoted" },
          },
        },
      }), { status: 200 }),
    {
      config: { DEEPSEEK_API_KEY: "test-key" },
      log: { warn() {} },
      translate: async (_tweet) => {
        translationCalls += 1;
        return {
          main: {
            shouldTranslate: true,
            sourceLanguage: "en",
            confidence: 0.99,
            translatedText: "海外からのこんにちは",
          },
          quote: {
            shouldTranslate: true,
            sourceLanguage: "en",
            confidence: 0.99,
            translatedText: "引用のこんにちは",
          },
        };
      },
    },
  );
  assert.equal(translationCalls, 1);
  const translatedContainer = translatedPayloads[0]?.components?.[0] as APIContainerComponent | undefined;
  const translatedText = collectContainerText(translatedContainer);
  assert.doesNotMatch(translatedText ?? "", /Hello from abroad/);
  assert.match(translatedText ?? "", /海外からのこんにちは/);
  assert.match(translatedText ?? "", /> 引用: @quoted 引用のこんにちは/);

  let fetchCalls = 0;
  const buildStatusResponse = (): Response =>
    new Response(JSON.stringify({
      code: 200,
      message: "OK",
      tweet: {
        id: "13",
        url: "https://twitter.com/configured/status/13",
        text: "Configured status text",
        author: { screen_name: "configured" },
        quote: {
          id: "1300",
          text: "Quoted configured text",
          author: { screen_name: "quoted_configured" },
        },
      },
    }), { status: 200 });

  const configuredPayloads = await buildVxTwitterReplyPayloads(
    ["https://x.com/configured/status/13"],
    {
      config: { DEEPSEEK_API_KEY: "" },
      log: { warn() {} },
      fetcher: async (): Promise<Response> => {
        fetchCalls += 1;
        return buildStatusResponse();
      },
    },
  );
  assert.equal(fetchCalls, 1);
  assert.equal(configuredPayloads[0]?.flags, MessageFlags.IsComponentsV2);
  const configuredContainer = configuredPayloads[0]?.components?.[0] as APIContainerComponent | undefined;
  const configuredText = collectContainerText(configuredContainer);
  assert.match(configuredText ?? "", /Configured status text/);

  const fallbackScenarios = [
    {
      name: "DeepSeek失敗でもカードを維持する",
      options: {
        config: { DEEPSEEK_API_KEY: "test-key" },
        log: { warn() {} },
        translate: async () => {
          throw new Error("deepseek failed");
        },
      },
    },
    {
      name: "不正JSONでもカードを維持する",
      options: {
        config: { DEEPSEEK_API_KEY: "test-key" },
        log: { warn() {} },
        translate: async () => {
          throw new SyntaxError("Unexpected token");
        },
      },
    },
  ] as const;

  for (const scenario of fallbackScenarios) {
    const payloads = await buildVxTwitterReplyPayloads(
      ["https://x.com/configured/status/13"],
      {
        ...scenario.options,
        fetcher: async (): Promise<Response> => buildStatusResponse(),
      },
    );
    assert.equal(payloads[0]?.flags, MessageFlags.IsComponentsV2, scenario.name);
    assert.equal("content" in payloads[0]!, false, scenario.name);
    const cardContainer = payloads[0]?.components?.[0] as APIContainerComponent | undefined;
    const cardText = collectContainerText(cardContainer);
    assert.match(cardText ?? "", /Configured status text/, scenario.name);
    assert.doesNotMatch(cardText ?? "", /日本語訳/, scenario.name);
    assert.equal(
      cardContainer?.components.some((component) => component.type === ComponentType.ActionRow),
      true,
      scenario.name,
    );
  }

  const configuredDeepSeekFailurePayloads = await buildVxTwitterReplyPayloads(
    ["https://x.com/configured/status/13"],
    {
      config: {
        DEEPSEEK_API_KEY: "test-key",
        DEEPSEEK_API_BASE: "http://127.0.0.1:1",
        AI_REQUEST_TIMEOUT_MS: 5_000,
        AI_MAX_RESPONSE_BYTES: 64_000,
        AI_MAX_RETRIES: 0,
        AI_TEMPERATURE: 0,
        DEEPSEEK_MODEL: "deepseek-chat",
        DEEPSEEK_THINKING_ENABLED: false,
        DEEPSEEK_THINKING_EFFORT: "high",
      },
      log: { warn() {} },
      fetcher: async (): Promise<Response> => buildStatusResponse(),
    },
  );
  assert.equal(configuredDeepSeekFailurePayloads[0]?.flags, MessageFlags.IsComponentsV2);
  assert.equal("content" in configuredDeepSeekFailurePayloads[0]!, false);
  const configuredDeepSeekFailureContainer = configuredDeepSeekFailurePayloads[0]?.components?.[0] as
    | APIContainerComponent
    | undefined;
  const configuredDeepSeekFailureText = collectContainerText(configuredDeepSeekFailureContainer);
  assert.match(configuredDeepSeekFailureText ?? "", /Configured status text/);
  assert.doesNotMatch(configuredDeepSeekFailureText ?? "", /日本語訳/);
  assert.equal(
    configuredDeepSeekFailureContainer?.components.some((component) => component.type === ComponentType.ActionRow),
    true,
  );
}

run()
  .then(() => {
    console.log("vxtwitterPreview.spec.ts: all assertions passed");
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
