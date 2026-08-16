import assert from "node:assert/strict";
import {
  AttachmentBuilder,
  ButtonStyle,
  ComponentType,
  EmbedType,
  MessageFlags,
  type APIContainerComponent,
  type APIEmbed,
  type APISectionComponent,
} from "discord.js";
import {
  buildYouTubeFallbackReply,
  buildYouTubeNativeEmbedPayload,
  buildYouTubePreviewPayload,
  buildYouTubeReplyPayloads,
  collectYouTubeReplyTargets,
  fetchYouTubePreview,
  getYouTubeNativeEmbedVideoUrl,
  normalizeYouTubeChannelResponse,
  normalizeYouTubeOEmbedResponse,
  normalizeYouTubePlaylistResponse,
  normalizeYouTubeVideoResponse,
  parseYouTubeUrl,
  replaceYouTubePreviewMedia,
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
        channelId: "UCvideo123",
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
  assert.equal(video.preview.channelId, "UCvideo123");
  assert.equal(normalizeYouTubeVideoResponse({ items: [] }, "https://www.youtube.com/watch?v=v").status, "fallback");

  const safeFallbackVideo = normalizeYouTubeVideoResponse({
    items: [{
      snippet: {
        title: "Video with fallback thumbnail",
        description: "Video description",
        channelTitle: "Channel",
        publishedAt: "2026-07-01T00:00:00Z",
        liveBroadcastContent: "none",
        thumbnails: {
          maxres: { url: "http://example.com/not-safe.jpg" },
          medium: { url: "https://i.ytimg.com/vi/v/medium.jpg" },
        },
      },
      contentDetails: { duration: "PT1M2S" },
      statistics: { viewCount: "12345" },
    }],
  }, "https://www.youtube.com/watch?v=v");
  assert.equal(safeFallbackVideo.status, "ok");
  assert.equal(safeFallbackVideo.preview.thumbnailUrl, "https://i.ytimg.com/vi/v/medium.jpg");

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
        if (url.startsWith("https://www.googleapis.com/youtube/v3/channels?")) {
          return jsonResponse({
            items: [{
              snippet: {
                thumbnails: { default: { url: "https://yt3.ggpht.com/channel-icon.jpg" } },
              },
            }],
          });
        }
        return jsonResponse({
          items: [{
            snippet: { title: "API video", thumbnails: {}, channelId: "UCapiVideo" },
            contentDetails: { duration: "PT1S" },
            statistics: {},
          }],
        });
      },
    },
  );
  assert.equal(apiResult.status, "ok");
  assert.equal(apiResult.preview.channelIconUrl, "https://yt3.ggpht.com/channel-icon.jpg");
  assert.match(fetchedUrls[0] ?? "", /^https:\/\/www\.googleapis\.com\/youtube\/v3\/videos\?/);
  assert.match(fetchedUrls[1] ?? "", /^https:\/\/www\.googleapis\.com\/youtube\/v3\/channels\?/);
  assert.doesNotMatch(fetchedUrls.join("\n"), /search/);

  const channelIconFailureResult = await fetchYouTubePreview(
    {
      kind: "video",
      originalUrl: "https://youtu.be/icon-fail",
      canonicalUrl: "https://www.youtube.com/watch?v=icon-fail",
      id: "icon-fail",
    },
    {
      apiKey: "api-key",
      fetcher: async (url) => {
        if (url.startsWith("https://www.googleapis.com/youtube/v3/channels?")) {
          return jsonResponse({ error: { code: 500 } }, 500);
        }
        return jsonResponse({
          items: [{
            snippet: { title: "Video without icon", thumbnails: {}, channelId: "UCiconFail" },
            contentDetails: { duration: "PT2S" },
            statistics: {},
          }],
        });
      },
    },
  );
  assert.equal(channelIconFailureResult.status, "ok");
  assert.equal(channelIconFailureResult.preview.title, "Video without icon");
  assert.equal(channelIconFailureResult.preview.channelIconUrl, undefined);

  const channelIconEmptyResult = await fetchYouTubePreview(
    {
      kind: "video",
      originalUrl: "https://youtu.be/icon-empty",
      canonicalUrl: "https://www.youtube.com/watch?v=icon-empty",
      id: "icon-empty",
    },
    {
      apiKey: "api-key",
      fetcher: async (url) => {
        if (url.startsWith("https://www.googleapis.com/youtube/v3/channels?")) {
          return jsonResponse({ items: [] });
        }
        return jsonResponse({
          items: [{
            snippet: { title: "Video with empty icon response", thumbnails: {}, channelId: "UCiconEmpty" },
            contentDetails: { duration: "PT3S" },
            statistics: {},
          }],
        });
      },
    },
  );
  assert.equal(channelIconEmptyResult.status, "ok");
  assert.equal(channelIconEmptyResult.preview.channelIconUrl, undefined);

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

  const dataApiFailureThenOEmbedUrls: string[] = [];
  const dataApiFailureThenOEmbed = await fetchYouTubePreview(
    {
      kind: "video",
      originalUrl: "https://youtu.be/fallback-oembed",
      canonicalUrl: "https://www.youtube.com/watch?v=fallback-oembed",
      id: "fallback-oembed",
    },
    {
      apiKey: "key",
      fetcher: async (url): Promise<Response> => {
        dataApiFailureThenOEmbedUrls.push(url);
        if (url.startsWith("https://www.googleapis.com/youtube/v3/videos?")) {
          return jsonResponse({ error: { code: 403 } }, 403);
        }
        return jsonResponse({
          title: "OEmbed after Data API failure",
          author_name: "Fallback author",
          thumbnail_url: "https://i.ytimg.com/vi/fallback-oembed/hqdefault.jpg",
        });
      },
    },
  );
  assert.equal(dataApiFailureThenOEmbed.status, "ok");
  assert.equal(dataApiFailureThenOEmbed.preview.kind, "oembed");
  assert.equal(dataApiFailureThenOEmbed.preview.title, "OEmbed after Data API failure");
  assert.match(dataApiFailureThenOEmbedUrls[0] ?? "", /^https:\/\/www\.googleapis\.com\/youtube\/v3\/videos\?/);
  assert.match(dataApiFailureThenOEmbedUrls[1] ?? "", /^https:\/\/www\.youtube\.com\/oembed\?/);
  assert.equal(dataApiFailureThenOEmbedUrls.length, 2);

  const playlistDataApiFailureUrls: string[] = [];
  const playlistDataApiFailure = await fetchYouTubePreview(
    {
      kind: "playlist",
      originalUrl: "https://www.youtube.com/playlist?list=PL-data-api-fail",
      canonicalUrl: "https://www.youtube.com/playlist?list=PL-data-api-fail",
      id: "PL-data-api-fail",
    },
    {
      apiKey: "key",
      fetcher: async (url): Promise<Response> => {
        playlistDataApiFailureUrls.push(url);
        return jsonResponse({ error: { code: 500 } }, 500);
      },
    },
  );
  assert.deepEqual(playlistDataApiFailure, { status: "fallback", reason: "http_500" });
  assert.equal(playlistDataApiFailureUrls.length, 1);
  assert.match(playlistDataApiFailureUrls[0] ?? "", /^https:\/\/www\.googleapis\.com\/youtube\/v3\/playlists\?/);
  assert.doesNotMatch(playlistDataApiFailureUrls.join("\n"), /youtube\.com\/oembed/);

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
    channelIconUrl: "https://yt3.ggpht.com/payload-channel.jpg",
    channelTitle: "Creator",
    publishedAt: "2026-07-01T00:00:00Z",
    duration: "PT1H2M3S",
    viewCount: 1234567,
    liveBroadcastContent: "live",
  }, {
    mediaUrl: "https://media.example.com/payload.mp4",
  });
  assert.deepEqual(payload.embeds, []);
  assert.equal(payload.flags, MessageFlags.IsComponentsV2);
  assert.deepEqual(payload.allowedMentions, { parse: [], repliedUser: false });
  assert.equal("content" in payload, false);
  assert.equal(payload.components.length, 1);
  const container = payload.components[0]!;
  assert.equal(container.type, ComponentType.Container);
  assert.equal(container.components[0]?.type, ComponentType.Section);
  const section = container.components[0] as APISectionComponent;
  assert.equal(section.accessory.type, ComponentType.Thumbnail);
  const thumbnailAccessory = section.accessory;
  if (thumbnailAccessory.type !== ComponentType.Thumbnail) {
    throw new Error("expected thumbnail accessory");
  }
  assert.equal(thumbnailAccessory.media.url, "https://yt3.ggpht.com/payload-channel.jpg");
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
  assert.equal(gallery?.items[0]?.media.url, "https://media.example.com/payload.mp4");
  const row = container.components.at(-1)!;
  assert.equal(row.type, ComponentType.ActionRow);
  assert.equal(row.components[0]?.type, ComponentType.Button);
  assert.equal(row.components[0]?.style, ButtonStyle.Link);
  assert.equal(row.components[0]?.label, "YouTubeで開く");
  assert.equal(row.components[0]?.url, "https://www.youtube.com/watch?v=payload");

  const nativeVideoEmbed: APIEmbed = {
    type: EmbedType.Video,
    title: "標準Embedの動画",
    description: "Discordが生成した説明",
    url: "https://www.youtube.com/watch?v=native-video",
    provider: { name: "YouTube", url: "https://www.youtube.com" },
    thumbnail: { url: "https://i.ytimg.com/vi/native-video/hqdefault.jpg" },
    video: {
      url: "https://www.youtube.com/embed/native-video",
      proxy_url: "https://media.discordapp.net/attachments/native-video.mp4",
      content_type: "video/mp4",
      width: 1280,
      height: 720,
    },
  };
  const nativeVideoPayload = buildYouTubeNativeEmbedPayload(nativeVideoEmbed);
  assert.equal(nativeVideoPayload.flags, MessageFlags.IsComponentsV2);
  assert.deepEqual(nativeVideoPayload.embeds, []);
  assert.equal("content" in nativeVideoPayload, false);
  const nativeVideoContainer = nativeVideoPayload.components[0] as APIContainerComponent;
  const nativeVideoText = nativeVideoContainer.components
    .filter((component) => component.type === ComponentType.TextDisplay)
    .map((component) => component.content)
    .join("\n");
  assert.equal(nativeVideoText.includes("標準Embedの動画"), true);
  assert.equal(nativeVideoText.includes("Discordが生成した説明"), true);
  const nativeVideoGallery = nativeVideoContainer.components.find(
    (component) => component.type === ComponentType.MediaGallery,
  );
  assert.equal(nativeVideoGallery?.items[0]?.media.url, nativeVideoEmbed.video?.proxy_url);
  const durableNativePayload = buildYouTubeNativeEmbedPayload(
    nativeVideoEmbed,
    undefined,
    "https://media.example.com/adhd/native-video.mp4",
  );
  const durableNativeContainer = durableNativePayload.components[0] as APIContainerComponent;
  const durableNativeGallery = durableNativeContainer.components.find(
    (component) => component.type === ComponentType.MediaGallery,
  );
  assert.equal(durableNativeGallery?.items[0]?.media.url, "https://media.example.com/adhd/native-video.mp4");
  const nativeVideoRow = nativeVideoContainer.components.find((component) => component.type === ComponentType.ActionRow);
  assert.equal(nativeVideoRow?.components[0]?.type, ComponentType.Button);
  const nativeVideoButton = nativeVideoRow?.components[0];
  assert.equal("url" in (nativeVideoButton ?? {}), true);
  if (nativeVideoButton && "url" in nativeVideoButton) {
    assert.equal(nativeVideoButton.url, nativeVideoEmbed.url);
  }

  assert.equal(getYouTubeNativeEmbedVideoUrl({
    type: EmbedType.Video,
    url: "https://www.youtube.com/watch?v=proxy-only",
    thumbnail: { url: "https://i.ytimg.com/vi/proxy-only/hqdefault.jpg" },
    video: {
      url: "https://www.youtube.com/embed/proxy-only",
      proxy_url: "https://media.discordapp.net/attachments/proxy-only",
    },
  }), undefined);

  const playerOnlyEmbed: APIEmbed = {
    type: EmbedType.Video,
    title: "プレイヤーURLのみ",
    url: "https://www.youtube.com/watch?v=player-only",
    thumbnail: { url: "https://i.ytimg.com/vi/player-only/hqdefault.jpg" },
    video: { url: "https://www.youtube.com/embed/player-only" },
  };
  const playerOnlyPayload = buildYouTubeNativeEmbedPayload(playerOnlyEmbed);
  const playerOnlyContainer = playerOnlyPayload.components[0] as APIContainerComponent;
  const playerOnlyGallery = playerOnlyContainer.components.find(
    (component) => component.type === ComponentType.MediaGallery,
  );
  assert.equal(playerOnlyGallery?.items[0]?.media.url, playerOnlyEmbed.thumbnail?.url);

  const safeFallbackPayload = buildYouTubePreviewPayload(safeFallbackVideo.preview);
  const safeFallbackContainer = safeFallbackPayload.components[0] as APIContainerComponent;
  assert.equal(safeFallbackContainer.components[0]?.type, ComponentType.TextDisplay);
  const safeFallbackGallery = safeFallbackContainer.components.find(
    (component) => component.type === ComponentType.MediaGallery,
  );
  assert.equal(safeFallbackGallery?.items[0]?.media.url, "https://i.ytimg.com/vi/v/medium.jpg");

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

  const noChannelIconPayload = buildYouTubePreviewPayload({
    kind: "video",
    url: "https://www.youtube.com/watch?v=no-channel-icon",
    title: "No channel icon",
    thumbnailUrl: "https://i.ytimg.com/vi/no-channel-icon/maxresdefault.jpg",
  });
  const noChannelIconContainer = noChannelIconPayload.components[0]! as APIContainerComponent;
  assert.equal(noChannelIconContainer.components[0]?.type, ComponentType.TextDisplay);
  const noChannelIconGallery = noChannelIconContainer.components.find((component) => component.type === ComponentType.MediaGallery);
  assert.equal(noChannelIconGallery?.items[0]?.media.url, "https://i.ytimg.com/vi/no-channel-icon/maxresdefault.jpg");

  const oembedPayload = buildYouTubePreviewPayload({
    kind: "oembed",
    url: "https://www.youtube.com/watch?v=oembed-payload",
    title: "OEmbed payload",
    thumbnailUrl: "https://i.ytimg.com/vi/oembed-payload/hqdefault.jpg",
    channelTitle: "OEmbed creator",
  });
  const oembedContainer = oembedPayload.components[0]! as APIContainerComponent;
  assert.equal(oembedContainer.components[0]?.type, ComponentType.TextDisplay);

  const safeHttpsOverridePayload = buildYouTubePreviewPayload({
    kind: "video",
    url: "https://www.youtube.com/watch?v=override-media",
    title: "Override media",
    thumbnailUrl: "http://example.com/not-safe.jpg",
    channelIconUrl: "https://yt3.ggpht.com/override-channel.jpg",
  }, {
    mediaUrl: "https://media.example.com/override.mp4",
  });
  const safeHttpsOverrideContainer = safeHttpsOverridePayload.components[0]! as APIContainerComponent;
  const safeHttpsOverrideSection = safeHttpsOverrideContainer.components[0] as APISectionComponent;
  assert.equal(safeHttpsOverrideSection.type, ComponentType.Section);
  const safeHttpsOverrideAccessory = safeHttpsOverrideSection.accessory;
  assert.equal(safeHttpsOverrideAccessory.type, ComponentType.Thumbnail);
  if (safeHttpsOverrideAccessory.type !== ComponentType.Thumbnail) {
    throw new Error("expected thumbnail accessory");
  }
  assert.equal(safeHttpsOverrideAccessory.media.url, "https://yt3.ggpht.com/override-channel.jpg");
  const safeHttpsOverrideGallery = safeHttpsOverrideContainer.components.find((component) => component.type === ComponentType.MediaGallery);
  assert.equal(safeHttpsOverrideGallery?.items[0]?.media.url, "https://media.example.com/override.mp4");

  const unsafeOverrideFallbackPayload = buildYouTubePreviewPayload({
    kind: "video",
    url: "https://www.youtube.com/watch?v=unsafe-override",
    title: "Unsafe override fallback",
    thumbnailUrl: "https://i.ytimg.com/vi/unsafe-override/maxresdefault.jpg",
  }, {
    mediaUrl: "http://media.example.com/not-safe.mp4",
  });
  const unsafeOverrideFallbackContainer = unsafeOverrideFallbackPayload.components[0]! as APIContainerComponent;
  const unsafeOverrideFallbackGallery = unsafeOverrideFallbackContainer.components.find((component) => component.type === ComponentType.MediaGallery);
  assert.equal(unsafeOverrideFallbackGallery?.items[0]?.media.url, "https://i.ytimg.com/vi/unsafe-override/maxresdefault.jpg");

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

  const mediaResolverCalls: string[] = [];
  const resolvedVideoPayloads = await buildYouTubeReplyPayloads([
    {
      kind: "video",
      originalUrl: "https://youtu.be/with-media",
      canonicalUrl: "https://www.youtube.com/watch?v=with-media",
      id: "with-media",
    },
  ], {
    apiKey: "key",
    fetcher: async (url) => {
      if (url === "https://media.example.com/with-media.mp4") {
        return new Response(Buffer.from("fake mp4"), {
          headers: {
            "content-type": "video/mp4",
            "content-length": "8",
          },
        });
      }
      return jsonResponse({
      items: [{
        snippet: {
          title: "Video with media",
          thumbnails: { high: { url: "https://i.ytimg.com/vi/with-media/hqdefault.jpg" } },
        },
        contentDetails: {},
        statistics: {},
      }],
      });
    },
    mediaResolver: async (url) => {
      mediaResolverCalls.push(url);
      return { status: "ok", mediaUrl: "https://media.example.com/with-media.mp4" };
    },
  });
  const resolvedVideoContainer = resolvedVideoPayloads[0]?.components?.[0] as APIContainerComponent;
  const resolvedVideoGallery = resolvedVideoContainer.components.find(
    (component) => component.type === ComponentType.MediaGallery,
  );
  assert.deepEqual(mediaResolverCalls, ["https://www.youtube.com/watch?v=with-media"]);
  assert.equal(resolvedVideoGallery?.items[0]?.media.url, "attachment://youtube-preview.mp4");
  assert.equal(resolvedVideoPayloads[0]?.files?.length, 1);

  let durableOverrideResolverCalls = 0;
  const durableOverridePayloads = await buildYouTubeReplyPayloads([{
    kind: "video",
    originalUrl: "https://youtu.be/durable-override",
    canonicalUrl: "https://www.youtube.com/watch?v=durable-override",
    id: "durable-override",
  }], {
    apiKey: "key",
    mediaUrlOverride: "https://media.example.com/adhd/durable-override.mp4",
    fetcher: async () => jsonResponse({
      items: [{
        snippet: {
          title: "Durable override",
          thumbnails: { high: { url: "https://i.ytimg.com/vi/durable-override/hqdefault.jpg" } },
        },
        contentDetails: {},
        statistics: {},
      }],
    }),
    mediaResolver: async () => {
      durableOverrideResolverCalls += 1;
      return { status: "ok", mediaUrl: "https://rr.example.googlevideo.com/temporary.mp4" };
    },
  });
  const durableOverrideContainer = durableOverridePayloads[0]?.components?.[0] as APIContainerComponent;
  const durableOverrideGallery = durableOverrideContainer.components.find(
    (component) => component.type === ComponentType.MediaGallery,
  );
  assert.equal(durableOverrideResolverCalls, 0);
  assert.equal(durableOverrideGallery?.items[0]?.media.url, "https://media.example.com/adhd/durable-override.mp4");
  assert.equal(durableOverridePayloads[0]?.files, undefined);

  const oversizedResolverPayloads = await buildYouTubeReplyPayloads([
    {
      kind: "video",
      originalUrl: "https://youtu.be/media-oversized",
      canonicalUrl: "https://www.youtube.com/watch?v=media-oversized",
      id: "media-oversized",
    },
  ], {
    apiKey: "key",
    attachmentSizeLimitBytes: 1024,
    fetcher: async (url) => {
      if (url === "https://media.example.com/too-large.mp4") {
        return new Response(null, {
          headers: {
            "content-type": "video/mp4",
            "content-length": "2048",
          },
        });
      }
      return jsonResponse({
        items: [{
          snippet: {
            title: "Video with oversized media",
            thumbnails: { high: { url: "https://i.ytimg.com/vi/media-oversized/hqdefault.jpg" } },
          },
          contentDetails: {},
          statistics: {},
        }],
      });
    },
    mediaResolver: async () => ({ status: "ok", mediaUrl: "https://media.example.com/too-large.mp4" }),
  });
  const oversizedResolverPayload = oversizedResolverPayloads[0]!;
  assert.equal(oversizedResolverPayload.flags, MessageFlags.IsComponentsV2);
  assert.deepEqual(oversizedResolverPayload.embeds, []);
  assert.equal("content" in oversizedResolverPayload, false);
  assert.equal((oversizedResolverPayload.components?.[0] as APIContainerComponent | undefined)?.type, ComponentType.Container);
  const oversizedResolverGallery = (oversizedResolverPayload.components?.[0] as APIContainerComponent).components.find(
    (component) => component.type === ComponentType.MediaGallery,
  );
  assert.equal(oversizedResolverGallery?.items[0]?.media.url, "https://media.example.com/too-large.mp4");
  assert.deepEqual(oversizedResolverPayloads[0]?.allowedMentions, { parse: [], repliedUser: false });
  assert.equal(oversizedResolverPayloads[0]?.files, undefined);

  const streamOversizedResolverPayloads = await buildYouTubeReplyPayloads([
    {
      kind: "video",
      originalUrl: "https://youtu.be/media-stream-oversized",
      canonicalUrl: "https://www.youtube.com/watch?v=media-stream-oversized",
      id: "media-stream-oversized",
    },
  ], {
    apiKey: "key",
    attachmentSizeLimitBytes: 8,
    fetcher: async (url) => {
      if (url === "https://media.example.com/stream-too-large.mp4") {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3, 4]));
            controller.enqueue(new Uint8Array([5, 6, 7, 8]));
            controller.enqueue(new Uint8Array([9]));
            controller.close();
          },
        });
        return new Response(stream, {
          headers: {
            "content-type": "video/mp4",
          },
        });
      }
      return jsonResponse({
        items: [{
          snippet: {
            title: "Video with stream oversized media",
            description: "stream overflow",
            channelTitle: "Stream creator",
            thumbnails: { high: { url: "https://i.ytimg.com/vi/media-stream-oversized/hqdefault.jpg" } },
          },
          contentDetails: {},
          statistics: {},
        }],
      });
    },
    mediaResolver: async () => ({ status: "ok", mediaUrl: "https://media.example.com/stream-too-large.mp4" }),
  });
  const streamOversizedResolverPayload = streamOversizedResolverPayloads[0]!;
  assert.equal(streamOversizedResolverPayload.flags, MessageFlags.IsComponentsV2);
  assert.deepEqual(streamOversizedResolverPayload.embeds, []);
  assert.equal("content" in streamOversizedResolverPayload, false);
  const streamOversizedResolverGallery = (streamOversizedResolverPayload.components?.[0] as APIContainerComponent).components.find(
    (component) => component.type === ComponentType.MediaGallery,
  );
  assert.equal(streamOversizedResolverGallery?.items[0]?.media.url, "https://media.example.com/stream-too-large.mp4");

  const defaultLimitPayloads = await buildYouTubeReplyPayloads([
    {
      kind: "video",
      originalUrl: "https://youtu.be/default-limit",
      canonicalUrl: "https://www.youtube.com/watch?v=default-limit",
      id: "default-limit",
    },
  ], {
    apiKey: "key",
    fetcher: async (url) => {
      if (url === "https://media.example.com/default-limit.mp4") {
        return new Response(null, {
          headers: {
            "content-type": "video/mp4",
            "content-length": String(10 * 1024 * 1024 + 1),
          },
        });
      }
      return jsonResponse({
        items: [{
          snippet: {
            title: "Video with default limit overflow",
            thumbnails: { high: { url: "https://i.ytimg.com/vi/default-limit/hqdefault.jpg" } },
          },
          contentDetails: {},
          statistics: {},
        }],
      });
    },
    mediaResolver: async () => ({ status: "ok", mediaUrl: "https://media.example.com/default-limit.mp4" }),
  });
  const defaultLimitPayload = defaultLimitPayloads[0]!;
  assert.equal(defaultLimitPayload.flags, MessageFlags.IsComponentsV2);
  assert.deepEqual(defaultLimitPayload.embeds, []);
  assert.equal("content" in defaultLimitPayload, false);
  const defaultLimitGallery = (defaultLimitPayload.components?.[0] as APIContainerComponent).components.find(
    (component) => component.type === ComponentType.MediaGallery,
  );
  assert.equal(defaultLimitGallery?.items[0]?.media.url, "https://media.example.com/default-limit.mp4");

  const componentsOnlyPayloads = await buildYouTubeReplyPayloads([
    {
      kind: "video",
      originalUrl: "https://youtu.be/components-only",
      canonicalUrl: "https://www.youtube.com/watch?v=components-only",
      id: "components-only",
    },
  ], {
    apiKey: "key",
    attachmentSizeLimitBytes: 1024,
    componentsOnly: true,
    fetcher: async (url) => {
      if (url === "https://media.example.com/components-only.mp4") {
        return new Response(null, {
          headers: {
            "content-type": "video/mp4",
            "content-length": "2048",
          },
        });
      }
      return jsonResponse({
        items: [{
          snippet: {
            title: "Components only fallback",
            thumbnails: { high: { url: "https://i.ytimg.com/vi/components-only/hqdefault.jpg" } },
          },
          contentDetails: {},
          statistics: {},
        }],
      });
    },
    mediaResolver: async () => ({ status: "ok", mediaUrl: "https://media.example.com/components-only.mp4" }),
  });
  const componentsOnlyPayload = componentsOnlyPayloads[0]!;
  assert.equal(componentsOnlyPayload.flags, MessageFlags.IsComponentsV2);
  assert.deepEqual(componentsOnlyPayload.embeds, []);
  assert.equal("content" in componentsOnlyPayload, false);
  assert.equal((componentsOnlyPayload.components?.[0] as APIContainerComponent | undefined)?.type, ComponentType.Container);

  const componentsOnlyFailedPayloads = await buildYouTubeReplyPayloads([{
    kind: "video",
    originalUrl: "https://youtu.be/components-only-failed",
    canonicalUrl: "https://www.youtube.com/watch?v=components-only-failed",
    id: "components-only-failed",
  }], {
    apiKey: "key",
    componentsOnly: true,
    fetcher: async () => jsonResponse({ items: [] }),
  });
  const componentsOnlyFailedPayload = componentsOnlyFailedPayloads[0]!;
  assert.equal(componentsOnlyFailedPayload.flags, MessageFlags.IsComponentsV2);
  assert.deepEqual(componentsOnlyFailedPayload.embeds, []);
  assert.equal("content" in componentsOnlyFailedPayload, false);
  assert.equal((componentsOnlyFailedPayload.components?.[0] as APIContainerComponent | undefined)?.type, ComponentType.Container);

  const fallbackResolverPayloads = await buildYouTubeReplyPayloads([
    {
      kind: "video",
      originalUrl: "https://youtu.be/media-fallback",
      canonicalUrl: "https://www.youtube.com/watch?v=media-fallback",
      id: "media-fallback",
    },
  ], {
    apiKey: "key",
    fetcher: async () => jsonResponse({
      items: [{
        snippet: {
          title: "Video with thumbnail fallback",
          thumbnails: { high: { url: "https://i.ytimg.com/vi/media-fallback/hqdefault.jpg" } },
        },
        contentDetails: {},
        statistics: {},
      }],
    }),
    mediaResolver: async () => ({ status: "fallback", reason: "cli_error" }),
  });
  const fallbackResolverContainer = fallbackResolverPayloads[0]?.components?.[0] as APIContainerComponent;
  const fallbackResolverGallery = fallbackResolverContainer.components.find(
    (component) => component.type === ComponentType.MediaGallery,
  );
  assert.equal(fallbackResolverGallery?.items[0]?.media.url, "https://i.ytimg.com/vi/media-fallback/hqdefault.jpg");

  const oversizedExternalPayloads = await buildYouTubeReplyPayloads([
    {
      kind: "video",
      originalUrl: "https://youtu.be/media-oversized",
      canonicalUrl: "https://www.youtube.com/watch?v=media-oversized",
      id: "media-oversized",
    },
  ], {
    apiKey: "key",
    attachmentSizeLimitBytes: 1024,
    componentsOnly: true,
    fetcher: async (url) => {
      if (url === "https://media.example.com/oversized.mp4") {
        return new Response(null, {
          headers: {
            "content-type": "video/mp4",
            "content-length": "2048",
          },
        });
      }
      return jsonResponse({
        items: [{
          snippet: {
            title: "Oversized video",
            thumbnails: { high: { url: "https://i.ytimg.com/vi/media-oversized/hqdefault.jpg" } },
          },
          contentDetails: {},
          statistics: {},
        }],
      });
    },
    mediaResolver: async () => ({ status: "ok", mediaUrl: "https://media.example.com/oversized.mp4" }),
  });
  const oversizedExternalContainer = oversizedExternalPayloads[0]?.components?.[0] as APIContainerComponent;
  const oversizedExternalGallery = oversizedExternalContainer.components.find(
    (component) => component.type === ComponentType.MediaGallery,
  );
  assert.equal(oversizedExternalGallery?.items[0]?.media.url, "https://media.example.com/oversized.mp4");

  const throwingResolverPayloads = await buildYouTubeReplyPayloads([
    {
      kind: "video",
      originalUrl: "https://youtu.be/media-throw",
      canonicalUrl: "https://www.youtube.com/watch?v=media-throw",
      id: "media-throw",
    },
  ], {
    apiKey: "key",
    fetcher: async () => jsonResponse({
      items: [{
        snippet: {
          title: "Video with throwing resolver",
          thumbnails: { high: { url: "https://i.ytimg.com/vi/media-throw/hqdefault.jpg" } },
        },
        contentDetails: {},
        statistics: {},
      }],
    }),
    mediaResolver: async () => {
      throw new Error("media resolver exploded");
    },
  });
  const throwingResolverContainer = throwingResolverPayloads[0]?.components?.[0] as APIContainerComponent;
  const throwingResolverGallery = throwingResolverContainer.components.find(
    (component) => component.type === ComponentType.MediaGallery,
  );
  assert.equal(throwingResolverGallery?.items[0]?.media.url, "https://i.ytimg.com/vi/media-throw/hqdefault.jpg");

  const downloadErrorPayloads = await buildYouTubeReplyPayloads([
    {
      kind: "video",
      originalUrl: "https://youtu.be/media-download-error",
      canonicalUrl: "https://www.youtube.com/watch?v=media-download-error",
      id: "media-download-error",
    },
  ], {
    apiKey: "key",
    fetcher: async (url) => {
      if (url === "https://media.example.com/download-error.mp4") {
        throw new Error("network down");
      }
      return jsonResponse({
        items: [{
          snippet: {
            title: "Video with download error",
            thumbnails: { high: { url: "https://i.ytimg.com/vi/media-download-error/hqdefault.jpg" } },
          },
          contentDetails: {},
          statistics: {},
        }],
      });
    },
    mediaResolver: async () => ({ status: "ok", mediaUrl: "https://media.example.com/download-error.mp4" }),
  });
  assert.equal(downloadErrorPayloads[0]?.flags, MessageFlags.IsComponentsV2);
  const downloadErrorContainer = downloadErrorPayloads[0]?.components?.[0] as APIContainerComponent;
  const downloadErrorGallery = downloadErrorContainer.components.find(
    (component) => component.type === ComponentType.MediaGallery,
  );
  assert.equal(downloadErrorGallery?.items[0]?.media.url, "https://i.ytimg.com/vi/media-download-error/hqdefault.jpg");

  const invalidContentTypePayloads = await buildYouTubeReplyPayloads([
    {
      kind: "video",
      originalUrl: "https://youtu.be/media-invalid-type",
      canonicalUrl: "https://www.youtube.com/watch?v=media-invalid-type",
      id: "media-invalid-type",
    },
  ], {
    apiKey: "key",
    fetcher: async (url) => {
      if (url === "https://media.example.com/not-video.mp4") {
        return new Response("not a video", {
          headers: {
            "content-type": "text/html",
            "content-length": "11",
          },
        });
      }
      return jsonResponse({
        items: [{
          snippet: {
            title: "Video with invalid content type",
            thumbnails: { high: { url: "https://i.ytimg.com/vi/media-invalid-type/hqdefault.jpg" } },
          },
          contentDetails: {},
          statistics: {},
        }],
      });
    },
    mediaResolver: async () => ({ status: "ok", mediaUrl: "https://media.example.com/not-video.mp4" }),
  });
  assert.equal(invalidContentTypePayloads[0]?.flags, MessageFlags.IsComponentsV2);
  const invalidContentTypeContainer = invalidContentTypePayloads[0]?.components?.[0] as APIContainerComponent;
  const invalidContentTypeGallery = invalidContentTypeContainer.components.find(
    (component) => component.type === ComponentType.MediaGallery,
  );
  assert.equal(invalidContentTypeGallery?.items[0]?.media.url, "https://i.ytimg.com/vi/media-invalid-type/hqdefault.jpg");

  let nonVideoResolverCalls = 0;
  await buildYouTubeReplyPayloads([
    {
      kind: "playlist",
      originalUrl: "https://www.youtube.com/playlist?list=PL-non-video",
      canonicalUrl: "https://www.youtube.com/playlist?list=PL-non-video",
      id: "PL-non-video",
    },
    {
      kind: "channel",
      originalUrl: "https://www.youtube.com/@non-video",
      canonicalUrl: "https://www.youtube.com/@non-video",
      handle: "non-video",
    },
  ], {
    apiKey: "key",
    fetcher: async (url) => {
      if (url.includes("/playlists?")) {
        return jsonResponse({
          items: [{
            snippet: { title: "Playlist target", thumbnails: { medium: { url: "https://i.ytimg.com/playlist/non-video.jpg" } } },
            contentDetails: { itemCount: 3 },
          }],
        });
      }
      if (url.includes("/playlistItems?")) {
        return jsonResponse({ items: [{ snippet: { title: "First item" } }] });
      }
      return jsonResponse({
        items: [{
          snippet: { title: "Channel target", thumbnails: { default: { url: "https://yt3.ggpht.com/non-video.jpg" } } },
          statistics: { subscriberCount: "1", videoCount: "2" },
        }],
      });
    },
    mediaResolver: async () => {
      nonVideoResolverCalls += 1;
      return { status: "ok", mediaUrl: "https://media.example.com/should-not-run.mp4" };
    },
  });
  const oembedMediaPayloads = await buildYouTubeReplyPayloads([
    {
      kind: "video",
      originalUrl: "https://youtu.be/oembed-only",
      canonicalUrl: "https://www.youtube.com/watch?v=oembed-only",
      id: "oembed-only",
    },
  ], {
    fetcher: async (url) => {
      if (url === "https://media.example.com/oembed-only.mp4") {
        return new Response(Buffer.from("fake mp4"), {
          headers: {
            "content-type": "video/mp4",
            "content-length": "8",
          },
        });
      }
      return jsonResponse({
        title: "OEmbed only",
        author_name: "Author",
        thumbnail_url: "https://i.ytimg.com/vi/oembed-only/hqdefault.jpg",
      });
    },
    mediaResolver: async () => {
      nonVideoResolverCalls += 1;
      return { status: "ok", mediaUrl: "https://media.example.com/oembed-only.mp4" };
    },
  });
  const oembedMediaContainer = oembedMediaPayloads[0]?.components?.[0] as APIContainerComponent;
  const oembedMediaGallery = oembedMediaContainer.components.find(
    (component) => component.type === ComponentType.MediaGallery,
  );
  assert.equal(nonVideoResolverCalls, 1);
  assert.equal(oembedMediaGallery?.items[0]?.media.url, "attachment://youtube-preview.mp4");
  assert.equal(oembedMediaPayloads[0]?.files?.length, 1);

  const cacheFallbackPayload = buildYouTubePreviewPayload({
    kind: "video",
    url: "https://www.youtube.com/watch?v=fallback",
    title: "Fallback video",
    thumbnailUrl: "https://i.ytimg.com/vi/fallback/hqdefault.jpg",
    channelIconUrl: "https://yt3.ggpht.com/fallback.jpg",
  }, {
    fallback: true,
    mediaMode: "google",
    mediaUrl: "https://rr1---sn.googlevideo.com/videoplayback?expire=1",
    files: [new AttachmentBuilder(Buffer.from("not-used"), { name: "not-used.mp4" })],
  });
  const fallbackJson = JSON.stringify(cacheFallbackPayload);
  assert.equal(fallbackJson.includes("attachment://"), false);
  assert.equal(fallbackJson.includes("i.ytimg.com"), false);
  assert.equal(fallbackJson.includes("yt3.ggpht.com"), false);
  assert.equal(fallbackJson.includes('"type":11'), false);
  assert.equal(fallbackJson.includes("rr1---sn.googlevideo.com"), true);
  assert.equal("files" in cacheFallbackPayload, false);

  const resolverFailurePayload = buildYouTubePreviewPayload({
    kind: "video",
    url: "https://www.youtube.com/watch?v=none",
    title: "No video",
    thumbnailUrl: "https://i.ytimg.com/vi/none/hqdefault.jpg",
    channelIconUrl: "https://yt3.ggpht.com/none.jpg",
  }, { fallback: true, mediaMode: "none" });
  const resolverFailureJson = JSON.stringify(resolverFailurePayload);
  assert.equal(resolverFailureJson.includes('"type":11'), false);
  assert.equal(resolverFailureJson.includes("MediaGallery"), false);
  assert.equal(resolverFailurePayload.components[0]?.type, ComponentType.Container);
  if (resolverFailurePayload.components[0]?.type === ComponentType.Container) {
    assert.equal(resolverFailurePayload.components[0].components.some((item) => item.type === ComponentType.MediaGallery), false);
    assert.equal(resolverFailurePayload.components[0].components.at(-1)?.type, ComponentType.ActionRow);
  }

  let noneFallbackResolverCalls = 0;
  const noneFallbackReply = await buildYouTubeReplyPayloads([{
    kind: "video",
    originalUrl: "https://youtu.be/none-fallback",
    canonicalUrl: "https://www.youtube.com/watch?v=none-fallback",
    id: "none-fallback",
  }], {
    apiKey: "key",
    componentsOnly: true,
    mediaMode: "none",
    fetcher: async () => jsonResponse({
      items: [{
        snippet: {
          title: "None fallback",
          thumbnails: { high: { url: "https://i.ytimg.com/vi/none-fallback/hqdefault.jpg" } },
        },
        contentDetails: {},
        statistics: {},
      }],
    }),
    mediaResolver: async () => {
      noneFallbackResolverCalls += 1;
      return { status: "ok", mediaUrl: "https://rr.example.googlevideo.com/videoplayback?expire=1" };
    },
  });
  const noneFallbackJson = JSON.stringify(noneFallbackReply[0]);
  assert.equal(noneFallbackJson.includes("rr.example.googlevideo.com"), false);
  assert.equal(noneFallbackJson.includes("i.ytimg.com"), false);
  assert.equal("files" in noneFallbackReply[0]!, false);
  assert.equal(noneFallbackResolverCalls, 0);

  const transformedFallback = replaceYouTubePreviewMedia([{
    type: ComponentType.Container,
    components: [{
      type: ComponentType.Section,
      components: [{ type: ComponentType.TextDisplay, content: "本文を維持" }],
      accessory: { type: ComponentType.Thumbnail, media: { url: "https://yt3.ggpht.com/old.jpg" } },
    }, {
      type: ComponentType.MediaGallery,
      items: [{ media: { url: "https://expired.example/video.mp4" } }],
    }, {
      type: ComponentType.ActionRow,
      components: [{ type: ComponentType.Button, style: ButtonStyle.Link, label: "YouTubeで開く", url: "https://www.youtube.com/watch?v=old" }],
    }],
  }], undefined, { fallback: true });
  const transformedJson = JSON.stringify(transformedFallback);
  assert.equal(transformedJson.includes('"type":11'), false);
  assert.equal(transformedJson.includes("本文を維持"), true);
  assert.equal(transformedJson.includes("YouTubeで開く"), true);
  assert.equal(transformedJson.includes("MediaGallery"), false);

  const restoredFallback = replaceYouTubePreviewMedia(transformedFallback, "https://media.example/fallback.mp4", { fallback: true });
  const restoredJson = JSON.stringify(restoredFallback);
  assert.equal(restoredJson.includes("https://media.example/fallback.mp4"), true);
  assert.equal(restoredJson.includes('"type":11'), false);
}

run()
  .then(() => {
    console.log("youtubePreview.spec.ts: all assertions passed");
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
