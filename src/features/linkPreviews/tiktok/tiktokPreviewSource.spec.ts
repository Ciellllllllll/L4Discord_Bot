import assert from "node:assert/strict";
import { ComponentType, MessageFlags } from "discord.js";
import { LocalLlmQueue } from "../../ai/localLlmQueue.js";
import {
  buildTikTokReplyPayloads,
  chunkUrlsForMessages,
  expandTikTokLinks,
  MAX_TIKTOK_TARGETS_PER_MESSAGE,
  type TikTokPreviewPayload,
} from "./tiktokLinkExpansion.js";
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

// 大量のリンクがあっても上限件数までしか展開せず、構築と返信を1件ずつ行う。
// 上限を超えた分は元URLをまとめて返信する（元メッセージの埋め込みは非表示になるため）
{
  const targets = Array.from({ length: 10 }, (_, i) => ({ url: `https://www.tiktok.com/@user/video/${i}`, videoId: String(i) }));
  const events: string[] = [];
  const replies: unknown[] = [];
  let running = 0;
  let maxRunning = 0;
  await expandTikTokLinks({
    guildId: null,
    channelId: "c",
    reply: async (payload: unknown) => { events.push("reply"); replies.push(payload); return { id: "r" }; },
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
  assert.deepEqual(events, [
    ...Array.from({ length: MAX_TIKTOK_TARGETS_PER_MESSAGE }, (_, i) => [`build:${i}`, "reply"]).flat(),
    "reply",
  ]);
  assert.equal(
    (replies.at(-1) as { content?: string }).content,
    targets.slice(MAX_TIKTOK_TARGETS_PER_MESSAGE).map((target) => target.url).join("\n"),
  );
}

// URLの分割：各チャンクは上限以内、順序と件数を保つ
{
  assert.deepEqual(chunkUrlsForMessages([], 10), []);
  assert.deepEqual(chunkUrlsForMessages(["aaaa", "bbbb", "cccc"], 9), [["aaaa", "bbbb"], ["cccc"]]);
  assert.deepEqual(chunkUrlsForMessages(["aaaa", "x".repeat(11), "bbbb"], 10), [["aaaa", "bbbb"]]);
}

// 上限超過分が大量でも、1通あたり2,000文字以内に分けて全URLを返信する
{
  const targets = Array.from({ length: 200 }, (_, i) => ({ url: `https://vm.tiktok.com/ZM${String(i).padStart(6, "0")}/` }));
  const replies: string[] = [];
  await expandTikTokLinks({
    id: "overflow",
    guildId: null,
    channelId: "c",
    reply: async (payload: { content?: string }) => { replies.push(payload.content ?? ""); return { id: "r" }; },
  } as never, targets, {
    db: {} as never,
    log: { warn: () => undefined },
    attachmentSizeLimitBytes: 1024,
    queue: new LocalLlmQueue({ maxConcurrent: 1, maxQueue: 10 }),
    buildReplyPayloads: async () => [{ content: "preview" }],
  });
  const overflowReplies = replies.slice(MAX_TIKTOK_TARGETS_PER_MESSAGE);
  assert.ok(overflowReplies.length > 1);
  assert.ok(overflowReplies.every((content) => content.length <= 2_000));
  assert.deepEqual(
    overflowReplies.flatMap((content) => content.split("\n")),
    targets.slice(MAX_TIKTOK_TARGETS_PER_MESSAGE).map((target) => target.url),
  );
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

// 写真投稿の画像とアイコンは失効する CDN URL ではなく添付ファイルで表示する。
// 取得できなかった画像だけ元URLのまま残し、保存用の状態には attachment:// を含めない
{
  const requested: string[] = [];
  const fetcher = async (url: string): Promise<Response> => {
    requested.push(url);
    if (url.startsWith("https://www.tikwm.com/")) {
      return new Response(JSON.stringify({
        code: 0,
        data: {
          ...apiData.data,
          author: { ...apiData.data.author, avatar: "https://cdn.example/avatar.webp" },
          images: ["https://cdn.example/1.png", "https://cdn.example/2.jpg"],
        },
      }), { status: 200 });
    }
    if (url.endsWith("2.jpg")) return new Response("missing", { status: 404 });
    const contentType = url.endsWith(".png") ? "image/png" : "image/webp";
    return new Response(new Uint8Array([1, 2]), { status: 200, headers: { "content-type": contentType } });
  };
  const [built] = await buildTikTokReplyPayloads([{ url: "https://www.tiktok.com/@user/photo/123" }], {
    fetcher,
    attachmentSizeLimitBytes: 1024,
    translate: async () => ({
      model: "test-model",
      translations: { main: { shouldTranslate: true, sourceLanguage: "en", confidence: 1, translatedText: "やあ" } },
    }),
  });
  assert.ok(built && "previewState" in built);
  const payload = built as TikTokPreviewPayload;
  assert.ok(payload.previewState);
  assert.deepEqual(payload.files.map((file) => file.name), ["tiktok-image-1.png", "tiktok-avatar.webp"]);
  assert.equal(requested.includes("https://cdn.example/video.mp4"), false, "写真投稿では動画を取得しない");
  const json = JSON.stringify(payload.components);
  assert.equal(json.includes("attachment://tiktok-image-1.png"), true);
  assert.equal(json.includes("https://cdn.example/2.jpg"), true);
  assert.equal(json.includes("attachment://tiktok-avatar.webp"), true);
  assert.equal(JSON.stringify(payload.previewState.document).includes("attachment://"), false);
}

// 写真10枚＋アイコンでも添付は Discord の上限10件に収め、溢れたアイコンは元URLで表示する
{
  const images = Array.from({ length: 10 }, (_, i) => `https://cdn.example/${i}.png`);
  const fetcher = async (url: string): Promise<Response> => url.startsWith("https://www.tikwm.com/")
    ? new Response(JSON.stringify({
      code: 0,
      data: { ...apiData.data, author: { ...apiData.data.author, avatar: "https://cdn.example/avatar.png" }, images },
    }), { status: 200 })
    : new Response(new Uint8Array([1]), { status: 200, headers: { "content-type": "image/png" } });
  const [built] = await buildTikTokReplyPayloads([{ url: "https://www.tiktok.com/@user/photo/123" }], {
    fetcher,
    attachmentSizeLimitBytes: 1024,
    translate: async () => ({ translations: {} }),
  });
  const payload = built as TikTokPreviewPayload;
  assert.equal(payload.files.length, 10);
  assert.equal(JSON.stringify(payload.components).includes("https://cdn.example/avatar.png"), true);
}

// 翻訳はメディアのダウンロードより先に行う（動画バッファを抱えたまま翻訳を待たない）
{
  const events: string[] = [];
  const fetcher = async (url: string): Promise<Response> => {
    if (url.startsWith("https://www.tikwm.com/")) return new Response(JSON.stringify(apiData), { status: 200 });
    events.push(`download:${url}`);
    return new Response(new Uint8Array([1]), { status: 200, headers: { "content-type": "video/mp4" } });
  };
  await buildTikTokReplyPayloads([{ url: "https://www.tiktok.com/@user/video/123" }], {
    fetcher,
    attachmentSizeLimitBytes: 1024,
    translate: async () => { events.push("translate"); return { translations: {} }; },
  });
  assert.deepEqual(events, ["translate", "download:https://cdn.example/video.mp4"]);
}
