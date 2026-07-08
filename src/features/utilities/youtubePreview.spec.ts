import assert from "node:assert/strict";
import { ButtonStyle, ComponentType, MessageFlags, type APIContainerComponent } from "discord.js";
import {
  buildYouTubeFallbackReply,
  buildYouTubePreviewPayload,
  buildYouTubeReplyPayloads,
  collectYouTubeReplyTargets,
  fetchYouTubePreview,
  normalizeYouTubeChannelResponse,
  normalizeYouTubeOEmbedResponse,
  normalizeYouTubePlaylistResponse,
  normalizeYouTubeVideoResponse,
  parseYouTubeUrl,
  type YouTubeReplyTarget,
} from "./youtubePreview.js";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function run(): Promise<void> {
  assert.deepEqual(parseYouTubeUrl("youtube.com/watch?v=abcDEF_123-."), {
    kind: "video",
    originalUrl: "https://youtube.com/watch?v=abcDEF_123-",
    canonicalUrl: "https://www.youtube.com/watch?v=abcDEF_123-",
    id: "abcDEF_123-",
  });
  assert.deepEqual(parseYouTubeUrl("https://youtu.be/vid123?t=12)"), {
    kind: "video",
    originalUrl: "https://youtu.be/vid123?t=12",
    canonicalUrl: "https://www.youtube.com/watch?v=vid123",
    id: "vid123",
  });
  assert.equal(parseYouTubeUrl("https://music.youtube.com/shorts/shortId")?.canonicalUrl, "https://www.youtube.com/watch?v=shortId");
  assert.equal(parseYouTubeUrl("https://m.youtube.com/live/liveId")?.canonicalUrl, "https://www.youtube.com/watch?v=liveId");
  assert.equal(parseYouTubeUrl("https://www.youtube.com/embed/embedId")?.canonicalUrl, "https://www.youtube.com/watch?v=embedId");
  assert.equal(parseYouTubeUrl("https://www.youtube.com/v/legacyId")?.canonicalUrl, "https://www.youtube.com/watch?v=legacyId");

  assert.deepEqual(parseYouTubeUrl("https://www.youtube.com/playlist?list=PL123、"), {
    kind: "playlist",
    originalUrl: "https://www.youtube.com/playlist?list=PL123",
    canonicalUrl: "https://www.youtube.com/playlist?list=PL123",
    id: "PL123",
  });
  assert.deepEqual(parseYouTubeUrl("https://youtube.com/channel/UCabc123"), {
    kind: "channel",
    originalUrl: "https://youtube.com/channel/UCabc123",
    canonicalUrl: "https://www.youtube.com/channel/UCabc123",
    id: "UCabc123",
  });
  assert.deepEqual(parseYouTubeUrl("https://youtube.com/@Handle_Name"), {
    kind: "channel",
    originalUrl: "https://youtube.com/@Handle_Name",
    canonicalUrl: "https://www.youtube.com/@Handle_Name",
    handle: "Handle_Name",
  });
  assert.deepEqual(parseYouTubeUrl("https://youtube.com/user/legacyUser"), {
    kind: "channel",
    originalUrl: "https://youtube.com/user/legacyUser",
    canonicalUrl: "https://www.youtube.com/user/legacyUser",
    username: "legacyUser",
  });
  assert.deepEqual(parseYouTubeUrl("https://www.youtube.com/c/CustomName?view=videos"), {
    kind: "fallback",
    originalUrl: "https://www.youtube.com/c/CustomName?view=videos",
    canonicalUrl: "https://www.youtube.com/c/CustomName?view=videos",
  });
  assert.equal(parseYouTubeUrl("https://example.com/watch?v=abc"), null);

  const collected = collectYouTubeReplyTargets([
    "https://youtu.be/a",
    "https://www.youtube.com/watch?v=a",
    "https://www.youtube.com/playlist?list=PL1",
    "https://www.youtube.com/@h",
    "https://www.youtube.com/user/u",
    "https://www.youtube.com/channel/UC1",
    "https://www.youtube.com/c/custom",
  ]);
  assert.equal(collected.length, 5);
  assert.deepEqual(collected.map((target) => target.canonicalUrl), [
    "https://www.youtube.com/watch?v=a",
    "https://www.youtube.com/playlist?list=PL1",
    "https://www.youtube.com/@h",
    "https://www.youtube.com/user/u",
    "https://www.youtube.com/channel/UC1",
  ]);

  const video = normalizeYouTubeVideoResponse({
    items: [{
      snippet: {
        title: "Video title",
        description: "Video description",
        channelTitle: "Channel",
        publishedAt: "2026-07-01T00:00:00Z",
        liveBroadcastContent: "none",
        thumbnails: { high: { url: "https://i.ytimg.com/vi/v/high.jpg" } },
      },
      contentDetails: { duration: "PT1M2S" },
      statistics: { viewCount: "12345" },
    }],
  }, "https://www.youtube.com/watch?v=v");
  assert.equal(video.status, "ok");
  assert.equal(video.preview.kind, "video");
  assert.equal(video.preview.title, "Video title");
  assert.equal(video.preview.viewCount, 12345);
  assert.equal(video.preview.thumbnailUrl, "https://i.ytimg.com/vi/v/high.jpg");
  assert.equal(normalizeYouTubeVideoResponse({ items: [] }, "https://www.youtube.com/watch?v=v").status, "fallback");

  const playlist = normalizeYouTubePlaylistResponse({
    items: [{
      snippet: {
        title: "Playlist title",
        description: "Playlist description",
        channelTitle: "Owner",
        thumbnails: { medium: { url: "https://i.ytimg.com/playlist.jpg" } },
      },
      contentDetails: { itemCount: 42 },
    }],
  }, "https://www.youtube.com/playlist?list=PL", {
    items: [
      { snippet: { title: "First" } },
      { snippet: { title: "Second" } },
      { snippet: { title: "Deleted video" } },
    ],
  });
  assert.equal(playlist.status, "ok");
  assert.equal(playlist.preview.kind, "playlist");
  assert.equal(playlist.preview.itemCount, 42);
  assert.deepEqual(playlist.preview.sampleItems, ["First", "Second"]);

  const channel = normalizeYouTubeChannelResponse({
    items: [{
      snippet: {
        title: "Channel title",
        description: "Channel description",
        thumbnails: { default: { url: "https://yt3.ggpht.com/icon.jpg" } },
      },
      statistics: { subscriberCount: "1000", videoCount: "25" },
    }],
  }, "https://www.youtube.com/@handle");
  assert.equal(channel.status, "ok");
  assert.equal(channel.preview.kind, "channel");
  assert.equal(channel.preview.subscriberCount, 1000);
  assert.equal(channel.preview.videoCount, 25);

  const oembed = normalizeYouTubeOEmbedResponse({
    title: "Embed title",
    author_name: "Embed author",
    thumbnail_url: "https://i.ytimg.com/vi/o/hqdefault.jpg",
  }, "https://www.youtube.com/watch?v=o");
  assert.equal(oembed.status, "ok");
  assert.equal(oembed.preview.kind, "oembed");
  assert.equal(oembed.preview.channelTitle, "Embed author");

  const fetchedUrls: string[] = [];
  const apiResult = await fetchYouTubePreview(
    { kind: "video", originalUrl: "https://youtu.be/v", canonicalUrl: "https://www.youtube.com/watch?v=v", id: "v" },
    {
      apiKey: "api-key",
      fetcher: async (url) => {
        fetchedUrls.push(url);
        return jsonResponse({
          items: [{
            snippet: { title: "API video", thumbnails: {} },
            contentDetails: { duration: "PT1S" },
            statistics: {},
          }],
        });
      },
    },
  );
  assert.equal(apiResult.status, "ok");
  assert.match(fetchedUrls[0] ?? "", /^https:\/\/www\.googleapis\.com\/youtube\/v3\/videos\?/);
  assert.doesNotMatch(fetchedUrls.join("\n"), /search/);

  let now = 1_000;
  let cacheFetchCalls = 0;
  const cacheTarget: YouTubeReplyTarget = {
    kind: "video",
    originalUrl: "https://youtu.be/cache",
    canonicalUrl: "https://www.youtube.com/watch?v=cache",
    id: "cache",
  };
  const cacheOptions = {
    apiKey: "cache-key",
    nowMs: () => now,
    fetcher: async (): Promise<Response> => {
      cacheFetchCalls += 1;
      return jsonResponse({
        items: [{
          snippet: { title: `Cached ${cacheFetchCalls}`, thumbnails: {} },
          contentDetails: {},
          statistics: {},
        }],
      });
    },
  };
  assert.equal((await fetchYouTubePreview(cacheTarget, cacheOptions)).status, "ok");
  assert.equal((await fetchYouTubePreview(cacheTarget, cacheOptions)).status, "ok");
  assert.equal(cacheFetchCalls, 1);
  now += 30 * 60 * 1000 + 1;
  assert.equal((await fetchYouTubePreview(cacheTarget, cacheOptions)).status, "ok");
  assert.equal(cacheFetchCalls, 2);

  const oembedUrls: string[] = [];
  const noKeyVideo = await fetchYouTubePreview(
    { kind: "video", originalUrl: "https://youtu.be/no-key", canonicalUrl: "https://www.youtube.com/watch?v=no-key", id: "no-key" },
    {
      fetcher: async (url): Promise<Response> => {
        oembedUrls.push(url);
        return jsonResponse({ title: "No key", author_name: "Author" });
      },
    },
  );
  assert.equal(noKeyVideo.status, "ok");
  assert.match(oembedUrls[0] ?? "", /^https:\/\/www\.youtube\.com\/oembed\?/);

  const noKeyPlaylist = await fetchYouTubePreview(
    { kind: "playlist", originalUrl: "https://www.youtube.com/playlist?list=PL", canonicalUrl: "https://www.youtube.com/playlist?list=PL", id: "PL" },
    { fetcher: async () => jsonResponse({}) },
  );
  assert.equal(noKeyPlaylist.status, "fallback");

  const playlistItemsInvalidJson = await fetchYouTubePreview(
    {
      kind: "playlist",
      originalUrl: "https://www.youtube.com/playlist?list=PL-invalid-items",
      canonicalUrl: "https://www.youtube.com/playlist?list=PL-invalid-items",
      id: "PL-invalid-items",
    },
    {
      apiKey: "key",
      fetcher: async (url) => {
        if (url.includes("/playlists?")) {
          return jsonResponse({
            items: [{
              snippet: { title: "Playlist with invalid items", thumbnails: {} },
              contentDetails: { itemCount: 1 },
            }],
          });
        }
        return new Response("{", { status: 200 });
      },
    },
  );
  assert.deepEqual(playlistItemsInvalidJson, { status: "fallback", reason: "invalid_json" });

  const playlistItemsEmpty = await fetchYouTubePreview(
    {
      kind: "playlist",
      originalUrl: "https://www.youtube.com/playlist?list=PL-empty-items",
      canonicalUrl: "https://www.youtube.com/playlist?list=PL-empty-items",
      id: "PL-empty-items",
    },
    {
      apiKey: "key",
      fetcher: async (url) => jsonResponse(url.includes("/playlists?")
        ? {
          items: [{
            snippet: { title: "Playlist with empty items", thumbnails: {} },
            contentDetails: { itemCount: 0 },
          }],
        }
        : { items: [] }),
    },
  );
  assert.deepEqual(playlistItemsEmpty, { status: "fallback", reason: "empty_items" });

  const invalidJson = await fetchYouTubePreview(
    { kind: "video", originalUrl: "https://youtu.be/bad", canonicalUrl: "https://www.youtube.com/watch?v=bad", id: "bad" },
    { apiKey: "key", fetcher: async () => new Response("{", { status: 200 }) },
  );
  assert.equal(invalidJson.status, "fallback");

  const payload = buildYouTubePreviewPayload({
    kind: "video",
    url: "https://www.youtube.com/watch?v=payload",
    title: "Payload video",
    description: "  Long   description\nwith\tspace  ",
    thumbnailUrl: "https://i.ytimg.com/vi/payload/maxresdefault.jpg",
    channelTitle: "Creator",
    publishedAt: "2026-07-01T00:00:00Z",
    duration: "PT1H2M3S",
    viewCount: 1234567,
    liveBroadcastContent: "live",
  });
  assert.deepEqual(payload.embeds, []);
  assert.equal(payload.flags, MessageFlags.IsComponentsV2);
  assert.deepEqual(payload.allowedMentions, { parse: [], repliedUser: false });
  assert.equal("content" in payload, false);
  assert.equal(payload.components.length, 1);
  const container = payload.components[0]!;
  assert.equal(container.type, ComponentType.Container);
  assert.equal(container.components[0]?.type, ComponentType.Section);
  const section = container.components[0]!;
  assert.equal(section.accessory.type, ComponentType.Thumbnail);
  assert.equal(section.accessory.media.url, "https://i.ytimg.com/vi/payload/maxresdefault.jpg");
  const body = section.components[0]!;
  assert.equal(body.type, ComponentType.TextDisplay);
  assert.match(body.content, /\*\*Payload video\*\*/);
  assert.match(body.content, /動画・ライブ/);
  assert.match(body.content, /投稿者: Creator/);
  assert.match(body.content, /Long description with space/);
  assert.match(body.content, /公開日: <t:1782864000:D>/);
  assert.match(body.content, /再生時間: 1:02:03/);
  assert.match(body.content, /再生数: 1,234,567/);
  assert.ok(body.content.length <= 4000);
  const gallery = container.components.find((component) => component.type === ComponentType.MediaGallery);
  assert.equal(gallery?.items[0]?.media.url, "https://i.ytimg.com/vi/payload/maxresdefault.jpg");
  const row = container.components.at(-1)!;
  assert.equal(row.type, ComponentType.ActionRow);
  assert.equal(row.components[0]?.type, ComponentType.Button);
  assert.equal(row.components[0]?.style, ButtonStyle.Link);
  assert.equal(row.components[0]?.label, "YouTubeで開く");
  assert.equal(row.components[0]?.url, "https://www.youtube.com/watch?v=payload");

  const playlistPayload = buildYouTubePreviewPayload({
    kind: "playlist",
    url: "https://www.youtube.com/playlist?list=PL",
    title: "Playlist",
    channelTitle: "Owner",
    itemCount: 42,
    sampleItems: ["First", "Second", "Third", "Fourth"],
    thumbnailUrl: "http://example.com/not-safe.jpg",
  });
  const playlistContainer = playlistPayload.components[0]! as APIContainerComponent;
  assert.equal(playlistContainer.components[0]?.type, ComponentType.TextDisplay);
  assert.equal(playlistContainer.components.some((component) => component.type === ComponentType.MediaGallery), false);
  const playlistBody = playlistContainer.components[0]!;
  assert.match(playlistBody.content, /プレイリスト/);
  assert.match(playlistBody.content, /所有者: Owner/);
  assert.match(playlistBody.content, /動画数: 42/);
  assert.match(playlistBody.content, /- First\n- Second\n- Third/);
  assert.doesNotMatch(playlistBody.content, /Fourth/);

  const fallbackReply = buildYouTubeFallbackReply(["https://youtu.be/a", "https://youtu.be/b"]);
  assert.deepEqual(fallbackReply, {
    content: "https://youtu.be/a\nhttps://youtu.be/b",
    allowedMentions: { parse: [], repliedUser: false },
  });

  const replyPayloads = await buildYouTubeReplyPayloads([
    {
      kind: "video",
      originalUrl: "https://youtu.be/reply-ok",
      canonicalUrl: "https://www.youtube.com/watch?v=reply-ok",
      id: "reply-ok",
    },
    {
      kind: "fallback",
      originalUrl: "https://www.youtube.com/c/custom",
      canonicalUrl: "https://www.youtube.com/c/custom",
    },
    {
      kind: "video",
      originalUrl: "https://youtu.be/reply-fail",
      canonicalUrl: "https://www.youtube.com/watch?v=reply-fail",
      id: "reply-fail",
    },
  ], {
    apiKey: "key",
    fetcher: async (url) => jsonResponse(url.includes("reply-fail")
      ? { items: [] }
      : {
        items: [{
          snippet: { title: "Reply ok", thumbnails: {} },
          contentDetails: {},
          statistics: {},
        }],
      }),
  });
  assert.equal(replyPayloads.length, 3);
  assert.equal(replyPayloads[0]?.flags, MessageFlags.IsComponentsV2);
  assert.deepEqual(replyPayloads[1], {
    content: "https://www.youtube.com/c/custom",
    allowedMentions: { parse: [], repliedUser: false },
  });
  assert.deepEqual(replyPayloads[2], {
    content: "https://www.youtube.com/watch?v=reply-fail",
    allowedMentions: { parse: [], repliedUser: false },
  });
}

run()
  .then(() => {
    console.log("youtubePreview.spec.ts: all assertions passed");
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
