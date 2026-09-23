import assert from "node:assert/strict";
import { ComponentType, MessageFlags } from "discord.js";
import { LocalLlmQueue } from "../../ai/localLlmQueue.js";
import { buildTikTokReplyPayloads, expandTikTokLinks, MAX_TIKTOK_TARGETS_PER_MESSAGE } from "./tiktokLinkExpansion.js";
import { collectTikTokReplyTargets, normalizeTikwmResponse, parseTikTokUrl } from "./tiktokPreviewSource.js";

assert.deepEqual(parseTikTokUrl("https://www.tiktok.com/@user/video/123?lang=ja"), {
  url: "https://www.tiktok.com/@user/video/123",
  videoId: "123",
});
assert.deepEqual(parseTikTokUrl("tiktok.com/@user/photo/456。"), {
  url: "https://www.tiktok.com/@user/photo/456",
  videoId: "456",
});
assert.deepEqual(parseTikTokUrl("vm.tiktok.com/ZMabc123/"), { url: "https://vm.tiktok.com/ZMabc123/" });
assert.deepEqual(parseTikTokUrl("https://www.tiktok.com/t/ZTabc/"), { url: "https://www.tiktok.com/t/ZTabc/" });
assert.equal(parseTikTokUrl("https://www.tiktok.com/@user"), null);
assert.equal(parseTikTokUrl("https://example.com/@user/video/123"), null);
assert.equal(collectTikTokReplyTargets([
  "https://www.tiktok.com/@user/video/123",
  "https://m.tiktok.com/v/123.html",
]).length, 1);

const apiData = {
  code: 0,
  data: {
    id: "123",
    title: "hello",
    play: "https://cdn.example/video.mp4",
    cover: "https://cdn.example/cover.jpg",
    author: { unique_id: "user", nickname: "User" },
    digg_count: 5,
  },
};

assert.equal(normalizeTikwmResponse({ code: -1, msg: "not found" }).status, "fallback");
{
  const result = normalizeTikwmResponse({ code: 0, data: { ...apiData.data, images: ["https://cdn.example/1.jpg"] } });
  assert.equal(result.status, "ok");
  if (result.status === "ok") {
    assert.equal(result.video.url, "https://www.tiktok.com/@user/photo/123");
    assert.equal(result.video.playUrl, undefined);
  }
}

// 動画をダウンロードできれば添付し、メディアギャラリーから attachment:// で参照する
{
  const fetcher = async (url: string): Promise<Response> => url.startsWith("https://www.tikwm.com/")
    ? new Response(JSON.stringify(apiData), { status: 200 })
    : new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "video/mp4" } });
  const [payload] = await buildTikTokReplyPayloads([{ url: "https://www.tiktok.com/@user/video/123" }], {
    fetcher,
    attachmentSizeLimitBytes: 1024,
  });
  assert.ok(payload && "files" in payload);
  assert.equal(payload.flags, MessageFlags.IsComponentsV2);
  assert.equal(payload.files?.length, 1);
  const json = JSON.stringify(payload.components);
  assert.equal(json.includes("attachment://tiktok-preview.mp4"), true);
  assert.equal(json.includes("TikTokで開く"), true);
  assert.equal(json.includes(`"type":${ComponentType.MediaGallery}`), true);
}

// サイズ超過時はカバー画像にフォールバックする
{
  const fetcher = async (url: string): Promise<Response> => url.startsWith("https://www.tikwm.com/")
    ? new Response(JSON.stringify(apiData), { status: 200 })
    : new Response(new Uint8Array(10), { status: 200, headers: { "content-type": "video/mp4", "content-length": "10" } });
  const [payload] = await buildTikTokReplyPayloads([{ url: "https://www.tiktok.com/@user/video/123" }], {
    fetcher,
    attachmentSizeLimitBytes: 5,
  });
  assert.ok(payload && "files" in payload);
  assert.equal(payload.files?.length, 0);
  assert.equal(JSON.stringify(payload.components).includes("https://cdn.example/cover.jpg"), true);
}

// API 失敗時は元URLをそのまま返信する
{
  const [payload] = await buildTikTokReplyPayloads([{ url: "https://vm.tiktok.com/ZMabc/" }], {
    fetcher: async () => new Response("oops", { status: 500 }),
    attachmentSizeLimitBytes: 1024,
  });
  assert.ok(payload && "content" in payload);
  assert.equal(payload.content, "https://vm.tiktok.com/ZMabc/");
}

// 翻訳ゲートの結果を本文へ反映し、保存用の状態には attachment:// を含めない
{
  const fetcher = async (url: string): Promise<Response> => url.startsWith("https://www.tikwm.com/")
    ? new Response(JSON.stringify(apiData), { status: 200 })
    : new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "video/mp4" } });
  let translatedKeys: string[] = [];
  const [payload] = await buildTikTokReplyPayloads([{ url: "https://www.tiktok.com/@user/video/123" }], {
    fetcher,
    attachmentSizeLimitBytes: 1024,
    translate: async (document) => {
      translatedKeys = document.blocks.flatMap((block) => block.type === "text"
        ? block.lines.flatMap((line) => line.parts.flatMap((part) => part.translationKey ? [part.translationKey] : []))
        : []);
      return {
        model: "test-model",
        translations: {
          main: { shouldTranslate: true, sourceLanguage: "en", confidence: 1, translatedText: "こんにちは" },
        },
      };
    },
  });
  assert.deepEqual(translatedKeys, ["main"]);
  assert.ok(payload && "previewState" in payload && payload.previewState);
  const json = JSON.stringify(payload.components);
  assert.equal(json.includes("こんにちは"), true);
  assert.equal(json.includes("preview:show-original"), true);
  assert.equal(json.includes("attachment://tiktok-preview.mp4"), true);
  assert.equal(JSON.stringify(payload.previewState.document).includes("attachment://"), false);
  assert.equal(payload.previewState.document.source, "tiktok");
}

// 翻訳不要なら切り替えボタンも保存状態も作らない
{
  const [payload] = await buildTikTokReplyPayloads([{ url: "https://www.tiktok.com/@user/video/123" }], {
    fetcher: async () => new Response(JSON.stringify(apiData), { status: 200 }),
    attachmentSizeLimitBytes: 0,
    translate: async () => ({ translations: {} }),
  });
  assert.ok(payload && "files" in payload);
  assert.equal("previewState" in payload, false);
  assert.equal(JSON.stringify(payload.components).includes("preview:show-original"), false);
}

// 大量のリンクがあっても上限件数までしか展開せず、構築と返信を1件ずつ行う
{
  const targets = Array.from({ length: 10 }, (_, i) => ({ url: `https://www.tiktok.com/@user/video/${i}`, videoId: String(i) }));
  const events: string[] = [];
  let running = 0;
  let maxRunning = 0;
  await expandTikTokLinks({
    guildId: null,
    channelId: "c",
    reply: async () => { events.push("reply"); return { id: "r" }; },
  } as never, targets, {
    db: {} as never,
    log: { warn: () => undefined },
    attachmentSizeLimitBytes: 1024,
    buildReplyPayloads: async (batch) => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      events.push(`build:${batch.map((t) => t.videoId).join(",")}`);
      await new Promise((resolve) => setTimeout(resolve, 1));
      running -= 1;
      return [{ content: "x" }];
    },
  });
  assert.equal(maxRunning, 1);
  assert.deepEqual(events, Array.from({ length: MAX_TIKTOK_TARGETS_PER_MESSAGE }, (_, i) => [`build:${i}`, "reply"]).flat());
}

{
  const requested: string[] = [];
  const payloads = await buildTikTokReplyPayloads(
    Array.from({ length: 10 }, (_, i) => ({ url: `https://www.tiktok.com/@user/video/${i}` })),
    {
      fetcher: async (url) => { requested.push(url); return new Response("oops", { status: 500 }); },
      attachmentSizeLimitBytes: 0,
    },
  );
  assert.equal(payloads.length, MAX_TIKTOK_TARGETS_PER_MESSAGE);
  assert.equal(requested.length, MAX_TIKTOK_TARGETS_PER_MESSAGE);
}

// 複数メッセージが同時に来ても、構築→返信は共有キューで1件ずつしか走らない
{
  let running = 0;
  let maxRunning = 0;
  const deps = {
    db: {} as never,
    log: { warn: () => undefined },
    attachmentSizeLimitBytes: 1024,
    buildReplyPayloads: async () => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((resolve) => setTimeout(resolve, 2));
      return [{ content: "x" }];
    },
  };
  const message = (id: string) => ({
    id,
    guildId: null,
    channelId: "c",
    reply: async () => { running -= 1; return { id: `r-${id}` }; },
  }) as never;
  const targets = [0, 1, 2].map((i) => ({ url: `https://www.tiktok.com/@user/video/${i}`, videoId: String(i) }));
  await Promise.all(["m1", "m2", "m3", "m4"].map((id) => expandTikTokLinks(message(id), targets, deps)));
  assert.equal(maxRunning, 1);
}

// キューの待ちが上限を超えたら、動画を取得せず元URLだけを返信する
{
  const queue = new LocalLlmQueue({ maxConcurrent: 1, maxQueue: 0 });
  let release!: () => void;
  const blocker = queue.enqueue({ userId: "blocker", run: () => new Promise<void>((resolve) => { release = resolve; }) });
  assert.equal(blocker.ok, true);
  const replies: unknown[] = [];
  let built = 0;
  await expandTikTokLinks({
    id: "m",
    guildId: null,
    channelId: "c",
    reply: async (payload: unknown) => { replies.push(payload); return { id: "r" }; },
  } as never, [{ url: "https://vm.tiktok.com/ZMabc/" }], {
    db: {} as never,
    log: { warn: () => undefined },
    attachmentSizeLimitBytes: 1024,
    queue,
    buildReplyPayloads: async () => { built += 1; return []; },
  });
  release();
  assert.equal(built, 0);
  assert.deepEqual(replies, [{ content: "https://vm.tiktok.com/ZMabc/", allowedMentions: { parse: [], repliedUser: false } }]);
}
