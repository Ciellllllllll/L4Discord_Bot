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

const articleCard = {
  url: "https://news.yahoo.co.jp/pickup/6596379",
  title: "中小事業者のレジ改修補助へ 政府 - Yahoo!ニュース",
  description: "政府が、2027年4月に予定する飲食料品の消費税率1％への引き下げに向け、中小企業と小規模事業者のレジシステムの改修費用として最大350万円を補助することが24日分かった。",
  domain: "news.yahoo.co.jp",
  image: { width: 800, height: 419, url: "https://pbs.twimg.com/card_img/2103033197772894208/OcOWvhzk?format=jpg&name=800x419" },
};

function cardTweet(overrides: Record<string, unknown> = {}) {
  return normalizeFixTweetResponse({
    code: 200,
    tweet: {
      id: "2103033192915812812",
      url: "https://x.com/YahooNewsTopics/status/2103033192915812812",
      text: "【中小事業者のレジ改修補助へ 政府】\nhttps://news.yahoo.co.jp/pickup/6596379",
      author: { name: "Yahoo!ニュース", screen_name: "YahooNewsTopics" },
      card: articleCard,
      ...overrides,
    },
  });
}

test("記事カードを正規化する（URL とタイトルが必須、https 以外は捨て、ドメインは URL から補う）", () => {
  const result = cardTweet();
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.deepEqual(result.tweet.card, {
    url: articleCard.url,
    title: articleCard.title,
    description: articleCard.description,
    domain: "news.yahoo.co.jp",
    imageUrl: articleCard.image.url,
  });

  const noDomain = cardTweet({ card: { url: "https://example.com/a", title: "T", image: { url: "http://insecure/img.jpg" } } });
  assert.deepEqual(noDomain.status === "ok" ? noDomain.tweet.card : null, { url: "https://example.com/a", title: "T", domain: "example.com" });

  for (const card of [{ title: "no url" }, { url: "https://example.com/a" }, { url: "javascript:alert(1)", title: "x" }, "not a card"]) {
    const result = cardTweet({ card });
    assert.equal(result.status === "ok" ? result.tweet.card : "fallback", undefined);
  }
  const withoutCard = cardTweet({ card: undefined });
  assert.equal(withoutCard.status === "ok" ? withoutCard.tweet.card : "fallback", undefined);
});

test("投稿に画像が無ければ記事画像を大きく表示し、記事カードの文と「記事を開く」ボタンを付ける", () => {
  const result = cardTweet();
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  const document = tweetPreviewToDocument(result.tweet);
  assert.deepEqual(document.secondaryAction, { label: "記事を開く", url: articleCard.url });
  assert.deepEqual(document.blocks.map((block) => block.id), ["body", "card-media", "card"]);
  const media = document.blocks.find((block) => block.id === "card-media");
  assert.deepEqual(media?.type === "media" ? media.items.map((item) => item.url) : null, [articleCard.image.url]);
  const card = document.blocks.find((block) => block.id === "card");
  assert.ok(card?.type === "text");
  if (card?.type !== "text") return;
  assert.equal(card.thumbnailUrl, undefined, "大きい画像を出すときはサムネイルを付けない");
  assert.deepEqual(card.lines.map((line) => line.prefix), ["> 🔗 ", "> ", "-# "]);
  assert.deepEqual(card.lines.flatMap((line) => line.parts.map((part) => part.translationKey)), ["card-title", "card-description", undefined]);
  assert.equal(card.lines[0]?.parts[0]?.strong, true);
  assert.equal(card.lines[2]?.parts[0]?.text, "news.yahoo.co.jp");
  // 本文末尾のカードの URL は X でも表示されないので本文から除く
  const body = document.blocks.find((block) => block.id === "body");
  const bodyText = body?.type === "text" ? body.lines.flatMap((line) => line.parts.map((part) => part.text)).join("\n") : "";
  assert.equal(bodyText.includes("https://news.yahoo.co.jp/pickup/6596379"), false);
  assert.equal(bodyText.includes("【中小事業者のレジ改修補助へ 政府】"), true);
});

test("投稿に画像があるときは記事画像を小さなサムネイルにする", () => {
  const result = cardTweet({ media: { all: [{ type: "photo", url: "https://pbs.twimg.com/media/own.jpg" }] }, possibly_sensitive: true });
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  const document = tweetPreviewToDocument(result.tweet);
  assert.deepEqual(document.blocks.map((block) => block.id), ["body", "main-media", "card"]);
  const card = document.blocks.find((block) => block.id === "card");
  assert.equal(card?.type === "text" ? card.thumbnailUrl : null, articleCard.image.url);
  // センシティブな投稿では、投稿の画像と同じく記事のサムネイルもスポイラーにする
  assert.equal(card?.type === "text" ? card.thumbnailSpoiler : null, true);
});

test("センシティブな投稿の記事画像はスポイラーにし、長いタイトルと説明は短くする", () => {
  const result = cardTweet({
    possibly_sensitive: true,
    card: { ...articleCard, title: "T".repeat(500), description: "D".repeat(500) },
  });
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  const document = tweetPreviewToDocument(result.tweet);
  const media = document.blocks.find((block) => block.id === "card-media");
  assert.equal(media?.type === "media" ? media.items[0]?.spoiler : null, true);
  const card = document.blocks.find((block) => block.id === "card");
  const texts = card?.type === "text" ? card.lines.map((line) => line.parts[0]?.text ?? "") : [];
  assert.ok(texts[0]!.length <= 200 && texts[1]!.length <= 200);
});

test("本文がカードの URL だけなら本文行を出さない", () => {
  const result = cardTweet({ text: "https://news.yahoo.co.jp/pickup/6596379" });
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  const body = tweetPreviewToDocument(result.tweet).blocks.find((block) => block.id === "body");
  assert.equal(body?.type === "text" ? body.lines.length : null, 1, "投稿者名の行だけ");
});
