import assert from "node:assert/strict";
import { ComponentType, EmbedType, type APIEmbed } from "discord.js";
import type { PreviewDocumentTranslations } from "../shared/previewTranslationGate.js";
import {
  buildYouTubeComponentsOnlyFallbackPayload,
  buildYouTubeReplyPayloads,
  prepareYouTubeLinkExpansion,
  sendYouTubeLinkExpansion,
} from "./youtubeLinkExpansion.js";
import type { YouTubeReplyTarget } from "./youtubePreviewSource.js";

const target: YouTubeReplyTarget = {
  kind: "video",
  originalUrl: "https://youtu.be/video-1",
  canonicalUrl: "https://www.youtube.com/watch?v=video-1",
  id: "video-1",
};
const translated: PreviewDocumentTranslations = {
  model: "test-model",
  translations: {
    title: { shouldTranslate: true, sourceLanguage: "en", confidence: 1, translatedText: "訳題" },
    description: { shouldTranslate: true, sourceLanguage: "en", confidence: 1, translatedText: "訳文" },
  },
};

let translations = 0;
const [built] = await buildYouTubeReplyPayloads([target], {
  apiKey: "key",
  fetcher: async () => new Response(JSON.stringify({ items: [{
    snippet: { title: "Original title", description: "Original description", thumbnails: { high: { url: "https://i.ytimg.com/original.jpg" } } },
    contentDetails: {}, statistics: {},
  }] }), { status: 200 }),
  translate: async () => { translations += 1; return translated; },
  mediaMode: "vps",
  mediaUrlOverride: "https://media.example/video.mp4",
});
assert.equal(translations, 1);
assert.equal(JSON.stringify(built).includes("訳題"), true);
assert.equal(JSON.stringify(built).includes("https://media.example/video.mp4"), true);
assert.equal(JSON.stringify(built?.previewState?.document).includes("https://media.example/video.mp4"), false);
assert.equal(JSON.stringify(built?.previewState?.document).includes("https://i.ytimg.com/original.jpg"), true);

const events: string[] = [];
const native: APIEmbed = {
  type: EmbedType.Video,
  title: "Native title",
  description: "Native description",
  url: target.canonicalUrl,
  video: { proxy_url: "https://media.discordapp.net/native.mp4", content_type: "video/mp4" },
};
const plan = await prepareYouTubeLinkExpansion({
  id: "message-1",
  guild: { premiumTier: 1 },
  embeds: [{ toJSON: () => native }],
} as never, [target], {
  production: true,
  cache: async () => { events.push("cache"); return { mediaMode: "vps", mediaUrl: "https://media.example/video.mp4", lastError: null }; },
  waitForNative: async () => { events.push("native"); return native; },
});
assert.deepEqual(events, ["cache", "native"]);

let sendTranslations = 0;
let replies = 0;
let savedStates = 0;
let savedReferences = 0;
let cachedMediaResolverCalls = 0;
const message = {
  guildId: "guild-1",
  channelId: "channel-1",
  async reply(payload: unknown) {
    replies += 1;
    if (replies === 1) throw new Error("native rejected");
    assert.equal((payload as { flags?: number }).flags !== undefined, true);
    return { id: "reply-1", components: [{ toJSON: () => ({ type: ComponentType.Container, components: [] }) }], edit: async () => undefined };
  },
};
await sendYouTubeLinkExpansion(message as never, plan, {
  db: {} as never,
  config: { YOUTUBE_DATA_API_KEY: "", YOUTUBE_REQUEST_TIMEOUT_MS: 10 } as never,
  log: { warn() {} },
  translate: async () => { sendTranslations += 1; return translated; },
  saveState: async () => { savedStates += 1; },
  saveReference: async () => { savedReferences += 1; return plan.items[0]!.media!; },
  cacheReferenceRepo: {} as never,
  mediaResolver: async () => {
    cachedMediaResolverCalls += 1;
    return { status: "fallback", reason: "must_not_run" };
  },
});
assert.equal(sendTranslations, 1);
assert.equal(replies, 2);
assert.equal(savedStates, 1);
assert.equal(savedReferences, 1);
assert.equal(cachedMediaResolverCalls, 0);

const referenceRepo = { marker: "reference-repo" };
let referenceFactories = 0;
for (const media of [
  { mediaMode: "google" as const, mediaUrl: "https://rr.example.googlevideo.com/native.mp4", lastError: "cache_persist_error" },
  { mediaMode: "none" as const, lastError: "no_media" },
]) {
  let nativeTranslations = 0;
  let apiBuilds = 0;
  let nativeResolverCalls = 0;
  let savedNotificationMedia: unknown;
  const sent: unknown[] = [];
  await sendYouTubeLinkExpansion({
    guildId: "guild-1",
    channelId: "channel-1",
    async reply(payload: unknown) {
      sent.push(payload);
      return { id: `reply-${media.mediaMode}`, components: [], edit: async () => undefined };
    },
  } as never, { items: [{ target, nativeEmbed: native, media }] }, {
    db: {} as never,
    config: { YOUTUBE_DATA_API_KEY: "broken", YOUTUBE_REQUEST_TIMEOUT_MS: 10 } as never,
    log: { warn() {} },
    translate: async () => { nativeTranslations += 1; return translated; },
    buildReplyPayloads: async () => { apiBuilds += 1; throw new Error("API must not run when native exists"); },
    saveReference: async (_ctx, repo, _target, _input, notification) => {
      assert.equal(repo, referenceRepo);
      savedNotificationMedia = notification.media;
      return media;
    },
    createCacheReferenceRepo: () => {
      referenceFactories += 1;
      return referenceRepo as never;
    },
    mediaResolver: async () => {
      nativeResolverCalls += 1;
      return { status: "fallback", reason: "must_not_run" };
    },
  });
  assert.equal(nativeTranslations, 1);
  assert.equal(apiBuilds, 0);
  assert.equal(JSON.stringify(sent[0]).includes("訳題"), true);
  assert.equal(JSON.stringify(sent[0]).includes("googlevideo.com"), media.mediaMode === "google");
  assert.equal(nativeResolverCalls, 0);
  assert.deepEqual(savedNotificationMedia, media);
}
assert.equal(referenceFactories, 2);

let noMediaRepoFactories = 0;
await sendYouTubeLinkExpansion({
  guildId: "guild-1",
  channelId: "channel-1",
  async reply() { return { id: "reply-no-media", components: [], edit: async () => undefined }; },
} as never, { items: [{ target, nativeEmbed: native }] }, {
  db: {} as never,
  config: { YOUTUBE_DATA_API_KEY: "", YOUTUBE_REQUEST_TIMEOUT_MS: 10 } as never,
  log: { warn() {} },
  translate: async () => translated,
  createCacheReferenceRepo: () => { noMediaRepoFactories += 1; return referenceRepo as never; },
});
assert.equal(noMediaRepoFactories, 0);

const thumbnailOnlyNative: APIEmbed = {
  type: EmbedType.Video,
  title: "Thumbnail only native",
  description: "Native metadata must remain translated",
  url: target.canonicalUrl,
  thumbnail: { url: "https://i.ytimg.com/vi/video-1/hqdefault.jpg" },
  video: { url: "https://www.youtube.com/embed/video-1" },
};
const googleVideoUrl = "https://rr.example.googlevideo.com/videoplayback?id=video-1";
const externalMediaFetcher = async (url: string | URL | Request) => {
  assert.equal(String(url), googleVideoUrl);
  return new Response(null, {
    headers: { "content-type": "video/mp4", "content-length": "2048" },
  });
};

for (const media of [undefined, { mediaMode: "none" as const, lastError: "resolver_failed" }]) {
  let resolverCalls = 0;
  let translationCalls = 0;
  let savedMedia: unknown;
  const sent: unknown[] = [];
  await sendYouTubeLinkExpansion({
    guildId: "guild-1",
    channelId: "channel-1",
    async reply(payload: unknown) {
      sent.push(payload);
      return { id: `reply-final-fallback-${media?.mediaMode ?? "debug"}`, components: [], edit: async () => undefined };
    },
  } as never, {
    items: [{ target, nativeEmbed: thumbnailOnlyNative, ...(media ? { media } : {}) }],
  }, {
    db: {} as never,
    config: { YOUTUBE_DATA_API_KEY: "", YOUTUBE_REQUEST_TIMEOUT_MS: 10 } as never,
    log: { warn() {} },
    attachmentSizeLimitBytes: 1024,
    translate: async () => { translationCalls += 1; return translated; },
    mediaResolver: async (url: string) => {
      resolverCalls += 1;
      assert.equal(url, target.canonicalUrl);
      return resolverCalls % 2 === 1
        ? { status: "fallback", reason: "temporary_failure" }
        : { status: "ok", mediaUrl: googleVideoUrl };
    },
    fetcher: externalMediaFetcher as never,
    saveState: async () => undefined,
    ...(media ? {
      saveReference: async (
        _ctx: never,
        _repo: never,
        _target: never,
        _input: never,
        notification: { media: unknown },
      ) => {
        savedMedia = notification.media;
        return notification.media;
      },
      cacheReferenceRepo: {} as never,
    } : {}),
  } as never);
  assert.equal(resolverCalls, 2);
  assert.equal(translationCalls, 1);
  assert.equal(JSON.stringify(sent[0]).includes(googleVideoUrl), true);
  assert.equal(JSON.stringify(sent[0]).includes("訳題"), true);
  if (media) {
    assert.deepEqual(savedMedia, {
      mediaMode: "google",
      mediaUrl: googleVideoUrl,
      lastError: null,
    });
  }
}

for (const media of [undefined, { mediaMode: "none" as const, lastError: "cache_failed" }]) {
  let resolverCalls = 0;
  let savedMedia: unknown;
  const sent: unknown[] = [];
  await sendYouTubeLinkExpansion({
    guildId: "guild-1",
    channelId: "channel-1",
    async reply(payload: unknown) {
      sent.push(payload);
      return { id: "reply-resolver-failure", components: [], edit: async () => undefined };
    },
  } as never, { items: [{ target, nativeEmbed: thumbnailOnlyNative, ...(media ? { media } : {}) }] }, {
    db: {} as never,
    config: { YOUTUBE_DATA_API_KEY: "", YOUTUBE_REQUEST_TIMEOUT_MS: 10 } as never,
    log: { warn() {} },
    translate: async () => translated,
    mediaResolver: async () => {
      resolverCalls += 1;
      return { status: "fallback", reason: "resolver_failed" };
    },
    fetcher: async () => { throw new Error("媒体URLがない場合はdownloadしない"); },
    saveState: async () => undefined,
    saveReference: async (_ctx: never, _repo: never, _target: never, _input: never, notification: { media: unknown }) => {
      savedMedia = notification.media;
      return notification.media;
    },
    cacheReferenceRepo: {} as never,
  } as never);
  assert.equal(resolverCalls, 2);
  assert.equal(JSON.stringify(sent[0]).includes(thumbnailOnlyNative.thumbnail!.url), false);
  assert.deepEqual(savedMedia, {
    mediaMode: "none",
    lastError: "googlevideo_pending:resolver_failed",
  });
}

for (const media of [undefined, { mediaMode: "none" as const, lastError: "cache_metadata_failed" }]) {
  let resolverCalls = 0;
  let savedMedia: unknown;
  const sent: unknown[] = [];
  await sendYouTubeLinkExpansion({
    guildId: "guild-1",
    channelId: "channel-1",
    async reply(payload: unknown) {
      sent.push(payload);
      return { id: "reply-metadata-failure", components: [], edit: async () => undefined };
    },
  } as never, { items: [{ target, nativeEmbed: null, ...(media ? { media } : {}) }] }, {
    db: {} as never,
    config: { YOUTUBE_DATA_API_KEY: "key", YOUTUBE_REQUEST_TIMEOUT_MS: 10 } as never,
    log: { warn() {} },
    buildReplyPayloads: async () => [buildYouTubeComponentsOnlyFallbackPayload(target.canonicalUrl)],
    translate: async () => translated,
    mediaResolver: async () => {
      resolverCalls += 1;
      return { status: "fallback", reason: "metadata_media_failed" };
    },
    saveReference: async (_ctx: never, _repo: never, _target: never, _input: never, notification: { media: unknown }) => {
      savedMedia = notification.media;
      return notification.media as never;
    },
    cacheReferenceRepo: {} as never,
  } as never);
  assert.equal(resolverCalls, 2);
  assert.equal(JSON.stringify(sent[0]).includes("i.ytimg.com"), false);
  assert.deepEqual(savedMedia, {
    mediaMode: "none",
    lastError: "googlevideo_pending:metadata_media_failed",
  });
}

{
  let resolverCalls = 0;
  let savedMedia: unknown;
  const sent: unknown[] = [];
  await sendYouTubeLinkExpansion({
    guildId: "guild-1", channelId: "channel-1",
    async reply(payload: unknown) {
      sent.push(payload);
      return { id: "reply-already-pending", components: [], edit: async () => undefined };
    },
  } as never, { items: [{
    target,
    nativeEmbed: thumbnailOnlyNative,
    media: { mediaMode: "none", lastError: "googlevideo_pending:timeout" },
  }] }, {
    db: {} as never,
    config: { YOUTUBE_DATA_API_KEY: "", YOUTUBE_REQUEST_TIMEOUT_MS: 10 } as never,
    log: { warn() {} },
    translate: async () => translated,
    mediaResolver: async () => { resolverCalls += 1; return { status: "fallback", reason: "unused" }; },
    saveState: async () => undefined,
    saveReference: async (_ctx: never, _repo: never, _target: never, _input: never, notification: { media: unknown }) => {
      savedMedia = notification.media;
      return notification.media;
    },
    cacheReferenceRepo: {} as never,
  } as never);
  assert.equal(resolverCalls, 0);
  assert.equal(JSON.stringify(sent[0]).includes(thumbnailOnlyNative.thumbnail!.url), false);
  assert.deepEqual(savedMedia, { mediaMode: "none", lastError: "googlevideo_pending:timeout" });
}

{
  let resolverCalls = 0;
  let translationCalls = 0;
  let sendAttempts = 0;
  const sent: unknown[] = [];
  await sendYouTubeLinkExpansion({
    guildId: "guild-1",
    channelId: "channel-1",
    async reply(payload: unknown) {
      sendAttempts += 1;
      if (sendAttempts === 1) throw new Error("native media rejected");
      sent.push(payload);
      return { id: "reply-native-retry", components: [], edit: async () => undefined };
    },
  } as never, { items: [{ target, nativeEmbed: native }] }, {
    db: {} as never,
    config: { YOUTUBE_DATA_API_KEY: "", YOUTUBE_REQUEST_TIMEOUT_MS: 10 } as never,
    log: { warn() {} },
    attachmentSizeLimitBytes: 1024,
    translate: async () => { translationCalls += 1; return translated; },
    mediaResolver: async () => {
      resolverCalls += 1;
      return { status: "ok", mediaUrl: googleVideoUrl };
    },
    fetcher: externalMediaFetcher as never,
    saveState: async () => undefined,
  } as never);
  assert.equal(sendAttempts, 2);
  assert.equal(resolverCalls, 1);
  assert.equal(translationCalls, 1);
  assert.equal(JSON.stringify(sent[0]).includes(googleVideoUrl), true);
  assert.equal(JSON.stringify(sent[0]).includes("訳題"), true);
}

{
  let resolverCalls = 0;
  let translationCalls = 0;
  let savedMedia: unknown;
  const sent: unknown[] = [];
  await sendYouTubeLinkExpansion({
    guildId: "guild-1",
    channelId: "channel-1",
    async reply(payload: unknown) {
      sent.push(payload);
      return { id: "reply-api-final-fallback", components: [], edit: async () => undefined };
    },
  } as never, {
    items: [{ target, nativeEmbed: null, media: { mediaMode: "none", lastError: "cache_failed" } }],
  }, {
    db: {} as never,
    config: { YOUTUBE_DATA_API_KEY: "key", YOUTUBE_REQUEST_TIMEOUT_MS: 10 } as never,
    log: { warn() {} },
    attachmentSizeLimitBytes: 1024,
    translate: async () => { translationCalls += 1; return translated; },
    mediaResolver: async () => {
      resolverCalls += 1;
      return { status: "ok", mediaUrl: googleVideoUrl };
    },
    fetcher: async (url: string | URL | Request) => String(url).includes("googleapis.com")
      ? new Response(JSON.stringify({ items: [{
        snippet: {
          title: "API title",
          description: "API description",
          thumbnails: { high: { url: thumbnailOnlyNative.thumbnail!.url } },
        },
        contentDetails: {},
        statistics: {},
      }] }), { status: 200 })
      : await externalMediaFetcher(url),
    saveState: async () => undefined,
    saveReference: async (
      _ctx: never,
      _repo: never,
      _target: never,
      _input: never,
      notification: { media: unknown },
    ) => {
      savedMedia = notification.media;
      return notification.media as never;
    },
    cacheReferenceRepo: {} as never,
  } as never);
  assert.equal(resolverCalls, 1);
  assert.equal(translationCalls, 1);
  assert.equal(JSON.stringify(sent[0]).includes(googleVideoUrl), true);
  assert.deepEqual(savedMedia, { mediaMode: "google", mediaUrl: googleVideoUrl, lastError: null });
}

{
  let resolverCalls = 0;
  let translationCalls = 0;
  let sendAttempts = 0;
  const sent: unknown[] = [];
  await sendYouTubeLinkExpansion({
    guildId: "guild-1",
    channelId: "channel-1",
    async reply(payload: unknown) {
      sendAttempts += 1;
      if (sendAttempts === 1) throw new Error("native media rejected");
      sent.push(payload);
      return { id: "reply-native-thumbnail-retry", components: [], edit: async () => undefined };
    },
  } as never, { items: [{ target, nativeEmbed: { ...native, thumbnail: thumbnailOnlyNative.thumbnail } }] }, {
    db: {} as never,
    config: { YOUTUBE_DATA_API_KEY: "", YOUTUBE_REQUEST_TIMEOUT_MS: 10 } as never,
    log: { warn() {} },
    translate: async () => { translationCalls += 1; return translated; },
    mediaResolver: async () => {
      resolverCalls += 1;
      return { status: "fallback", reason: "resolver_failed" };
    },
    fetcher: async () => { throw new Error("媒体URLがない場合はdownloadしない"); },
    saveState: async () => undefined,
  } as never);
  assert.equal(sendAttempts, 2);
  assert.equal(resolverCalls, 2);
  assert.equal(translationCalls, 1);
  assert.equal(JSON.stringify(sent[0]).includes(thumbnailOnlyNative.thumbnail!.url), false);
  assert.equal(JSON.stringify(sent[0]).includes(native.video!.proxy_url!), false);
}

console.log("youtubeLinkExpansion.spec.ts: all assertions passed");
