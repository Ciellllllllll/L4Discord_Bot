import assert from "node:assert/strict";
import { ButtonStyle, ComponentType, MessageFlags } from "discord.js";
import {
  addYouTubeMediaRefreshButton,
  handleYouTubeMediaRefresh,
  PREVIEW_YOUTUBE_MEDIA_REFRESH_ID,
} from "./youtubeMediaRefresh.js";

const videoFetcher = async () => new Response(Buffer.from("mp4"), {
  status: 200,
  headers: { "content-type": "video/mp4", "content-length": "3" },
});

function previewComponents(url: string): unknown[] {
  return [{
    type: ComponentType.Container,
    components: [
      { type: ComponentType.TextDisplay, id: 1, content: "翻訳済み本文" },
      { type: ComponentType.TextDisplay, id: 2, content: "-# この投稿は translation-model によって翻訳されました。" },
      {
        type: ComponentType.Section,
        components: [{ type: ComponentType.TextDisplay, id: 3, content: "投稿者情報" }],
        accessory: {
          type: ComponentType.Thumbnail,
          media: { url: "https://images.example/channel-icon.jpg" },
          description: "投稿者アイコン",
        },
      },
      {
        type: ComponentType.MediaGallery,
        items: [{ media: { url: "https://media.example/current.mp4" }, description: "YouTube video" }],
      },
      {
        type: ComponentType.ActionRow,
        components: [
          { type: ComponentType.Button, style: ButtonStyle.Link, label: "YouTubeで開く", url },
          { type: ComponentType.Button, style: ButtonStyle.Secondary, label: "原文を表示", custom_id: "preview:show-original" },
        ],
      },
    ],
  }];
}

function refreshButtons(components: readonly unknown[]): Array<Record<string, unknown>> {
  const buttons: Array<Record<string, unknown>> = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== "object") return;
    const component = value as Record<string, unknown>;
    if (component.type === ComponentType.Button && component.custom_id === PREVIEW_YOUTUBE_MEDIA_REFRESH_ID) {
      buttons.push(component);
    }
    if (Array.isArray(component.components)) component.components.forEach(visit);
  };
  visit(components);
  return buttons;
}

{
  const original = previewComponents("https://www.youtube.com/watch?v=abcdefghijk");
  const withButton = addYouTubeMediaRefreshButton(original);
  assert.equal(refreshButtons(original).length, 0);
  assert.deepEqual(refreshButtons(withButton), [{
    type: ComponentType.Button,
    style: ButtonStyle.Secondary,
    label: "動画を再取得",
    custom_id: PREVIEW_YOUTUBE_MEDIA_REFRESH_ID,
  }]);
  assert.equal(JSON.stringify(withButton).includes("preview:show-original"), true);
  assert.equal(JSON.stringify(withButton).includes("https://media.example/current.mp4"), true);
  assert.equal(refreshButtons(addYouTubeMediaRefreshButton(withButton)).length, 1);
}

for (const url of [
  "https://www.youtube.com/playlist?list=PL1234567890",
  "https://www.youtube.com/@example",
]) {
  assert.equal(refreshButtons(addYouTubeMediaRefreshButton(previewComponents(url))).length, 0);
}

function messageComponents(components: readonly unknown[]): Array<{ toJSON: () => unknown }> {
  return components.map((component) => ({ toJSON: () => structuredClone(component) }));
}

function interactionFixture(options: {
  editError?: Error;
  latestUrl?: string;
  url?: string;
} = {}) {
  const videoUrl = options.url ?? "https://www.youtube.com/watch?v=abcdefghijk";
  const sourceComponents = addYouTubeMediaRefreshButton(previewComponents(videoUrl));
  const latestComponents = addYouTubeMediaRefreshButton(
    previewComponents(options.latestUrl ?? videoUrl),
  ) as unknown as Array<Record<string, unknown>>;
  const container = latestComponents[0] as { components: Array<Record<string, unknown>> };
  const text = container.components.find((component) => component.type === ComponentType.TextDisplay);
  if (text) text.content = "取得中に更新された本文";
  const gallery = container.components.find((component) => component.type === ComponentType.MediaGallery);
  if (gallery) gallery.items = [{ media: { url: "https://media.example/newer.mp4" } }];
  const edits: Array<Record<string, unknown>> = [];
  const followUps: Array<Record<string, unknown>> = [];
  const events: string[] = [];
  const latestMessage = {
    id: "message-1",
    author: { id: "bot-1" },
    components: messageComponents(latestComponents),
    async edit(payload: Record<string, unknown>) {
      events.push("edit");
      if (options.editError) throw options.editError;
      edits.push(payload);
      return latestMessage;
    },
  };
  let fetches = 0;
  const interaction = {
    customId: PREVIEW_YOUTUBE_MEDIA_REFRESH_ID,
    guildId: "guild-1",
    channelId: "channel-1",
    deferred: false,
    replied: false,
    message: {
      id: "message-1",
      author: { id: "bot-1" },
      components: messageComponents(addYouTubeMediaRefreshButton(
        previewComponents("https://www.youtube.com/watch?v=stalevideo1"),
      )),
      async fetch() {
        fetches += 1;
        events.push(`fetch:${fetches}`);
        return fetches === 1
          ? { ...latestMessage, components: messageComponents(sourceComponents) }
          : latestMessage;
      },
    },
    async deferUpdate() {
      interaction.deferred = true;
      events.push("defer");
    },
    async followUp(payload: Record<string, unknown>) {
      followUps.push(payload);
      events.push("followUp");
    },
    async reply(payload: Record<string, unknown>) {
      followUps.push(payload);
      events.push("reply");
    },
  };
  return { interaction, edits, followUps, events, getFetches: () => fetches };
}

{
  const fixture = interactionFixture();
  const resolverOptions: Array<Record<string, unknown>> = [];
  let referenceUpdates = 0;
  const handled = await handleYouTubeMediaRefresh(fixture.interaction as never, {
    config: { GUILD_ID: "guild-1", YOUTUBE_REQUEST_TIMEOUT_MS: 1_234 },
    client: { user: { id: "bot-1" } },
    mainPgPool: {},
    log: { warn() {} },
  } as never, {
    resolveMedia: async (url, options) => {
      assert.equal(url, "https://www.youtube.com/watch?v=abcdefghijk");
      resolverOptions.push(options as Record<string, unknown>);
      return { status: "ok", mediaUrl: "https://rr.example.googlevideo.com/videoplayback?id=abcdefghijk" };
    },
    fetcher: async (url) => {
      assert.equal(String(url), "https://rr.example.googlevideo.com/videoplayback?id=abcdefghijk");
      return new Response(Buffer.from("mp4"), {
        status: 200,
        headers: { "content-type": "video/mp4", "content-length": "3" },
      });
    },
    updateReference: async (messageId, mediaMode, lastError) => {
      assert.equal(messageId, "message-1");
      assert.equal(mediaMode, "google");
      assert.equal(lastError, null);
      referenceUpdates += 1;
      fixture.events.push("db");
    },
  });
  assert.equal(handled, true);
  assert.deepEqual(resolverOptions, [{
    bypassCache: true,
    timeoutMs: 1_234,
    maxBytes: 10 * 1024 * 1024,
  }]);
  assert.equal(fixture.getFetches(), 2);
  assert.deepEqual(fixture.events, ["defer", "fetch:1", "fetch:2", "edit", "db"]);
  assert.equal(referenceUpdates, 1);
  assert.equal(fixture.edits.length, 1);
  const edited = JSON.stringify(fixture.edits[0]);
  assert.equal(edited.includes("取得中に更新された本文"), true);
  assert.equal(edited.includes("https://media.example/newer.mp4"), false);
  assert.equal(edited.includes("https://rr.example.googlevideo.com/videoplayback?id=abcdefghijk"), false);
  assert.equal(edited.includes("attachment://youtube-preview.mp4"), true);
  assert.equal(edited.includes("translation-model"), true);
  assert.equal(edited.includes("https://images.example/channel-icon.jpg"), true);
  assert.equal(edited.includes("preview:show-original"), true);
  assert.equal(edited.includes(PREVIEW_YOUTUBE_MEDIA_REFRESH_ID), true);
  assert.deepEqual(fixture.edits[0]?.attachments, []);
  assert.equal((fixture.edits[0]?.files as unknown[] | undefined)?.length, 1);
  assert.equal(fixture.followUps.length, 0);
}

{
  const fixture = interactionFixture();
  let release!: () => void;
  let markStarted!: () => void;
  const blocker = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  let resolverCalls = 0;
  const ctx = {
    config: { GUILD_ID: "guild-1", YOUTUBE_REQUEST_TIMEOUT_MS: 1_000 },
    client: { user: { id: "bot-1" } },
    mainPgPool: {},
    log: { warn() {} },
  } as never;
  const first = handleYouTubeMediaRefresh(fixture.interaction as never, ctx, {
    resolveMedia: async () => {
      resolverCalls += 1;
      markStarted();
      await blocker;
      return { status: "ok", mediaUrl: "https://rr.example.googlevideo.com/videoplayback?id=busy" };
    },
    fetcher: videoFetcher,
    updateReference: async () => {},
  });
  await started;
  assert.equal(await handleYouTubeMediaRefresh(fixture.interaction as never, ctx, {
    resolveMedia: async () => {
      resolverCalls += 1;
      return { status: "ok", mediaUrl: "https://rr.example.googlevideo.com/videoplayback?id=unexpected" };
    },
  }), true);
  assert.equal(resolverCalls, 1);
  assert.equal(fixture.followUps.length, 1);
  assert.match(String(fixture.followUps[0]?.content), /再取得中/);
  release();
  assert.equal(await first, true);
}

{
  const fixture = interactionFixture();
  let referenceUpdate: [string, string | null] | undefined;
  await handleYouTubeMediaRefresh(fixture.interaction as never, {
    config: { GUILD_ID: "guild-1", YOUTUBE_REQUEST_TIMEOUT_MS: 1_000 },
    client: { user: { id: "bot-1" } },
    mainPgPool: {},
    log: { warn() {} },
  } as never, {
    resolveMedia: async () => ({ status: "ok", mediaUrl: "https://rr.example.googlevideo.com/videoplayback?id=failed" }),
    fetcher: async () => new Response("unavailable", { status: 503 }),
    updateReference: async (_messageId, mediaMode, lastError) => {
      assert.equal(mediaMode, "none");
      referenceUpdate = [mediaMode, lastError];
    },
  });
  assert.equal(fixture.edits.length, 0);
  assert.equal(referenceUpdate, undefined);
  assert.equal(fixture.followUps.length, 1);
  assert.match(String(fixture.followUps[0]?.content), /再取得できませんでした/);
}

{
  const fixture = interactionFixture();
  let resolverCalls = 0;
  let referenceUpdates = 0;
  for (const result of [
    { status: "fallback" as const, reason: "timeout" },
    { status: "ok" as const, mediaUrl: "https://media.example/not-google.mp4" },
  ]) {
    await handleYouTubeMediaRefresh(fixture.interaction as never, {
      config: { GUILD_ID: "guild-1", YOUTUBE_REQUEST_TIMEOUT_MS: 1_000 },
      client: { user: { id: "bot-1" } },
      mainPgPool: {},
      log: { warn() {} },
    } as never, {
      resolveMedia: async () => { resolverCalls += 1; return result; },
      updateReference: async () => { referenceUpdates += 1; },
    });
  }
  assert.equal(resolverCalls, 2);
  assert.equal(fixture.edits.length, 0);
  assert.equal(referenceUpdates, 0);
  assert.equal(fixture.followUps.length, 2);
  assert.equal(fixture.followUps.every((payload) => payload.flags === MessageFlags.Ephemeral), true);
}

{
  const fixture = interactionFixture({ editError: new Error("Discord edit failed") });
  let referenceUpdates = 0;
  await handleYouTubeMediaRefresh(fixture.interaction as never, {
    config: { GUILD_ID: "guild-1", YOUTUBE_REQUEST_TIMEOUT_MS: 1_000 },
    client: { user: { id: "bot-1" } },
    mainPgPool: {},
    log: { warn() {} },
  } as never, {
    resolveMedia: async () => ({ status: "ok", mediaUrl: "https://rr.example.googlevideo.com/videoplayback" }),
    fetcher: videoFetcher,
    updateReference: async () => { referenceUpdates += 1; },
  });
  assert.equal(referenceUpdates, 0);
  assert.equal(fixture.followUps.length, 1);
}

for (const latestUrl of [
  "https://www.youtube.com/playlist?list=PL1234567890",
  "https://www.youtube.com/watch?v=another0001",
]) {
  const fixture = interactionFixture({ latestUrl });
  let referenceUpdates = 0;
  await handleYouTubeMediaRefresh(fixture.interaction as never, {
    config: { GUILD_ID: "guild-1", YOUTUBE_REQUEST_TIMEOUT_MS: 1_000 },
    client: { user: { id: "bot-1" } },
    mainPgPool: {},
    log: { warn() {} },
  } as never, {
    resolveMedia: async () => ({ status: "ok", mediaUrl: "https://rr.example.googlevideo.com/videoplayback" }),
    fetcher: videoFetcher,
    updateReference: async () => { referenceUpdates += 1; },
  });
  assert.equal(fixture.edits.length, 0);
  assert.equal(referenceUpdates, 0);
  assert.equal(fixture.followUps.length, 1);
}

{
  const fixture = interactionFixture();
  let referenceUpdates = 0;
  await handleYouTubeMediaRefresh(fixture.interaction as never, {
    config: { GUILD_ID: "guild-1", YOUTUBE_REQUEST_TIMEOUT_MS: 1_000 },
    client: { user: { id: "bot-1" } },
    mainPgPool: {},
    log: { warn() {} },
  } as never, {
    resolveMedia: async () => { throw new Error("resolver failed"); },
    updateReference: async () => { referenceUpdates += 1; },
  });
  assert.equal(fixture.edits.length, 0);
  assert.equal(referenceUpdates, 0);
  assert.equal(fixture.followUps.length, 1);
}

{
  const fixture = interactionFixture();
  let warnings = 0;
  await handleYouTubeMediaRefresh(fixture.interaction as never, {
    config: { GUILD_ID: "guild-1", YOUTUBE_REQUEST_TIMEOUT_MS: 1_000 },
    client: { user: { id: "bot-1" } },
    mainPgPool: {},
    log: { warn() { warnings += 1; } },
  } as never, {
    resolveMedia: async () => ({ status: "ok", mediaUrl: "https://rr.example.googlevideo.com/videoplayback" }),
    fetcher: videoFetcher,
    updateReference: async () => { throw new Error("database unavailable"); },
  });
  assert.equal(fixture.edits.length, 1);
  assert.equal(fixture.followUps.length, 0);
  assert.equal(warnings, 1);
}

{
  const fixture = interactionFixture();
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  await handleYouTubeMediaRefresh(fixture.interaction as never, {
    config: { GUILD_ID: "guild-1", YOUTUBE_REQUEST_TIMEOUT_MS: 1_000 },
    client: { user: { id: "bot-1" } },
    mainPgPool: {
      async query(sql: string, params: unknown[]) {
        queries.push({ sql, params });
        return { rows: [], rowCount: 0 };
      },
    },
    log: { warn() {} },
  } as never, {
    resolveMedia: async () => ({ status: "ok", mediaUrl: "https://rr.example.googlevideo.com/videoplayback" }),
    fetcher: videoFetcher,
  });
  assert.equal(fixture.edits.length, 1);
  assert.equal(queries.length, 1);
  assert.match(queries[0]!.sql, /^UPDATE youtube_video_cache_references/);
  assert.deepEqual(queries[0]!.params, ["google", null, "message-1"]);
}

{
  const fixture = interactionFixture();
  fixture.interaction.customId = "preview:other";
  let resolverCalls = 0;
  assert.equal(await handleYouTubeMediaRefresh(fixture.interaction as never, {} as never, {
    resolveMedia: async () => { resolverCalls += 1; return { status: "fallback", reason: "unused" }; },
  }), false);
  assert.equal(resolverCalls, 0);
}

console.log("youtubeMediaRefresh.spec.ts: all assertions passed");
