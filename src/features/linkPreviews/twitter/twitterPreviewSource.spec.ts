import assert from "node:assert/strict";
import { test } from "node:test";
import {
  collectTwitterReplyTargets,
  fetchFixTweetPreview,
  normalizeFixTweetResponse,
  parseXStatusUrl,
  tweetPreviewToDocument,
} from "./twitterPreviewSource.js";

test("X URLを正規化し、同じ転送先を重複させない", () => {
  assert.deepEqual(parseXStatusUrl("https://twitter.com/user/status/123?s=20"), {
    id: "123",
    screenName: "user",
    originalUrl: "https://twitter.com/user/status/123?s=20",
    vxUrl: "https://vxtwitter.com/user/status/123?s=20",
  });
  assert.deepEqual(collectTwitterReplyTargets([
    "x.com/user/status/123",
    "https://x.com/user/status/123",
    "https://fxtwitter.com/other/status/456",
    "https://x.com/profile",
  ]).map((target) => target.vxUrl), [
    "https://vxtwitter.com/user/status/123",
    "https://vxtwitter.com/other/status/456",
    "https://vxtwitter.com/profile",
  ]);
  assert.equal(parseXStatusUrl("https://example.com/user/status/123"), null);
});

test("FxTwitter応答を本文・引用・媒体を含むTweetPreviewへ正規化する", () => {
  const result = normalizeFixTweetResponse({
    code: 200,
    tweet: {
      id: "123",
      url: "https://twitter.com/main/status/123",
      text: "Hello world",
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
      media: { all: [{ type: "photo", url: "https://pbs.twimg.com/media/main.jpg", altText: "main alt" }] },
      quote: {
        id: "999",
        url: "https://twitter.com/quote/status/999",
        text: "Quoted hello",
        author: { name: "Quote User", screen_name: "quote" },
        media: { all: [{ type: "video", url: "https://video.twimg.com/quote.mp4" }] },
      },
    },
  });
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.tweet.author.screenName, "main");
  assert.equal(result.tweet.media[0]?.description, "main alt");
  assert.equal(result.tweet.media[0]?.sensitive, true);
  assert.equal(result.tweet.quote?.author.screenName, "quote");
  assert.equal(result.tweet.quote?.media[0]?.kind, "video");
});

test("TweetPreview文書は本文と引用だけを翻訳対象にし、固定情報と媒体を維持する", () => {
  const normalized = normalizeFixTweetResponse({
    code: 200,
    tweet: {
      id: "123",
      url: "https://twitter.com/main/status/123",
      text: "Hello world",
      created_timestamp: Date.parse("2026-07-07T08:00:01.000Z") / 1000,
      likes: 10,
      retweets: 2,
      replies: 1,
      views: 300,
      author: { name: "Main User", screen_name: "main", avatar_url: "https://pbs.twimg.com/main.jpg" },
      media: { all: [{ type: "photo", url: "https://pbs.twimg.com/media/main.jpg" }] },
      quote: {
        url: "https://twitter.com/quote/status/999",
        text: "Quoted hello",
        author: { screen_name: "quote" },
        media: { all: [{ type: "photo", url: "https://pbs.twimg.com/media/quote.jpg" }] },
      },
    },
  });
  assert.equal(normalized.status, "ok");
  if (normalized.status !== "ok") return;
  const document = tweetPreviewToDocument(normalized.tweet);
  assert.equal(document.source, "x");
  assert.equal(document.url, "https://twitter.com/main/status/123");
  assert.equal(document.openLabel, "Xで開く");
  const keyed = document.blocks.flatMap((block) => block.type === "text"
    ? block.lines.flatMap((line) => line.parts.filter((part) => part.translationKey))
    : []);
  assert.deepEqual(keyed.map((part) => [part.text, part.translationKey]), [
    ["Hello world", "main"],
    ["Quoted hello", "quote"],
  ]);
  assert.equal(JSON.stringify(document).includes("Main User"), true);
  assert.equal(JSON.stringify(document).includes("💬 1 / 🔁 2 / ❤️ 10 / 👁️ 300"), true);
  assert.equal(JSON.stringify(document).includes("https://twitter.com/quote/status/999"), true);
  assert.equal(JSON.stringify(document).includes("https://pbs.twimg.com/media/main.jpg"), true);
  assert.equal(JSON.stringify(document).includes("https://pbs.twimg.com/media/quote.jpg"), true);
});

// 64KB ずつ最大 4MB を返す応答。読まれた回数を数えて、上限で打ち切られたかを確かめる
function hugeBody(): { stream: ReadableStream<Uint8Array>; pulled: () => number } {
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += 1;
      if (pulled > 64) controller.close();
      else controller.enqueue(new Uint8Array(64 * 1024));
    },
  });
  return { stream, pulled: () => pulled };
}

// highWaterMark: 0 で先読みを止め、実際に読まれたときだけ pull が呼ばれるようにする
function untouchedBody(): { stream: ReadableStream<Uint8Array>; read: () => boolean } {
  let read = false;
  const stream = new ReadableStream<Uint8Array>({ pull() { read = true; } }, { highWaterMark: 0 });
  return { stream, read: () => read };
}

test("FxTwitter取得は巨大な応答やエラー応答の本文を丸ごと読み込まない", async () => {
  const huge = hugeBody();
  assert.equal((await fetchFixTweetPreview(
    { id: "1", screenName: "u" },
    async () => new Response(huge.stream, { status: 200 }),
  )).status, "fallback");
  assert.ok(huge.pulled() < 64, "上限を超えた時点で読み込みを打ち切る");

  const errorBody = untouchedBody();
  assert.deepEqual(await fetchFixTweetPreview(
    { id: "1", screenName: "u" },
    async () => new Response(errorBody.stream, { status: 503 }),
  ), { status: "fallback", reason: "http_503" });
  assert.equal(errorBody.read(), false);
});

test("FxTwitter取得はHTTP失敗と不正JSONをfallbackへ変換する", async () => {
  assert.equal((await fetchFixTweetPreview(
    { id: "1", screenName: "u" },
    async () => new Response("no", { status: 503 }),
  )).status, "fallback");
  assert.equal((await fetchFixTweetPreview(
    { id: "1", screenName: "u" },
    async () => new Response("{", { status: 200 }),
  )).status, "fallback");
});
