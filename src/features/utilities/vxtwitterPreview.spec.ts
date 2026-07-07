import assert from "node:assert/strict";
import {
  ButtonStyle,
  ComponentType,
  MessageFlags,
  type APIActionRowComponent,
  type APIButtonComponent,
  type APIContainerComponent,
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
      created_timestamp: 1710000000,
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

  const payload = buildVxTwitterPreviewPayload(preview.tweet, "https://vxtwitter.com/main/status/123");
  assert.deepEqual(payload.embeds, []);
  assert.equal(payload.flags, MessageFlags.IsComponentsV2);
  assert.equal("content" in payload, false);
  const container = payload.components[0];
  assert.equal(container?.type, ComponentType.Container);
  const text = container?.components
    .filter((component) => component.type === ComponentType.TextDisplay)
    .map((component) => component.content)
    .join("\n");
  assert.match(text ?? "", /Main User/);
  assert.match(text ?? "", /引用: @quote/);
  const gallery = container?.components.find((component) => component.type === ComponentType.MediaGallery);
  assert.equal(gallery?.items.length, 3);
  assert.equal(gallery?.items.every((item) => item.spoiler === true), true);
  assert.equal(gallery?.items[0]?.description, "photo alt");
  const row = container?.components.find((component) => component.type === ComponentType.ActionRow) as
    | APIActionRowComponent<APIButtonComponent>
    | undefined;
  assert.equal(row?.components.length, 2);
  assert.equal(row?.components[0]?.style, ButtonStyle.Link);

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
}

run()
  .then(() => {
    console.log("vxtwitterPreview.spec.ts: all assertions passed");
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
