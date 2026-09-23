import assert from "node:assert/strict";
import { EmbedType, type APIEmbed } from "discord.js";
import {
  fetchYouTubePreview,
  nativeYouTubeEmbedToDocument,
  normalizeYouTubeChannelResponse,
  normalizeYouTubeOEmbedResponse,
  normalizeYouTubePlaylistResponse,
  normalizeYouTubeVideoResponse,
  parseYouTubeUrl,
  youTubePreviewToDocument,
} from "./youtubePreviewSource.js";

function keyedParts(document: ReturnType<typeof youTubePreviewToDocument>): Array<[string, string]> {
  return document.blocks.flatMap((block) => block.type === "text"
    ? block.lines.flatMap((line) => line.parts.flatMap((part) => (
      part.translationKey ? [[part.text, part.translationKey] as [string, string]] : []
    )))
    : []);
}

assert.equal(parseYouTubeUrl("https://youtu.be/video-1?t=2")?.canonicalUrl, "https://www.youtube.com/watch?v=video-1");

const video = normalizeYouTubeVideoResponse({ items: [{
  snippet: {
    title: "Video title",
    description: "Video description",
    channelTitle: "Creator",
    publishedAt: "2026-08-17T00:00:00Z",
    thumbnails: { high: { url: "https://i.ytimg.com/video.jpg" } },
  },
  contentDetails: { duration: "PT2M3S" },
  statistics: { viewCount: "123" },
}] }, "https://www.youtube.com/watch?v=video-1");
assert.equal(video.status, "ok");
if (video.status === "ok") {
  assert.deepEqual(keyedParts(youTubePreviewToDocument(video.preview)), [
    ["Video title", "title"],
    ["Video description", "description"],
  ]);
}

const playlist = normalizeYouTubePlaylistResponse({ items: [{
  snippet: { title: "Playlist title", description: "Playlist description", channelTitle: "Owner" },
  contentDetails: { itemCount: 2 },
}] }, "https://www.youtube.com/playlist?list=PL1", { items: [
  { snippet: { title: "First sample" } },
  { snippet: { title: "Second sample" } },
] });
assert.equal(playlist.status, "ok");
if (playlist.status === "ok") {
  assert.deepEqual(keyedParts(youTubePreviewToDocument(playlist.preview)), [
    ["Playlist title", "title"],
    ["Playlist description", "description"],
    ["First sample", "sample:0"],
    ["Second sample", "sample:1"],
  ]);
}

const channel = normalizeYouTubeChannelResponse({ items: [{
  snippet: { title: "Proper Channel Name", description: "Channel description" },
  statistics: { subscriberCount: "10", videoCount: "3" },
}] }, "https://www.youtube.com/@proper");
assert.equal(channel.status, "ok");
if (channel.status === "ok") {
  assert.deepEqual(keyedParts(youTubePreviewToDocument(channel.preview)), [
    ["Channel description", "description"],
  ]);
  assert.equal(JSON.stringify(youTubePreviewToDocument(channel.preview)).includes("Proper Channel Name"), true);
}

const oembed = normalizeYouTubeOEmbedResponse({
  title: "OEmbed title",
  description: "OEmbed description",
  author_name: "Fixed author",
  thumbnail_url: "https://i.ytimg.com/oembed.jpg",
}, "https://www.youtube.com/watch?v=oembed");
assert.equal(oembed.status, "ok");
if (oembed.status === "ok") {
  assert.deepEqual(keyedParts(youTubePreviewToDocument(oembed.preview)), [
    ["OEmbed title", "title"],
    ["OEmbed description", "description"],
  ]);
}

const nativeDocument = nativeYouTubeEmbedToDocument({
  type: EmbedType.Video,
  title: "Native title",
  description: "Native description",
  url: "https://www.youtube.com/watch?v=native",
  provider: { name: "YouTube" },
  author: { name: "Native author", icon_url: "https://yt3.ggpht.com/native.jpg" },
  video: { url: "https://media.discordapp.net/native.mp4", content_type: "video/mp4" },
  thumbnail: { url: "https://i.ytimg.com/native.jpg" },
} satisfies APIEmbed);
assert.deepEqual(keyedParts(nativeDocument), [
  ["Native title", "title"],
  ["Native description", "description"],
]);
assert.equal(JSON.stringify(nativeDocument).includes("Native author"), true);
assert.equal(JSON.stringify(nativeDocument).includes("https://i.ytimg.com/native.jpg"), true);
assert.equal(JSON.stringify(nativeDocument).includes("media.discordapp.net"), false);

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

// YouTube の応答は上限付きで読み、巨大な応答やエラー応答の本文を丸ごと読み込まない
{
  const target = parseYouTubeUrl("https://youtu.be/huge-response");
  assert.ok(target);
  const huge = hugeBody();
  const result = await fetchYouTubePreview(target, { fetcher: async () => new Response(huge.stream, { status: 200 }) });
  assert.equal(result.status, "fallback");
  assert.ok(huge.pulled() < 64, "上限を超えた時点で読み込みを打ち切る");
}
{
  const target = parseYouTubeUrl("https://youtu.be/error-response");
  assert.ok(target);
  const errorBody = untouchedBody();
  const result = await fetchYouTubePreview(target, { fetcher: async () => new Response(errorBody.stream, { status: 503 }) });
  assert.deepEqual(result, { status: "fallback", reason: "http_503" });
  assert.equal(errorBody.read(), false);
}

console.log("youtubePreviewSource.spec.ts: all assertions passed");
