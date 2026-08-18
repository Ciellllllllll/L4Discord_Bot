import assert from "node:assert/strict";
import { ComponentType, EmbedType, MessageFlags, type APIEmbed } from "discord.js";
import type { PreviewDocumentTranslations } from "../shared/previewTranslationGate.js";
import {
  prepareAdhdYouTubeNotification,
  probeYouTubeNativeEmbed,
  sendYouTubeWatcherNotification,
} from "./adhdYouTubeExpansion.js";
import { PREVIEW_YOUTUBE_MEDIA_REFRESH_ID } from "./youtubeMediaRefresh.js";

const entry = {
  videoId: "video-adhd",
  title: "RSS title",
  channelTitle: "RSS channel",
  publishedAt: "2026-08-17T01:02:03.000Z",
  videoUrl: "https://www.youtube.com/watch?v=video-adhd",
  thumbnailUrl: "https://i.ytimg.com/vi/video-adhd/maxresdefault.jpg",
};
const nativeEmbed: APIEmbed = {
  type: EmbedType.Video,
  title: "Native title",
  description: "Native description",
  url: entry.videoUrl,
  author: { name: "Native channel" },
  thumbnail: { url: entry.thumbnailUrl },
  video: {
    proxy_url: "https://cdn.discordapp.com/attachments/1/2/native.mp4",
    content_type: "video/mp4",
  },
};
const translations: PreviewDocumentTranslations = {
  model: "translation-model",
  translations: {
    title: { shouldTranslate: true, sourceLanguage: "en", confidence: 1, translatedText: "翻訳タイトル" },
    description: { shouldTranslate: true, sourceLanguage: "en", confidence: 1, translatedText: "翻訳説明" },
  },
};
const googleVideoUrl = "https://rr.example.googlevideo.com/videoplayback?id=video-adhd";

function textFrom(payload: { components?: readonly unknown[] }): string {
  const text: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== "object") return;
    const component = value as { type?: number; content?: unknown; components?: unknown[] };
    if (component.type === ComponentType.TextDisplay && typeof component.content === "string") text.push(component.content);
    component.components?.forEach(visit);
  };
  visit(payload.components);
  return text.join("\n");
}

function hasMedia(payload: { components?: readonly unknown[] }, url: string): boolean {
  return JSON.stringify(payload.components).includes(url);
}

{
  const listeners = new Set<(oldMessage: unknown, newMessage: unknown) => void>();
  const client = {
    on: (_event: string, listener: (oldMessage: unknown, newMessage: unknown) => void) => { listeners.add(listener); },
    off: (_event: string, listener: (oldMessage: unknown, newMessage: unknown) => void) => { listeners.delete(listener); },
  } as never;
  let deleted = false;
  const target = {
    send: async (options: { content: string; allowedMentions: { parse: [] } }) => {
      assert.equal(options.content, entry.videoUrl);
      assert.deepEqual(options.allowedMentions, { parse: [] });
      return { id: "probe-1", embeds: [], delete: async () => { deleted = true; } };
    },
  } as never;
  const result = probeYouTubeNativeEmbed(target, entry, client);
  await new Promise((resolve) => setTimeout(resolve, 10));
  for (const listener of listeners) listener({}, { id: "probe-1", embeds: [{ toJSON: () => nativeEmbed }] });
  assert.deepEqual(await result, nativeEmbed);
  assert.equal(deleted, true);
}

{
  let cacheCalls = 0;
  let probeCalls = 0;
  let fetchCalls = 0;
  let translationCalls = 0;
  let resolverCalls = 0;
  const plan = await prepareAdhdYouTubeNotification({
    client: {} as never,
    config: { YOUTUBE_DATA_API_KEY: "key", YOUTUBE_REQUEST_TIMEOUT_MS: 1_000 },
    log: { warn() {} },
  } as never, { guildId: "guild-1", id: "channel-1" } as never, entry, {
    cacheForPost: async () => {
      cacheCalls += 1;
      return { mediaMode: "none", lastError: "no_media" };
    },
    probeNative: async () => { probeCalls += 1; return nativeEmbed; },
    fetchPreview: async () => {
      fetchCalls += 1;
      throw new Error("nativeがある場合はAPIを取得しない");
    },
    translate: async (document) => {
      translationCalls += 1;
      assert.equal(JSON.stringify(document).includes("Native title"), true);
      assert.equal(JSON.stringify(document).includes("RSS channel"), true);
      return translations;
    },
    mediaResolver: async (url, options) => {
      resolverCalls += 1;
      assert.equal(url, entry.videoUrl);
      assert.equal(options?.timeoutMs, 1_000);
      assert.equal(options?.maxBytes, Number.MAX_SAFE_INTEGER);
      return resolverCalls === 1
        ? { status: "fallback", reason: "temporary_failure" }
        : { status: "ok", mediaUrl: googleVideoUrl };
    },
  });
  assert.equal(cacheCalls, 1);
  assert.equal(probeCalls, 1);
  assert.equal(fetchCalls, 0);
  assert.equal(translationCalls, 1);
  assert.equal(resolverCalls, 2);
  assert.equal(plan.document.source, "youtube");
  assert.equal(plan.translations, translations);
  assert.ok(plan.state);
  assert.equal(plan.firstPayload.flags, MessageFlags.IsComponentsV2);
  assert.equal(textFrom(plan.firstPayload).includes("翻訳タイトル"), true);
  assert.equal(textFrom(plan.firstPayload).includes("翻訳説明"), true);
  assert.equal(textFrom(plan.firstPayload).includes("RSS channel"), true);
  assert.equal(textFrom(plan.firstPayload).includes("Native channel"), false);
  assert.equal(textFrom(plan.firstPayload).includes(`<t:${Math.floor(Date.parse(entry.publishedAt) / 1_000)}:F>`), true);
  assert.equal(textFrom(plan.firstPayload).includes("translation-model"), true);
  assert.equal(JSON.stringify(plan.firstPayload).includes("preview:show-original"), true);
  assert.equal(JSON.stringify(plan.firstPayload).includes(PREVIEW_YOUTUBE_MEDIA_REFRESH_ID), true);
  assert.equal(JSON.stringify(plan.retryPayload).includes(PREVIEW_YOUTUBE_MEDIA_REFRESH_ID), true);
  assert.equal(hasMedia(plan.firstPayload, nativeEmbed.video!.proxy_url!), false);
  assert.equal(hasMedia(plan.retryPayload, nativeEmbed.video!.proxy_url!), false);
  assert.equal(hasMedia(plan.firstPayload, googleVideoUrl), true);
  assert.equal(hasMedia(plan.retryPayload, googleVideoUrl), true);
  assert.deepEqual(plan.media, { mediaMode: "google", mediaUrl: googleVideoUrl, lastError: "no_media" });
}

{
  let fetchCalls = 0;
  const plan = await prepareAdhdYouTubeNotification({
    client: {} as never,
    config: { YOUTUBE_DATA_API_KEY: "key", YOUTUBE_REQUEST_TIMEOUT_MS: 1_000 },
    log: { warn() {} },
  } as never, {} as never, entry, {
    probeNative: async () => null,
    fetchPreview: async () => {
      fetchCalls += 1;
      return { status: "ok", preview: {
        kind: "video", url: entry.videoUrl, title: "API title", description: "API description",
        channelTitle: "API channel", thumbnailUrl: entry.thumbnailUrl,
      } };
    },
    translate: async () => ({ translations: {
      title: { shouldTranslate: true, sourceLanguage: "en", confidence: 1, translatedText: "API訳題" },
    } }),
    mediaResolver: async () => ({ status: "fallback", reason: "no_suitable_format" }),
  });
  assert.equal(fetchCalls, 1);
  assert.equal(textFrom(plan.firstPayload).includes("API訳題"), true);
  assert.equal(textFrom(plan.firstPayload).includes("API description"), true);
  assert.equal(textFrom(plan.firstPayload).includes("RSS channel"), true);
  assert.equal(textFrom(plan.firstPayload).includes("API channel"), false);
  assert.equal(textFrom(plan.firstPayload).includes("翻訳されました"), false);
  assert.equal(JSON.stringify(plan.firstPayload).includes("preview:show-original"), true);
  assert.equal(hasMedia(plan.firstPayload, entry.thumbnailUrl), false);
  assert.equal(hasMedia(plan.retryPayload, entry.thumbnailUrl), false);
  assert.deepEqual(plan.media, {
    mediaMode: "none",
    lastError: "googlevideo_pending:no_suitable_format",
  });
}

{
  let cachedResolverCalls = 0;
  const googlePlan = await prepareAdhdYouTubeNotification({
    client: {} as never,
    config: { YOUTUBE_DATA_API_KEY: "", YOUTUBE_REQUEST_TIMEOUT_MS: 1_000 },
    log: { warn() {} },
  } as never, {} as never, entry, {
    cacheForPost: async () => ({ mediaMode: "google", mediaUrl: googleVideoUrl, lastError: "cache_unavailable" }),
    probeNative: async () => nativeEmbed,
    translate: async () => translations,
    mediaResolver: async () => {
      cachedResolverCalls += 1;
      return { status: "fallback", reason: "must_not_run" };
    },
  });
  assert.equal(textFrom(googlePlan.firstPayload).includes("翻訳タイトル"), true);
  assert.equal(hasMedia(googlePlan.firstPayload, googleVideoUrl), true);
  assert.equal(hasMedia(googlePlan.retryPayload, googleVideoUrl), true);
  assert.equal(hasMedia(googlePlan.firstPayload, nativeEmbed.video!.proxy_url!), false);
  assert.equal(cachedResolverCalls, 0);

  let directResolverCalls = 0;
  const directPlan = await prepareAdhdYouTubeNotification({
    client: {} as never,
    config: { YOUTUBE_DATA_API_KEY: "", YOUTUBE_REQUEST_TIMEOUT_MS: 1_000 },
    log: { warn() {} },
  } as never, {} as never, entry, {
    probeNative: async () => nativeEmbed,
    translate: async () => translations,
    mediaResolver: async () => {
      directResolverCalls += 1;
      return directResolverCalls === 1
        ? { status: "fallback", reason: "temporary_failure" }
        : { status: "ok", mediaUrl: googleVideoUrl };
    },
  });
  assert.equal(directResolverCalls, 2);
  assert.equal(hasMedia(directPlan.firstPayload, googleVideoUrl), true);
  assert.equal(hasMedia(directPlan.retryPayload, googleVideoUrl), true);
  assert.equal(hasMedia(directPlan.firstPayload, nativeEmbed.video!.proxy_url!), false);
  assert.equal(JSON.stringify(directPlan.retryPayload).includes("preview:show-original"), true);
}

for (const mediaResolver of [
  async (_url: string, _options?: unknown) => ({ status: "fallback" as const, reason: "no_suitable_format" }),
  async (_url: string, _options?: unknown) => ({ status: "fallback" as const, reason: "timeout" }),
  async (_url: string, _options?: unknown) => ({ status: "ok" as const, mediaUrl: "https://media.example/not-google.mp4" }),
  async (_url: string, _options?: unknown) => { throw new Error("resolver unavailable"); },
]) {
  let resolverCalls = 0;
  const plan = await prepareAdhdYouTubeNotification({
    client: {} as never,
    config: { YOUTUBE_DATA_API_KEY: "", YOUTUBE_REQUEST_TIMEOUT_MS: 1_000 },
    log: { warn() {} },
  } as never, {} as never, entry, {
    cacheForPost: async () => ({ mediaMode: "none", lastError: "no_media" }),
    probeNative: async () => nativeEmbed,
    translate: async () => translations,
    mediaResolver: async (url, options) => {
      resolverCalls += 1;
      return await mediaResolver(url, options);
    },
  });
  assert.equal(resolverCalls, 2);
  assert.equal(hasMedia(plan.firstPayload, entry.thumbnailUrl), false);
  assert.equal(hasMedia(plan.retryPayload, entry.thumbnailUrl), false);
  assert.equal(hasMedia(plan.firstPayload, nativeEmbed.video!.proxy_url!), false);
  assert.equal(hasMedia(plan.retryPayload, nativeEmbed.video!.proxy_url!), false);
  assert.equal(plan.media?.mediaMode, "none");
  assert.match(plan.media?.lastError ?? "", /^googlevideo_pending:/);
}

{
  const titlelessNative = { ...nativeEmbed, title: undefined };
  let translatedDocument = "";
  let fetchCalls = 0;
  const plan = await prepareAdhdYouTubeNotification({
    client: {} as never,
    config: { YOUTUBE_DATA_API_KEY: "key", YOUTUBE_REQUEST_TIMEOUT_MS: 1_000 },
    log: { warn() {} },
  } as never, {} as never, entry, {
    probeNative: async () => titlelessNative,
    fetchPreview: async () => {
      fetchCalls += 1;
      throw new Error("native媒体がある場合はAPIを取得しない");
    },
    translate: async (document) => {
      translatedDocument = JSON.stringify(document);
      return { translations: {
        title: { shouldTranslate: true, sourceLanguage: "en", confidence: 1, translatedText: "RSS題名訳" },
      } };
    },
    mediaResolver: async () => ({ status: "fallback", reason: "no_suitable_format" }),
  });
  assert.equal(fetchCalls, 0);
  assert.equal(translatedDocument.includes("RSS title"), true);
  assert.equal(translatedDocument.includes('"text":"YouTube"'), false);
  assert.equal(textFrom(plan.firstPayload).includes("RSS題名訳"), true);
  assert.equal(hasMedia(plan.firstPayload, entry.thumbnailUrl), false);
  assert.equal(hasMedia(plan.firstPayload, nativeEmbed.video!.proxy_url!), false);
}

{
  const plan = await prepareAdhdYouTubeNotification({
    client: {} as never,
    config: { YOUTUBE_DATA_API_KEY: "key", YOUTUBE_REQUEST_TIMEOUT_MS: 1_000 },
    log: { warn() {} },
  } as never, {} as never, entry, {
    probeNative: async () => null,
    fetchPreview: async () => ({ status: "fallback", reason: "unavailable" }),
    translate: async () => ({ translations: {} }),
    mediaResolver: async () => ({ status: "fallback", reason: "no_suitable_format" }),
  });
  assert.equal(textFrom(plan.firstPayload).includes("RSS title"), true);
  assert.equal(textFrom(plan.firstPayload).includes("RSS channel"), true);
  assert.equal(JSON.stringify(plan.firstPayload).includes("preview:show-original"), false);
  assert.equal(JSON.stringify(plan.firstPayload).includes(PREVIEW_YOUTUBE_MEDIA_REFRESH_ID), true);
  assert.equal(plan.state, undefined);
  assert.equal(hasMedia(plan.firstPayload, entry.thumbnailUrl), false);
}

{
  let cacheCalls = 0;
  let probeCalls = 0;
  let translationCalls = 0;
  let resolverCalls = 0;
  let sends = 0;
  const payloads: unknown[] = [];
  const sent = await sendYouTubeWatcherNotification({
    client: {} as never,
    config: { GUILD_ID: "guild-1", YOUTUBE_DATA_API_KEY: "", YOUTUBE_REQUEST_TIMEOUT_MS: 1_000 },
    log: { warn() {} },
  } as never, {
    guildId: "guild-1",
    id: "channel-1",
    send: async (payload: unknown) => {
      sends += 1;
      payloads.push(payload);
      if (sends === 1) throw new Error("first send failed");
      return { id: "message-google-retry" };
    },
  } as never, entry, {
    cacheForPost: async () => {
      cacheCalls += 1;
      return { mediaMode: "none", lastError: "cache_failed" };
    },
    probeNative: async () => {
      probeCalls += 1;
      return nativeEmbed;
    },
    translate: async () => {
      translationCalls += 1;
      return translations;
    },
    mediaResolver: async () => {
      resolverCalls += 1;
      return { status: "ok", mediaUrl: googleVideoUrl };
    },
  });
  assert.equal(cacheCalls, 1);
  assert.equal(probeCalls, 1);
  assert.equal(translationCalls, 1);
  assert.equal(resolverCalls, 1);
  assert.equal(sends, 2);
  assert.equal(payloads.every((candidate) => hasMedia(candidate as never, googleVideoUrl)), true);
  assert.equal(payloads.every((candidate) => !hasMedia(candidate as never, nativeEmbed.video!.proxy_url!)), true);
  assert.deepEqual(sent.media, { mediaMode: "google", mediaUrl: googleVideoUrl, lastError: "cache_failed" });
}

{
  let resolverCalls = 0;
  const sharedResolver = async () => {
    resolverCalls += 1;
    return { status: "fallback" as const, reason: "no_suitable_format" };
  };
  const plan = await prepareAdhdYouTubeNotification({
    client: {} as never,
    config: { YOUTUBE_DATA_API_KEY: "", YOUTUBE_REQUEST_TIMEOUT_MS: 1_000 },
    log: { warn() {} },
  } as never, {} as never, entry, {
    cacheForPost: (async (_candidate: typeof entry, resolver?: typeof sharedResolver) => {
      assert.ok(resolver);
      await resolver();
      await resolver();
      return { mediaMode: "none", lastError: "googlevideo_pending:no_suitable_format" };
    }) as never,
    probeNative: async () => nativeEmbed,
    translate: async () => translations,
    mediaResolver: sharedResolver,
  });
  assert.equal(resolverCalls, 2);
  assert.equal(hasMedia(plan.firstPayload, entry.thumbnailUrl), false);
}

{
  const noThumbnailEntry = { ...entry, thumbnailUrl: null };
  const noThumbnailNative = { ...nativeEmbed, thumbnail: undefined, image: undefined };
  const plan = await prepareAdhdYouTubeNotification({
    client: {} as never,
    config: { YOUTUBE_DATA_API_KEY: "", YOUTUBE_REQUEST_TIMEOUT_MS: 1_000 },
    log: { warn() {} },
  } as never, {} as never, noThumbnailEntry, {
    probeNative: async () => noThumbnailNative,
    translate: async () => translations,
    mediaResolver: async () => ({ status: "fallback", reason: "no_suitable_format" }),
  });
  const generatedThumbnail = "https://i.ytimg.com/vi/video-adhd/hqdefault.jpg";
  assert.equal(hasMedia(plan.firstPayload, generatedThumbnail), false);
  assert.equal(hasMedia(plan.retryPayload, generatedThumbnail), false);
}

{
  let prepares = 0;
  let sends = 0;
  let stateSaves = 0;
  const plan = await prepareAdhdYouTubeNotification({
    client: {} as never,
    config: { YOUTUBE_DATA_API_KEY: "", YOUTUBE_REQUEST_TIMEOUT_MS: 1_000 },
    log: { warn() {} },
  } as never, {} as never, entry, {
    probeNative: async () => nativeEmbed,
    cacheForPost: async () => ({ mediaMode: "vps", mediaUrl: "https://media.example/video-adhd.mp4", lastError: null }),
    translate: async () => translations,
  });
  const sent = await sendYouTubeWatcherNotification({
    client: {} as never,
    db: {} as never,
    config: { GUILD_ID: "guild-fallback" },
    log: { warn() {} },
  } as never, {
    guildId: "guild-1",
    id: "channel-1",
    send: async (payload: unknown) => {
      sends += 1;
      assert.equal(JSON.stringify(payload).includes("translation-model"), true);
      assert.equal(JSON.stringify(payload).includes("https://media.example/video-adhd.mp4"), true);
      if (sends === 1) throw new Error("first send failed");
      return { id: "message-1" };
    },
  } as never, entry, {
    prepare: async () => { prepares += 1; return plan; },
    saveState: async (_db, state) => {
      stateSaves += 1;
      assert.equal(state.messageId, "message-1");
      assert.equal(state.guildId, "guild-1");
      assert.equal(state.channelId, "channel-1");
      throw new Error("state unavailable");
    },
  });
  assert.equal(sent.message.id, "message-1");
  assert.equal(sent.media?.mediaMode, "vps");
  assert.equal(prepares, 1);
  assert.equal(sends, 2);
  assert.equal(stateSaves, 1);
}

console.log("adhdYouTubeExpansion.spec.ts: all assertions passed");
