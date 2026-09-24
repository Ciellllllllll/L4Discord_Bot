import assert from "node:assert/strict";
import { ComponentType, MessageFlags } from "discord.js";
import {
  LinkPreviewMessageHandler,
  extractXLinks,
  extractYouTubeLinks,
  extractGithubLinks,
  extractGithubEmbedImageUrls,
  extractInstagramLinks,
  refreshPreviewTranslationState,
} from "./linkPreviewMessageHandler.js";
import {
  buildYouTubeComponentsOnlyFallbackPayload,
  buildYouTubePreviewPayload,
} from "./youtube/youtubeLinkExpansion.js";
import { buildGithubFailurePayload, type GithubPreviewPayload } from "./github/githubLinkExpansion.js";
import { parseGithubUrl } from "./github/githubPreviewSource.js";

function createDb(settings: Record<string, unknown> = {}): unknown {
  return {
    selectFrom: () => ({
      selectAll: () => ({
        where: () => ({
          executeTakeFirst: async () => ({
            guild_id: "guild-1",
            data: JSON.stringify(settings),
          }),
        }),
      }),
    }),
  };
}

function createCtx(overrides: Record<string, unknown> = {}): unknown {
  return {
    config: {
      COLD_LAUGH_STORE_PATH: "NUL",
      GUILD_ID: "guild-1",
      YOUTUBE_PREVIEW_ENABLED: true,
      YOUTUBE_DATA_API_KEY: "",
      YOUTUBE_REQUEST_TIMEOUT_MS: 10,
      ...overrides,
    },
    db: createDb(),
    log: {
      error: () => {},
      warn: () => {},
    },
  };
}

async function run(): Promise<void> {
  const mixed = "x.com/user/status/123 youtube.com/watch?v=abc youtu.be/def www.youtu.be/ghi twitter.com/user/status/456";
  assert.deepEqual(extractXLinks(mixed), [
    "x.com/user/status/123",
    "twitter.com/user/status/456",
  ]);
  assert.deepEqual(extractXLinks([
    "https://vxtwitter.com/vx/status/101",
    "fxtwitter.com/fx/status/102",
    "fixupx.com/fixup/status/103",
    "fixtwitter.com/unsafe/status/104",
    "notvxtwitter.com/lookalike/status/105",
  ].join(" ")), [
    "https://vxtwitter.com/vx/status/101",
    "fxtwitter.com/fx/status/102",
    "fixupx.com/fixup/status/103",
  ]);
  assert.deepEqual(extractYouTubeLinks(mixed), [
    "youtube.com/watch?v=abc",
    "youtu.be/def",
    "www.youtu.be/ghi",
  ]);
  assert.deepEqual(extractGithubLinks([
    "github.com/octo/hello.",
    "https://github.com/octo/hello/issues/42)",
    "https://github.com.evil.example/octo/hello",
  ].join(" ")), [
    "github.com/octo/hello",
    "https://github.com/octo/hello/issues/42",
  ]);
  assert.deepEqual(extractYouTubeLinks("notyoutube.com/watch?v=落ち着けw"), []);
  assert.deepEqual(extractYouTubeLinks("notyoutube.com?u=youtube.com/watch?v=落ち着けw"), []);
  assert.deepEqual(extractYouTubeLinks("example.com?next=youtube.com/watch?v=落ち着けw"), []);
  assert.deepEqual(extractYouTubeLinks("abc#youtube.com/watch?v=落ち着けw"), []);
  assert.deepEqual(extractYouTubeLinks("https://example.com/path/youtube.com/watch?v=落ち着けw"), []);
  assert.deepEqual(extractYouTubeLinks("https://youtube.com/watch?v=scheme"), [
    "https://youtube.com/watch?v=scheme",
  ]);
  assert.deepEqual(extractYouTubeLinks([
    "youtube.com/watch?v=start",
    " youtube.com/watch?v=space",
    "\u3000youtube.com/watch?v=fullwidth-space",
    "<youtube.com/watch?v=angle",
    "(youtube.com/watch?v=paren",
    "[youtube.com/watch?v=bracket",
    "{youtube.com/watch?v=brace",
    "\"youtube.com/watch?v=double-quote",
    "'youtube.com/watch?v=single-quote",
  ].join(" ")), [
    "youtube.com/watch?v=start",
    "youtube.com/watch?v=space",
    "youtube.com/watch?v=fullwidth-space",
    "youtube.com/watch?v=angle",
    "youtube.com/watch?v=paren",
    "youtube.com/watch?v=bracket",
    "youtube.com/watch?v=brace",
    "youtube.com/watch?v=double-quote",
    "youtube.com/watch?v=single-quote",
  ]);
  assert.deepEqual(extractYouTubeLinks([
    "youtube.com/watch?v=bare",
    "www.youtube.com/watch?v=www",
    "m.youtube.com/watch?v=mobile",
    "music.youtube.com/watch?v=music",
    "youtu.be/short",
    "www.youtu.be/www-short",
    "https://youtube.com/watch?v=scheme",
    "https://www.youtube.com/watch?v=scheme-www",
    "https://m.youtube.com/watch?v=scheme-mobile",
    "https://music.youtube.com/watch?v=scheme-music",
    "https://youtu.be/scheme-short",
    "https://www.youtu.be/scheme-www-short",
  ].join(" ")), [
    "youtube.com/watch?v=bare",
    "www.youtube.com/watch?v=www",
    "m.youtube.com/watch?v=mobile",
    "music.youtube.com/watch?v=music",
    "youtu.be/short",
    "www.youtu.be/www-short",
    "https://youtube.com/watch?v=scheme",
    "https://www.youtube.com/watch?v=scheme-www",
    "https://m.youtube.com/watch?v=scheme-mobile",
    "https://music.youtube.com/watch?v=scheme-music",
    "https://youtu.be/scheme-short",
    "https://www.youtu.be/scheme-www-short",
  ]);

  const replies: unknown[] = [];
  let suppressCalls = 0;
  const message = {
    author: { bot: false, id: "user-1" },
    guild: { id: "guild-1", premiumTier: 3 },
    channelId: "channel-1",
    content: "x.com/profile youtube.com/c/custom",
    suppressEmbeds: async (value: boolean) => {
      assert.equal(value, true);
      suppressCalls += 1;
    },
    reply: async (payload: unknown) => {
      replies.push(payload);
    },
  };
  await new LinkPreviewMessageHandler(createCtx() as never).onMessage(message as never);
  assert.equal(suppressCalls, 1);
  assert.equal((replies[0] as { content?: string }).content, "https://vxtwitter.com/profile");
  assert.equal((replies[1] as { flags?: number }).flags, MessageFlags.IsComponentsV2);
  assert.equal("content" in (replies[1] as object), false);

  const mirrorReplies: unknown[] = [];
  let mirrorSuppressCalls = 0;
  await new LinkPreviewMessageHandler(createCtx() as never).onMessage({
    ...message,
    content: "https://fxtwitter.com/profile",
    suppressEmbeds: async (value: boolean) => {
      assert.equal(value, true);
      mirrorSuppressCalls += 1;
    },
    reply: async (payload: unknown) => {
      mirrorReplies.push(payload);
    },
  } as never);
  assert.equal(mirrorSuppressCalls, 1);
  assert.equal((mirrorReplies[0] as { content?: string }).content, "https://vxtwitter.com/profile");
  assert.equal((mirrorReplies[0] as { flags?: number }).flags, MessageFlags.SuppressEmbeds);

  const mirrorStatusTargets: string[] = [];
  const mirrorStatusReplies: unknown[] = [];
  await new LinkPreviewMessageHandler(createCtx() as never, {
    buildVxTwitterReplyPayloads: async (targets) => {
      mirrorStatusTargets.push(...targets.map((target) => typeof target === "string" ? target : target.vxUrl));
      return [{
        embeds: [],
        flags: MessageFlags.IsComponentsV2,
        components: [{ type: ComponentType.TextDisplay, content: "mirror status card" }],
        allowedMentions: { parse: [], repliedUser: false },
      }];
    },
  }).onMessage({
    ...message,
    content: [
      "https://vxtwitter.com/vx/status/201",
      "https://fxtwitter.com/fx/status/202",
      "https://fixupx.com/fixup/status/203",
    ].join(" "),
    reply: async (payload: unknown) => {
      mirrorStatusReplies.push(payload);
      return { id: "mirror-status-reply" };
    },
  } as never);
  assert.deepEqual(mirrorStatusTargets, [
    "https://vxtwitter.com/vx/status/201",
    "https://vxtwitter.com/fx/status/202",
    "https://vxtwitter.com/fixup/status/203",
  ]);
  assert.equal((mirrorStatusReplies[0] as { flags?: number }).flags, MessageFlags.IsComponentsV2);

  const youtubeDisabledReplies: unknown[] = [];
  const youtubeDisabledMessage = {
    ...message,
    content: "youtube.com/c/custom",
    suppressEmbeds: async () => {
      throw new Error("suppress should not be called");
    },
    reply: async (payload: unknown) => {
      youtubeDisabledReplies.push(payload);
    },
  };
  await new LinkPreviewMessageHandler(createCtx({ YOUTUBE_PREVIEW_ENABLED: false }) as never).onMessage(youtubeDisabledMessage as never);
  assert.deepEqual(youtubeDisabledReplies, []);

  const passedYoutubeOptions: unknown[] = [];
  const injectedReplies: unknown[] = [];
  const injectedMessage = {
    ...message,
    content: "youtube.com/watch?v=abc123",
    reply: async (payload: unknown) => {
      injectedReplies.push(payload);
    },
  };
  const injectedCtx = createCtx();
  const injectedMediaResolver = async () => ({ status: "fallback" as const, reason: "test" });
  const injectedFetcher = async () => new Response(null, { status: 404 });
  await new LinkPreviewMessageHandler(injectedCtx as never, {
    buildYouTubeReplyPayloads: async (_targets, options) => {
      passedYoutubeOptions.push(options);
      return [{
        content: "youtube injected reply",
        allowedMentions: { parse: [], repliedUser: false },
      }];
    },
    mediaResolver: injectedMediaResolver,
    fetcher: injectedFetcher,
  }).onMessage(injectedMessage as never);
  assert.equal(passedYoutubeOptions.length, 1);
  assert.deepEqual(passedYoutubeOptions[0], {
    apiKey: "",
    requestTimeoutMs: 10,
    componentsOnly: true,
    attachmentSizeLimitBytes: 100_000_000,
    config: (injectedCtx as { config: unknown }).config,
    aiRouter: undefined,
    guildId: "guild-1",
    log: (injectedCtx as { log: unknown }).log,
    translate: undefined,
    mediaResolver: injectedMediaResolver,
    fetcher: injectedFetcher,
  });
  assert.equal((injectedReplies[0] as { flags?: number }).flags, MessageFlags.IsComponentsV2);
  assert.equal("content" in (injectedReplies[0] as object), false);

  let nativeFallbackCalled = false;
  const nativeReplies: unknown[] = [];
  const nativeEmbed = {
    type: "video",
    title: "Discord標準YouTube Embed",
    description: "標準説明",
    url: "https://www.youtube.com/watch?v=native-message",
    thumbnail: { url: "https://i.ytimg.com/vi/native-message/hqdefault.jpg" },
    video: {
      url: "https://www.youtube.com/embed/native-message",
      proxy_url: "https://media.discordapp.net/attachments/native-message.mp4",
      content_type: "video/mp4",
    },
  };
  await new LinkPreviewMessageHandler(injectedCtx as never, {
    buildYouTubeReplyPayloads: async () => {
      nativeFallbackCalled = true;
      return [];
    },
  }).onMessage({
    ...message,
    content: "youtube.com/watch?v=native-message",
    embeds: [{ toJSON: () => nativeEmbed }],
    reply: async (payload: unknown) => {
      nativeReplies.push(payload);
    },
  } as never);
  assert.equal(nativeFallbackCalled, false);
  assert.equal(nativeReplies.length, 1);
  const nativePayload = nativeReplies[0] as { flags?: number; embeds?: unknown[]; components?: Array<{ type?: number; components?: Array<{ type?: number }> }> };
  assert.equal(nativePayload.flags, MessageFlags.IsComponentsV2);
  assert.deepEqual(nativePayload.embeds, []);
  assert.equal(nativePayload.components?.[0]?.type, ComponentType.Container);
  assert.equal(nativePayload.components?.[0]?.components?.some((component) => component.type === ComponentType.MediaGallery), true);

  let failedNativeFallbackCalled = false;
  let failedNativeResolverCalls = 0;
  let failedNativeSendAttempts = 0;
  const failedNativeReplies: unknown[] = [];
  await new LinkPreviewMessageHandler(injectedCtx as never, {
    buildYouTubeReplyPayloads: async () => {
      failedNativeFallbackCalled = true;
      return [buildYouTubePreviewPayload({
        kind: "video",
        url: "https://www.youtube.com/watch?v=native-send-failed",
        title: "direct media fallback after native failure",
        thumbnailUrl: "https://i.ytimg.com/vi/native-send-failed/hqdefault.jpg",
      })];
    },
    mediaResolver: async () => {
      failedNativeResolverCalls += 1;
      return { status: "ok", mediaUrl: "https://rr.example.googlevideo.com/native-send-failed.mp4" };
    },
    fetcher: async () => new Response(null, {
      headers: { "content-type": "video/mp4", "content-length": "100000001" },
    }),
  }).onMessage({
    ...message,
    content: "youtube.com/watch?v=native-send-failed",
    embeds: [{ toJSON: () => ({ ...nativeEmbed, url: "https://www.youtube.com/watch?v=native-send-failed" }) }],
    reply: async (payload: unknown) => {
      failedNativeSendAttempts += 1;
      if (failedNativeSendAttempts === 1) throw new Error("native payload rejected");
      failedNativeReplies.push(payload);
    },
  } as never);
  // native送信失敗時は同じ準備済み文書を再描画し、取得・翻訳をやり直さない。
  assert.equal(failedNativeFallbackCalled, false);
  assert.equal(failedNativeResolverCalls, 1);
  assert.equal(failedNativeReplies.length, 1);
  assert.equal((failedNativeReplies[0] as { flags?: number }).flags, MessageFlags.IsComponentsV2);
  assert.equal(JSON.stringify(failedNativeReplies[0]).includes("rr.example.googlevideo.com/native-send-failed.mp4"), false);

  let thumbnailNativeFallbackCalled = false;
  let thumbnailNativeResolverCalls = 0;
  const thumbnailNativeReplies: unknown[] = [];
  await new LinkPreviewMessageHandler(injectedCtx as never, {
    buildYouTubeReplyPayloads: async () => {
      thumbnailNativeFallbackCalled = true;
      return [buildYouTubePreviewPayload({
        kind: "video",
        url: "https://www.youtube.com/watch?v=thumbnail-native",
        title: "Thumbnail fallback",
        thumbnailUrl: "https://i.ytimg.com/vi/thumbnail-native/hqdefault.jpg",
      })];
    },
    mediaResolver: async () => {
      thumbnailNativeResolverCalls += 1;
      return { status: "ok", mediaUrl: "https://rr.example.googlevideo.com/thumbnail-native.mp4" };
    },
    fetcher: async () => new Response(null, {
      headers: { "content-type": "video/mp4", "content-length": "100000001" },
    }),
  }).onMessage({
    ...message,
    content: "youtube.com/watch?v=thumbnail-native",
    embeds: [{
      toJSON: () => ({
        type: "video",
        title: "Thumbnail only native Embed",
        url: "https://www.youtube.com/watch?v=thumbnail-native",
        thumbnail: { url: "https://i.ytimg.com/vi/thumbnail-native/hqdefault.jpg" },
        video: { url: "https://www.youtube.com/embed/thumbnail-native" },
      }),
    }],
    reply: async (payload: unknown) => {
      thumbnailNativeReplies.push(payload);
    },
  } as never);
  // native Embedがあれば媒体種別と独立して同じ文書を翻訳し、Data APIを再取得しない。
  assert.equal(thumbnailNativeFallbackCalled, false);
  assert.equal(thumbnailNativeResolverCalls, 1);
  assert.equal(thumbnailNativeReplies.length, 1);
  assert.equal((thumbnailNativeReplies[0] as { flags?: number }).flags, MessageFlags.IsComponentsV2);
  assert.equal(JSON.stringify(thumbnailNativeReplies[0]).includes("rr.example.googlevideo.com/thumbnail-native.mp4"), false);

  const urllessNativeFallbackTargets: string[] = [];
  const urllessReplies: unknown[] = [];
  await new LinkPreviewMessageHandler(injectedCtx as never, {
    buildYouTubeReplyPayloads: async (targets) => {
      urllessNativeFallbackTargets.push(...targets.map((target) => target.canonicalUrl));
      return [];
    },
  }).onMessage({
    ...message,
    content: "youtube.com/watch?v=url-less-one youtube.com/watch?v=url-less-two",
    embeds: [{ toJSON: () => ({ type: "video", video: { url: "https://www.youtube.com/embed/unknown" } }) }],
    reply: async (payload: unknown) => {
      urllessReplies.push(payload);
    },
  } as never);
  assert.deepEqual(urllessNativeFallbackTargets, [
    "https://www.youtube.com/watch?v=url-less-one",
    "https://www.youtube.com/watch?v=url-less-two",
  ]);
  assert.equal(urllessReplies.length, 2);
  for (const payload of urllessReplies) {
    const container = (payload as { components?: Array<{ components?: Array<{ content?: string }> }> }).components?.[0];
    assert.equal(container?.components?.some((component) => component.content?.includes("YouTube動画")), true);
  }

  const updateListeners: Array<(...args: unknown[]) => void> = [];
  const delayedClient = {
    on: (_event: string, listener: (...args: unknown[]) => void) => {
      updateListeners.push(listener);
    },
    off: (_event: string, listener: (...args: unknown[]) => void) => {
      const index = updateListeners.indexOf(listener);
      if (index >= 0) updateListeners.splice(index, 1);
    },
  };
  let delayedFallbackCalled = false;
  const delayedReplies: unknown[] = [];
  const delayedMessage = {
    ...message,
    id: "delayed-native-message",
    content: "youtube.com/watch?v=delayed-native",
    embeds: [],
    reply: async (payload: unknown) => {
      delayedReplies.push(payload);
    },
  };
  const delayedCtx = { ...(injectedCtx as Record<string, unknown>), client: delayedClient };
  const delayedRun = new LinkPreviewMessageHandler(delayedCtx as never, {
    buildYouTubeReplyPayloads: async () => {
      delayedFallbackCalled = true;
      return [];
    },
  }).onMessage(delayedMessage as never);
  await new Promise((resolve) => setTimeout(resolve, 10));
  for (const listener of [...updateListeners]) {
    listener({ id: delayedMessage.id }, { id: delayedMessage.id, embeds: [] });
  }
  assert.equal(delayedFallbackCalled, false);
  const delayedEmbed = {
    ...nativeEmbed,
    url: "https://www.youtube.com/watch?v=delayed-native",
    video: {
      ...nativeEmbed.video,
      proxy_url: "https://media.discordapp.net/attachments/delayed-native.mp4",
    },
  };
  (delayedMessage as { embeds: unknown[] }).embeds = [{ toJSON: () => delayedEmbed }];
  for (const listener of [...updateListeners]) {
    listener({ id: delayedMessage.id }, delayedMessage);
  }
  await delayedRun;
  assert.equal(delayedFallbackCalled, false);
  assert.equal(delayedReplies.length, 1);

  let dmYoutubeCalls = 0;
  const dmMessage = {
    ...message,
    guild: null,
    content: "youtube.com/watch?v=dm-test",
    suppressEmbeds: async () => {
      throw new Error("suppress should not be called in dm");
    },
    reply: async () => {
      throw new Error("reply should not be called in dm");
    },
  };
  await new LinkPreviewMessageHandler(injectedCtx as never, {
    buildYouTubeReplyPayloads: async () => {
      dmYoutubeCalls += 1;
      return [];
    },
  }).onMessage(dmMessage as never);
  assert.equal(dmYoutubeCalls, 0);

  const tier2Options: unknown[] = [];
  await new LinkPreviewMessageHandler(injectedCtx as never, {
    buildYouTubeReplyPayloads: async (_targets, options) => {
      tier2Options.push(options);
      return [];
    },
  }).onMessage({
    ...message,
    guild: { id: "guild-1", premiumTier: 2 },
    content: "youtube.com/watch?v=tier2",
  } as never);
  assert.equal((tier2Options[0] as { attachmentSizeLimitBytes?: number }).attachmentSizeLimitBytes, 50_000_000);

  const defaultLimitOptions: unknown[] = [];
  await new LinkPreviewMessageHandler(injectedCtx as never, {
    buildYouTubeReplyPayloads: async (_targets, options) => {
      defaultLimitOptions.push(options);
      return [];
    },
  }).onMessage({
    ...message,
    guild: { id: "guild-1", premiumTier: 1 },
    content: "youtube.com/watch?v=default-limit",
  } as never);
  assert.equal((defaultLimitOptions[0] as { attachmentSizeLimitBytes?: number }).attachmentSizeLimitBytes, 10 * 1024 * 1024);

  const productionEvents: string[] = [];
  const productionReplies: unknown[] = [];
  const savedReferences: unknown[] = [];
  await new LinkPreviewMessageHandler(createCtx({ BOT_PROFILE: "production" }) as never, {
    cacheYouTubeVideoForPost: async (_ctx, target) => {
      productionEvents.push(`cache:${target.videoId}`);
      return { mediaMode: "vps", mediaUrl: `https://media.example/${target.videoId}.mp4`, lastError: null };
    },
    saveYouTubeVideoCacheReference: async (_ctx, _repo, target, _input, notification) => {
      savedReferences.push({ target, notification });
      return notification.media;
    },
    buildYouTubeReplyPayloads: async () => {
      throw new Error("VPS媒体ではnative Embedを使ってよい");
    },
  }).onMessage({
    ...message,
    content: "youtube.com/watch?v=cache-before-native",
    embeds: [{ toJSON: () => ({ ...nativeEmbed, url: "https://www.youtube.com/watch?v=cache-before-native" }) }],
    reply: async (payload: unknown) => {
      productionEvents.push("reply");
      productionReplies.push(payload);
      return { id: "production-reply", components: [], edit: async () => undefined };
    },
  } as never);
  assert.deepEqual(productionEvents, ["cache:cache-before-native", "reply"]);
  assert.equal(JSON.stringify(productionReplies[0]).includes("https://media.example/cache-before-native.mp4"), true);
  assert.equal((savedReferences[0] as { notification: { message: { id: string } } }).notification.message.id, "production-reply");

  let recoveryReplyCount = 0;
  let recoveryFallbackBuilds = 0;
  await new LinkPreviewMessageHandler(createCtx({ BOT_PROFILE: "production" }) as never, {
    cacheYouTubeVideoForPost: async () => ({ mediaMode: "vps", mediaUrl: "https://media.example/recovery.mp4", lastError: null }),
    saveYouTubeVideoCacheReference: async () => { throw new Error("reference recovery failed"); },
    buildYouTubeReplyPayloads: async () => { recoveryFallbackBuilds += 1; return []; },
  }).onMessage({
    ...message,
    content: "youtube.com/watch?v=reference-recovery",
    embeds: [{ toJSON: () => ({ ...nativeEmbed, url: "https://www.youtube.com/watch?v=reference-recovery" }) }],
    reply: async () => { recoveryReplyCount += 1; return { id: "recovery-reply", components: [], edit: async () => undefined }; },
  } as never);
  assert.equal(recoveryReplyCount, 1);
  assert.equal(recoveryFallbackBuilds, 0);

  const fallbackPayloads: unknown[] = [];
  await new LinkPreviewMessageHandler(createCtx({ BOT_PROFILE: "production" }) as never, {
    cacheYouTubeVideoForPost: async () => ({
      mediaMode: "google",
      mediaUrl: "https://rr.example.googlevideo.com/direct.mp4",
      lastError: "cache_persist_error",
    }),
    saveYouTubeVideoCacheReference: async (_ctx, _repo, _target, _input, notification) => notification.media,
    buildYouTubeReplyPayloads: async () => [buildYouTubeComponentsOnlyFallbackPayload("https://www.youtube.com/watch?v=google-fallback")],
  }).onMessage({
    ...message,
    content: "youtube.com/watch?v=google-fallback",
    reply: async (payload: unknown) => {
      fallbackPayloads.push(payload);
      return { id: "google-reply", components: [], edit: async () => undefined };
    },
  } as never);
  const fallbackJson = JSON.stringify(fallbackPayloads[0]);
  assert.equal(fallbackJson.includes("rr.example.googlevideo.com/direct.mp4"), false);
  assert.equal(fallbackJson.includes("i.ytimg.com"), false);
  assert.equal(fallbackJson.includes("attachment://"), false);

  let nonVideoCacheCalls = 0;
  await new LinkPreviewMessageHandler(createCtx({ BOT_PROFILE: "production" }) as never, {
    cacheYouTubeVideoForPost: async () => {
      nonVideoCacheCalls += 1;
      return { mediaMode: "none", lastError: null };
    },
    buildYouTubeReplyPayloads: async () => [],
  }).onMessage({
    ...message,
    content: "youtube.com/playlist?list=playlist-1 youtube.com/@channel-1",
    reply: async () => ({ id: "playlist-reply" }),
  } as never);
  assert.equal(nonVideoCacheCalls, 0);

  let debugCacheCalls = 0;
  await new LinkPreviewMessageHandler(createCtx({ BOT_PROFILE: "debug" }) as never, {
    cacheYouTubeVideoForPost: async () => {
      debugCacheCalls += 1;
      return { mediaMode: "none", lastError: null };
    },
    buildYouTubeReplyPayloads: async () => [],
  }).onMessage({
    ...message,
    content: "youtube.com/watch?v=debug-video",
    reply: async () => ({ id: "debug-reply" }),
  } as never);
  assert.equal(debugCacheCalls, 0);

const githubTarget = parseGithubUrl("https://github.com/octo/hello/issues/42")!;
const githubEmbedImageUrl = "https://opengraph.githubassets.com/abc/octo/hello";
assert.deepEqual(extractGithubEmbedImageUrls({ embeds: [
  { toJSON: () => ({ url: "https://github.com/octo/hello", image: { url: githubEmbedImageUrl } }) },
  { toJSON: () => ({ url: "https://example.com/not-github", image: { url: "https://example.com/ignored.png" } }) },
] } as never), new Map([["https://github.com/octo/hello", githubEmbedImageUrl]]));
const githubFailureResult = {
    target: githubTarget,
    status: "error" as const,
    reason: "not_found" as const,
    payload: buildGithubFailurePayload(githubTarget, "not_found"),
  };
  let githubOnlySuppressCalls = 0;
  const githubOnlyReplies: unknown[] = [];
  await new LinkPreviewMessageHandler(createCtx() as never, {
    buildGithubReplyPayloads: async () => [githubFailureResult],
  }).onMessage({
    ...message,
    content: githubTarget.canonicalUrl,
    embeds: [],
    suppressEmbeds: async () => { githubOnlySuppressCalls += 1; },
    reply: async (payload: unknown) => { githubOnlyReplies.push(payload); },
  } as never);
  assert.equal(githubOnlySuppressCalls, 0);
  assert.equal(githubOnlyReplies.length, 0);

  let githubMixedSuppressCalls = 0;
  const githubMixedReplies: unknown[] = [];
  const githubRepositoryTarget = parseGithubUrl("https://github.com/octo/hello")!;
  const githubSuccessResult = {
    target: githubRepositoryTarget,
    status: "success" as const,
    payload: {
      embeds: [],
      flags: MessageFlags.IsComponentsV2,
      components: [{
        type: ComponentType.Container,
        components: [{ type: ComponentType.TextDisplay, content: "GitHub成功カード" }],
      }],
      allowedMentions: { parse: [], repliedUser: false },
    } satisfies GithubPreviewPayload,
  };
  await new LinkPreviewMessageHandler(createCtx() as never, {
    buildGithubReplyPayloads: async () => [githubSuccessResult, githubFailureResult],
  }).onMessage({
    ...message,
    content: "https://github.com/octo/hello https://github.com/octo/hello/issues/42",
    embeds: [],
    suppressEmbeds: async () => { githubMixedSuppressCalls += 1; },
    reply: async (payload: unknown) => { githubMixedReplies.push(payload); },
  } as never);
  assert.equal(githubMixedSuppressCalls, 1);
  assert.equal(githubMixedReplies.length, 2);
  assert.equal(JSON.stringify(githubMixedReplies[0]).includes("GitHub成功カード"), true);
  assert.equal(JSON.stringify(githubMixedReplies[1]).includes("GitHubリンクを取得できませんでした"), true);

  let githubMaxTargets: string[] = [];
  await new LinkPreviewMessageHandler(createCtx() as never, {
    buildGithubReplyPayloads: async (targets) => {
      githubMaxTargets = targets.map((item) => item.canonicalUrl);
      return targets.map((item) => ({
        target: item,
        status: "error" as const,
        reason: "not_found" as const,
        payload: buildGithubFailurePayload(item, "not_found"),
      }));
    },
  }).onMessage({
    ...message,
    content: Array.from({ length: 6 }, (_, index) => `https://github.com/octo/hello/issues/${index + 1}`).join(" "),
    embeds: [],
    suppressEmbeds: async () => { throw new Error("GitHub-only failures must not suppress"); },
    reply: async () => { throw new Error("GitHub-only failures must not reply"); },
  } as never);
  assert.equal(githubMaxTargets.length, 5);

  let mixedWithExistingSuppressCalls = 0;
  const mixedWithExistingReplies: unknown[] = [];
  await new LinkPreviewMessageHandler(createCtx() as never, {
    expandTwitterLinks: async () => [],
    buildGithubReplyPayloads: async () => [githubFailureResult],
  }).onMessage({
    ...message,
    content: `https://x.com/user/status/123 ${githubTarget.canonicalUrl}`,
    embeds: [],
    suppressEmbeds: async () => { mixedWithExistingSuppressCalls += 1; },
    reply: async (payload: unknown) => { mixedWithExistingReplies.push(payload); },
  } as never);
  assert.equal(mixedWithExistingSuppressCalls, 1);
  assert.equal(mixedWithExistingReplies.length, 1);

  const refreshMessage = (url: string) => ({
    id: "message-1",
    components: [{
      toJSON: () => ({
        type: ComponentType.Container,
        components: [{
          type: ComponentType.ActionRow,
          components: [{ type: ComponentType.Button, style: 5, label: "開く", url }],
        }],
      }),
    }],
  });
  const refreshed = await refreshPreviewTranslationState(
    refreshMessage("https://www.youtube.com/watch?v=video-1") as never,
    { config: {}, log: { warn() {} } } as never,
    "guild-1",
    "channel-1",
    {
      buildYouTube: async () => [{ previewState: {
        document: {
          version: 1,
          source: "youtube",
          url: "https://www.youtube.com/watch?v=video-1",
          openLabel: "YouTubeで開く",
          blocks: [],
        },
        translations: { translations: {} },
      } }],
    },
  );
  assert.equal(refreshed?.document.source, "youtube");
  assert.equal(refreshed?.messageId, "message-1");
  const refreshGithubMessage = {
    id: "message-2",
    components: [{
      toJSON: () => ({
        type: ComponentType.Container,
        components: [
          {
            type: ComponentType.MediaGallery,
            items: [{ media: { url: githubEmbedImageUrl } }],
          },
          {
            type: ComponentType.ActionRow,
            components: [{ type: ComponentType.Button, style: 5, label: "開く", url: githubTarget.canonicalUrl }],
          },
        ],
      }),
    }],
  };
  let refreshedGithubImageOptions: ReadonlyMap<string, string> | undefined;
  const refreshedGithub = await refreshPreviewTranslationState(
    refreshGithubMessage as never,
    { config: { GITHUB_API_TOKEN: "test-token" }, log: { warn() {} } } as never,
    "guild-1",
    "channel-1",
    {
      buildGithub: async (_targets, options) => {
        refreshedGithubImageOptions = options?.imageUrlByCanonicalUrl;
        return [{
          target: githubTarget,
          status: "success" as const,
          payload: {
            embeds: [],
            flags: MessageFlags.IsComponentsV2,
            components: [],
            allowedMentions: { parse: [], repliedUser: false },
            previewState: {
              document: {
                version: 1,
                source: "github",
                url: githubTarget.canonicalUrl,
                openLabel: "GitHubで開く",
                blocks: [],
              },
              translations: {
                translations: {
                  body: {
                    shouldTranslate: true,
                    sourceLanguage: "en",
                    confidence: 1,
                    translatedText: "本文",
                  },
                },
              },
            },
          },
        }];
      },
    },
  );
  assert.equal(refreshedGithub?.document.source, "github");
  assert.equal(refreshedGithub?.messageId, "message-2");
  assert.equal(refreshedGithubImageOptions?.get(githubTarget.canonicalUrl), githubEmbedImageUrl);
  assert.equal(await refreshPreviewTranslationState(
    refreshMessage("https://example.com") as never,
    {} as never,
    "guild-1",
    "channel-1",
  ), null);

  // TikTok の展開はキュー待ちがあるため、完了を待たずに onMessage を返す（後続の AutoMod 等を止めない）
  {
    let release!: () => void;
    let started = 0;
    let suppressed = 0;
    const tiktokMessage = {
      id: "tiktok-1",
      author: { bot: false, id: "user-1" },
      guild: { id: "guild-1", premiumTier: 0 },
      guildId: "guild-1",
      channelId: "channel-1",
      content: "https://www.tiktok.com/@user/video/123",
      suppressEmbeds: async () => { suppressed += 1; },
      reply: async () => undefined,
    };
    await new LinkPreviewMessageHandler(createCtx() as never, {
      expandTikTokLinks: async () => {
        started += 1;
        await new Promise<void>((resolve) => { release = resolve; });
      },
    }).onMessage(tiktokMessage as never);
    assert.equal(started, 1);
    assert.equal(suppressed, 1);
    release();
  }

  assert.deepEqual(extractInstagramLinks([
    "https://www.instagram.com/reel/DHVrPLrIyQ_/?igsh=abc",
    "instagram.com/p/BsOGulcndj-/。",
    "m.instagram.com/p/CabcdEFG",
    "instagr.am/p/CxyzABCD",
    "https://instagram.com.evil.example/p/BsOGulcndj-/",
    "notinstagram.com/p/BsOGulcndj-/",
  ].join(" ")), [
    "https://www.instagram.com/reel/DHVrPLrIyQ_/?igsh=abc",
    "instagram.com/p/BsOGulcndj-/",
    "m.instagram.com/p/CabcdEFG",
    "instagr.am/p/CxyzABCD",
  ]);

  // Instagram も TikTok と共有キューを使うため、完了を待たずに onMessage を返し、元の埋め込みは非表示にする
  {
    let release!: () => void;
    const expanded: Array<{ shortcode: string; attachmentSizeLimitBytes: number }> = [];
    let suppressed = 0;
    await new LinkPreviewMessageHandler(createCtx() as never, {
      expandInstagramLinks: async (_message, targets, deps) => {
        expanded.push(...targets.map((t) => ({ shortcode: t.shortcode, attachmentSizeLimitBytes: deps.attachmentSizeLimitBytes })));
        await new Promise<void>((resolve) => { release = resolve; });
      },
    }).onMessage({
      id: "instagram-1",
      author: { bot: false, id: "user-1" },
      guild: { id: "guild-1", premiumTier: 0 },
      guildId: "guild-1",
      channelId: "channel-1",
      content: "見て https://www.instagram.com/reel/DHVrPLrIyQ_/?igsh=abc と instagram.com/natgeo/reel/DHVrPLrIyQ_/",
      suppressEmbeds: async () => { suppressed += 1; },
      reply: async () => undefined,
    } as never);
    assert.deepEqual(expanded.map((e) => e.shortcode), ["DHVrPLrIyQ_"], "同じ投稿は1回だけ展開する");
    assert.ok((expanded[0]?.attachmentSizeLimitBytes ?? 0) > 0);
    assert.equal(suppressed, 1);
    release();
  }

  // 表示切り替え時の再構築では、メディアを取得しないよう添付サイズ上限0で構築する
  {
    let refreshOptions: { attachmentSizeLimitBytes: number } | undefined;
    const instagramUrl = "https://www.instagram.com/reel/DHVrPLrIyQ_/";
    const refreshedInstagram = await refreshPreviewTranslationState(
      refreshMessage(instagramUrl) as never,
      { config: {}, log: { warn() {} } } as never,
      "guild-1",
      "channel-1",
      {
        buildInstagram: async (_targets, options) => {
          refreshOptions = options;
          return [{
            embeds: [],
            flags: MessageFlags.IsComponentsV2,
            components: [],
            files: [],
            allowedMentions: { parse: [], repliedUser: false },
            previewState: {
              document: { version: 1, source: "instagram", url: instagramUrl, openLabel: "Instagramで開く", blocks: [] },
              translations: { translations: {} },
            },
          }];
        },
      },
    );
    assert.equal(refreshOptions?.attachmentSizeLimitBytes, 0);
    assert.equal(refreshedInstagram?.document.source, "instagram");
    assert.equal(refreshedInstagram?.sourceUrl, instagramUrl);
    assert.equal(refreshedInstagram?.messageId, "message-1");
  }
}

try {
  await run();
  console.log("linkPreviewMessageHandler.spec.ts: all assertions passed");
} catch (err) {
  console.error(err);
  process.exit(1);
}
