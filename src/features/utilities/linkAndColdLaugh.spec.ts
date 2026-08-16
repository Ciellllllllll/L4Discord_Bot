import assert from "node:assert/strict";
import { ComponentType, MessageFlags } from "discord.js";
import {
  LinkAndColdLaugh,
  coldLaughHitsForMessageContent,
  extractXLinks,
  extractYouTubeLinks,
  stripLinksForColdLaughContent,
} from "./linkAndColdLaugh.js";
import { buildYouTubePreviewPayload } from "./youtubePreview.js";

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
  assert.equal(coldLaughHitsForMessageContent("https://example.com/落ち着けw"), 0);
  assert.equal(coldLaughHitsForMessageContent("x.com/user/status/123/落ち着けw"), 0);
  assert.equal(coldLaughHitsForMessageContent("www.example.com/怒んなやw"), 0);
  assert.equal(coldLaughHitsForMessageContent("discord.gg/落ち着けw"), 0);
  assert.equal(coldLaughHitsForMessageContent("youtu.be/落ち着けw"), 0);
  assert.equal(coldLaughHitsForMessageContent("youtube.com/watch?v=怒んなやw"), 0);
  assert.equal(coldLaughHitsForMessageContent("music.youtube.com/watch?v=落ち着けw"), 0);
  assert.equal(coldLaughHitsForMessageContent("notyoutube.com/watch?v=落ち着けw"), 2);
  assert.equal(coldLaughHitsForMessageContent("notyoutube.com?u=youtube.com/watch?v=落ち着けw"), 2);
  assert.equal(coldLaughHitsForMessageContent("example.com?next=youtube.com/watch?v=落ち着けw"), 2);
  assert.equal(coldLaughHitsForMessageContent("abc#youtube.com/watch?v=落ち着けw"), 2);

  assert.equal(coldLaughHitsForMessageContent("落ち着けw https://example.com/post"), 2);
  assert.equal(coldLaughHitsForMessageContent("https://example.com/post 怒んなやw"), 1);

  assert.equal(stripLinksForColdLaughContent("see https://example.com/落ち着けw now").trim(), "see   now");
  assert.equal(stripLinksForColdLaughContent("see youtu.be/落ち着けw now").trim(), "see   now");
  assert.equal(stripLinksForColdLaughContent("see notyoutube.com/watch?v=落ち着けw now"), "see notyoutube.com/watch?v=落ち着けw now");
  assert.equal(
    stripLinksForColdLaughContent("see notyoutube.com?u=youtube.com/watch?v=落ち着けw now"),
    "see notyoutube.com?u=youtube.com/watch?v=落ち着けw now",
  );
  assert.equal(
    stripLinksForColdLaughContent("see example.com?next=youtube.com/watch?v=落ち着けw now"),
    "see example.com?next=youtube.com/watch?v=落ち着けw now",
  );
  assert.equal(
    stripLinksForColdLaughContent("see abc#youtube.com/watch?v=落ち着けw now"),
    "see abc#youtube.com/watch?v=落ち着けw now",
  );

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
  await new LinkAndColdLaugh(createCtx() as never).onMessage(message as never);
  assert.equal(suppressCalls, 1);
  assert.equal((replies[0] as { content?: string }).content, "https://vxtwitter.com/profile");
  assert.equal((replies[1] as { flags?: number }).flags, MessageFlags.IsComponentsV2);
  assert.equal("content" in (replies[1] as object), false);

  const mirrorReplies: unknown[] = [];
  let mirrorSuppressCalls = 0;
  await new LinkAndColdLaugh(createCtx() as never).onMessage({
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
  await new LinkAndColdLaugh(createCtx() as never, {
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
  await new LinkAndColdLaugh(createCtx({ YOUTUBE_PREVIEW_ENABLED: false }) as never).onMessage(youtubeDisabledMessage as never);
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
  await new LinkAndColdLaugh(injectedCtx as never, {
    buildYouTubeReplyPayloads: async (_targets, options) => {
      passedYoutubeOptions.push(options);
      return [{
        content: "youtube injected reply",
        allowedMentions: { parse: [], repliedUser: false },
      }];
    },
  }).onMessage(injectedMessage as never);
  assert.deepEqual(passedYoutubeOptions, [{
    apiKey: "",
    requestTimeoutMs: 10,
    componentsOnly: true,
    attachmentSizeLimitBytes: 100_000_000,
    log: (injectedCtx as { log: unknown }).log,
  }]);
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
  await new LinkAndColdLaugh(injectedCtx as never, {
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
  let failedNativeSendAttempts = 0;
  const failedNativeReplies: unknown[] = [];
  await new LinkAndColdLaugh(injectedCtx as never, {
    buildYouTubeReplyPayloads: async () => {
      failedNativeFallbackCalled = true;
      return [buildYouTubePreviewPayload({
        kind: "video",
        url: "https://www.youtube.com/watch?v=native-send-failed",
        title: "direct media fallback after native failure",
        thumbnailUrl: "https://i.ytimg.com/vi/native-send-failed/hqdefault.jpg",
      })];
    },
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
  assert.equal(failedNativeFallbackCalled, true);
  assert.equal(failedNativeReplies.length, 1);
  assert.equal((failedNativeReplies[0] as { flags?: number }).flags, MessageFlags.IsComponentsV2);

  let thumbnailNativeFallbackCalled = false;
  const thumbnailNativeReplies: unknown[] = [];
  await new LinkAndColdLaugh(injectedCtx as never, {
    buildYouTubeReplyPayloads: async () => {
      thumbnailNativeFallbackCalled = true;
      return [buildYouTubePreviewPayload({
        kind: "video",
        url: "https://www.youtube.com/watch?v=thumbnail-native",
        title: "Thumbnail fallback",
        thumbnailUrl: "https://i.ytimg.com/vi/thumbnail-native/hqdefault.jpg",
      })];
    },
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
  assert.equal(thumbnailNativeFallbackCalled, true);
  assert.equal(thumbnailNativeReplies.length, 1);
  assert.equal((thumbnailNativeReplies[0] as { flags?: number }).flags, MessageFlags.IsComponentsV2);

  let urllessNativeFallbackTargets: string[] = [];
  const urllessReplies: unknown[] = [];
  await new LinkAndColdLaugh(injectedCtx as never, {
    buildYouTubeReplyPayloads: async (targets) => {
      urllessNativeFallbackTargets = targets.map((target) => target.canonicalUrl);
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
    assert.equal(container?.components?.some((component) => component.content?.includes("## YouTube動画")), true);
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
  const delayedRun = new LinkAndColdLaugh(delayedCtx as never, {
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
  await new LinkAndColdLaugh(injectedCtx as never, {
    buildYouTubeReplyPayloads: async () => {
      dmYoutubeCalls += 1;
      return [];
    },
  }).onMessage(dmMessage as never);
  assert.equal(dmYoutubeCalls, 0);

  const tier2Options: unknown[] = [];
  await new LinkAndColdLaugh(injectedCtx as never, {
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
  await new LinkAndColdLaugh(injectedCtx as never, {
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
}

try {
  await run();
  console.log("linkAndColdLaugh.spec.ts: all assertions passed");
} catch (err) {
  console.error(err);
  process.exit(1);
}
