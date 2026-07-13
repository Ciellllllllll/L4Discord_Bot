import assert from "node:assert/strict";
import test from "node:test";
import { fetchYouTubeChannelFeed, parseYouTubeChannelUrl, parseYouTubeChannelFeed } from "./youtubeRss.js";

test("parseYouTubeChannelUrl accepts canonical UC channel URLs", () => {
  assert.deepEqual(parseYouTubeChannelUrl("https://www.youtube.com/channel/UCabcDEF1234567890"), {
    channelId: "UCabcDEF1234567890",
    canonicalUrl: "https://www.youtube.com/channel/UCabcDEF1234567890",
  });
});

test("parseYouTubeChannelUrl rejects handles, video URLs, and non-YouTube URLs", () => {
  for (const value of [
    "https://www.youtube.com/@example",
    "https://www.youtube.com/watch?v=abc",
    "https://example.com/channel/UCabcDEF1234567890",
    "UCabcDEF1234567890",
  ]) {
    assert.equal(parseYouTubeChannelUrl(value), null);
  }
});

test("parseYouTubeChannelFeed normalizes Atom entries", () => {
  const entries = parseYouTubeChannelFeed(`<?xml version="1.0" encoding="UTF-8"?>
    <feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/">
      <title>Example channel</title>
      <entry>
        <yt:videoId>video-1</yt:videoId>
        <title>First upload</title>
        <published>2026-07-13T00:00:00+00:00</published>
        <link rel="alternate" href="https://www.youtube.com/watch?v=video-1" />
        <media:group><media:thumbnail url="https://i.ytimg.com/vi/video-1/hqdefault.jpg" /></media:group>
      </entry>
    </feed>`);

  assert.deepEqual(entries, [{
    videoId: "video-1",
    title: "First upload",
    channelTitle: "Example channel",
    publishedAt: "2026-07-13T00:00:00.000Z",
    videoUrl: "https://www.youtube.com/watch?v=video-1",
    thumbnailUrl: "https://i.ytimg.com/vi/video-1/hqdefault.jpg",
  }]);
});

test("fetchYouTubeChannelFeed reports HTTP failures", async () => {
  const result = await fetchYouTubeChannelFeed("UCabcDEF1234567890", {
    fetcher: async () => new Response("not found", { status: 404 }),
  });
  assert.deepEqual(result, { ok: false, error: "RSSの取得に失敗しました。(HTTP 404)" });
});
