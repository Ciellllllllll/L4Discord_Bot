import assert from "node:assert/strict";
import { ComponentType, MessageFlags } from "discord.js";
import { LocalLlmQueue } from "../../ai/localLlmQueue.js";
import { expandTikTokLinks } from "../tiktok/tiktokLinkExpansion.js";
import {
  buildInstagramReplyPayloads,
  expandInstagramLinks,
  MAX_INSTAGRAM_TARGETS_PER_MESSAGE,
  type InstagramPreviewPayload,
} from "./instagramLinkExpansion.js";
import { parseInstagramUrl } from "./instagramPreviewSource.js";

const target = parseInstagramUrl("https://www.instagram.com/reel/DHVrPLrIyQ_/")!;
const pageHtml = `<html><head>
<meta property="og:title" content="National Geographic on Instagram: &quot;Meet the explorers&quot;" />
<meta property="og:image" content="https://scontent.cdninstagram.com/v/thumb.jpg" />
<meta property="og:url" content="https://www.instagram.com/natgeo/reel/DHVrPLrIyQ_/" />
<meta property="og:description" content="11K likes, 121 comments - natgeo on March 18, 2025: &quot;Meet the explorers&quot;. " />
</head><body></body></html>`;

type CdnItem = { contentType: string; bytes: number; status?: number; contentLength?: boolean };

/** 本体ページ・ミラー・CDN を模した fetcher。`items` の順にミラーが CDN へリダイレクトする */
function fakeFetcher(items: CdnItem[], options: { mirrorDown?: boolean; page?: Response } = {}) {
  const requested: string[] = [];
  const fetcher = async (url: string, _init?: RequestInit): Promise<Response> => {
    requested.push(url);
    if (url.startsWith("https://www.instagram.com/")) return options.page ?? new Response(pageHtml, { status: 200 });
    const mirror = url.match(/^https:\/\/uuinstagram\.com\/images\/[^/]+\/(\d+)$/);
    if (mirror) {
      if (options.mirrorDown) throw new Error("mirror down");
      const index = Number(mirror[1]);
      return index <= items.length
        ? new Response(null, { status: 302, headers: { location: `https://scontent.cdninstagram.com/item/${index}` } })
        : new Response("", { status: 200 });
    }
    const cdn = url.match(/^https:\/\/scontent\.cdninstagram\.com\/item\/(\d+)$/);
    const item = cdn ? items[Number(cdn[1]) - 1] : undefined;
    if (item) {
      return new Response(new Uint8Array(item.bytes), {
        status: item.status ?? 200,
        headers: {
          "content-type": item.contentType,
          ...(item.contentLength === false ? {} : { "content-length": String(item.bytes) }),
        },
      });
    }
    if (url === "https://scontent.cdninstagram.com/v/thumb.jpg") {
      return new Response(new Uint8Array([1, 2]), { status: 200, headers: { "content-type": "image/jpeg" } });
    }
    return new Response("missing", { status: 404 });
  };
  return { fetcher, requested };
}

async function buildOne(
  fetcher: (url: string, init?: RequestInit) => Promise<Response>,
  attachmentSizeLimitBytes = 1024,
): Promise<InstagramPreviewPayload> {
  const [payload] = await buildInstagramReplyPayloads([target], {
    fetcher,
    attachmentSizeLimitBytes,
    translate: async () => ({ translations: {} }),
  });
  assert.ok(payload && "files" in payload);
  return payload as InstagramPreviewPayload;
}

// リールの動画をミラー経由で CDN から取得して添付し、Discord 内で再生できるようにする
{
  const { fetcher, requested } = fakeFetcher([{ contentType: "video/mp4", bytes: 3 }]);
  const payload = await buildOne(fetcher);
  assert.equal(payload.flags, MessageFlags.IsComponentsV2);
  assert.deepEqual(payload.files.map((file) => file.name), ["instagram-video-1.mp4"]);
  const json = JSON.stringify(payload.components);
  assert.equal(json.includes("attachment://instagram-video-1.mp4"), true);
  assert.equal(json.includes("Instagramで開く"), true);
  assert.equal(json.includes(`"type":${ComponentType.MediaGallery}`), true);
  assert.equal(json.includes("thumb.jpg"), false, "動画を添付できたらサムネイルは使わない");
  assert.deepEqual(requested.filter((url) => url.includes("uuinstagram.com")), [
    "https://uuinstagram.com/images/DHVrPLrIyQ_/1",
    "https://uuinstagram.com/images/DHVrPLrIyQ_/2",
  ]);
}

// カルーセルは項目ごとに動画・画像を判定して添付し、取得できなかった項目は表示しない
{
  const { fetcher } = fakeFetcher([
    { contentType: "video/mp4", bytes: 3 },
    { contentType: "image/png", bytes: 2 },
    { contentType: "image/jpeg", bytes: 2, status: 404 },
    { contentType: "image/webp", bytes: 2 },
  ]);
  const payload = await buildOne(fetcher);
  assert.deepEqual(payload.files.map((file) => file.name), [
    "instagram-video-1.mp4",
    "instagram-image-2.png",
    "instagram-image-4.webp",
  ]);
  assert.equal(JSON.stringify(payload.components).includes("cdninstagram.com/item/3"), false);
}

// 添付の合計サイズ上限を超える動画は取得せず、残りの容量で後続の画像を添付する。
// 先頭の項目が取れなかったときは、そのカバー画像（本体の OG 画像）を先頭に表示する
{
  const { fetcher } = fakeFetcher([
    { contentType: "video/mp4", bytes: 50 },
    { contentType: "image/jpeg", bytes: 20 },
    { contentType: "image/jpeg", bytes: 20 },
  ]);
  const payload = await buildOne(fetcher, 30);
  assert.deepEqual(payload.files.map((file) => file.name), ["instagram-image-1.jpg", "instagram-image-2.jpg"]);
  const json = JSON.stringify(payload.components);
  assert.ok(json.indexOf("attachment://instagram-image-1.jpg") < json.indexOf("attachment://instagram-image-2.jpg"));
}

// 先頭が取れない10枚のカルーセルでも、カバー画像の枠を残して添付を Discord の上限10件に収める
{
  const { fetcher } = fakeFetcher([
    { contentType: "video/mp4", bytes: 5_000 },
    ...Array.from({ length: 9 }, () => ({ contentType: "image/png", bytes: 1 })),
  ]);
  const payload = await buildOne(fetcher, 1024);
  assert.equal(payload.files.length, 10);
  assert.equal(payload.files[0]?.name, "instagram-image-1.jpg");
}

// content-length が無くても、上限を超えた時点で読み込みを打ち切る
{
  const { fetcher } = fakeFetcher([{ contentType: "video/mp4", bytes: 50, contentLength: false }]);
  const payload = await buildOne(fetcher, 30);
  assert.deepEqual(payload.files.map((file) => file.name), ["instagram-image-1.jpg"], "サムネイルで表示する");
}

// 動画・画像以外の応答は添付しない
{
  const { fetcher } = fakeFetcher([{ contentType: "text/html", bytes: 5 }]);
  const payload = await buildOne(fetcher);
  assert.deepEqual(payload.files.map((file) => file.name), ["instagram-image-1.jpg"]);
}

// ミラーが使えないときは本体の OG 画像を添付し、それも取れなければ URL のまま表示する
{
  const { fetcher } = fakeFetcher([], { mirrorDown: true });
  const payload = await buildOne(fetcher);
  assert.deepEqual(payload.files.map((file) => file.name), ["instagram-image-1.jpg"]);
  assert.equal(JSON.stringify(payload.components).includes("attachment://instagram-image-1.jpg"), true);

  const failing = async (url: string): Promise<Response> => url.startsWith("https://www.instagram.com/")
    ? new Response(pageHtml, { status: 200 })
    : new Response("down", { status: 503 });
  const fallback = await buildOne(failing);
  assert.equal(fallback.files.length, 0);
  assert.equal(JSON.stringify(fallback.components).includes("https://scontent.cdninstagram.com/v/thumb.jpg"), true);
}

// 添付サイズ上限0（表示切り替え時の再構築）ではミラーにも CDN にもアクセスしない
{
  const { fetcher, requested } = fakeFetcher([{ contentType: "video/mp4", bytes: 3 }]);
  const payload = await buildOne(fetcher, 0);
  assert.equal(payload.files.length, 0);
  assert.deepEqual(requested, ["https://www.instagram.com/reel/DHVrPLrIyQ_/"]);
  assert.equal(JSON.stringify(payload.components).includes("https://scontent.cdninstagram.com/v/thumb.jpg"), true);
}

// 投稿を取得できなければ元URLだけを返信する
{
  const { fetcher } = fakeFetcher([], { page: new Response("rate limited", { status: 429 }) });
  const [payload] = await buildInstagramReplyPayloads([target], { fetcher, attachmentSizeLimitBytes: 1024 });
  assert.deepEqual(payload, {
    content: "https://www.instagram.com/reel/DHVrPLrIyQ_/",
    allowedMentions: { parse: [], repliedUser: false },
  });
}

// 翻訳ゲートの結果をキャプションへ反映し、保存用の状態には attachment:// を含めない。
// 翻訳はメディアの取得より先に行う（動画バッファを抱えたまま翻訳を待たない）
{
  const events: string[] = [];
  const { fetcher: base } = fakeFetcher([{ contentType: "video/mp4", bytes: 3 }]);
  const fetcher = async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.includes("cdninstagram.com/item/")) events.push("download");
    return await base(url, init);
  };
  let translatedKeys: string[] = [];
  const [built] = await buildInstagramReplyPayloads([target], {
    fetcher,
    attachmentSizeLimitBytes: 1024,
    translate: async (document) => {
      events.push("translate");
      translatedKeys = document.blocks.flatMap((block) => block.type === "text"
        ? block.lines.flatMap((line) => line.parts.flatMap((part) => part.translationKey ? [part.translationKey] : []))
        : []);
      return {
        model: "test-model",
        translations: { main: { shouldTranslate: true, sourceLanguage: "en", confidence: 1, translatedText: "探検家たちを紹介" } },
      };
    },
  });
  assert.deepEqual(events, ["translate", "download"]);
  assert.deepEqual(translatedKeys, ["main"]);
  const payload = built as InstagramPreviewPayload;
  assert.ok(payload.previewState);
  const json = JSON.stringify(payload.components);
  assert.equal(json.includes("探検家たちを紹介"), true);
  assert.equal(json.includes("preview:show-original"), true);
  assert.equal(JSON.stringify(payload.previewState.document).includes("attachment://"), false);
  assert.equal(payload.previewState.document.source, "instagram");
}

// 翻訳が失敗しても原文でプレビューする
{
  const { fetcher } = fakeFetcher([]);
  const [built] = await buildInstagramReplyPayloads([target], {
    fetcher,
    attachmentSizeLimitBytes: 0,
    translate: async () => { throw new Error("ai down"); },
  });
  const payload = built as InstagramPreviewPayload;
  assert.equal("previewState" in payload, false);
  assert.equal(JSON.stringify(payload.components).includes("Meet the explorers"), true);
}

// CDN が応答しなくても、メディア取得全体の締め切りで打ち切る
{
  const { fetcher: base } = fakeFetcher(Array.from({ length: 10 }, () => ({ contentType: "image/jpeg", bytes: 1 })));
  let downloads = 0;
  const fetcher = async (url: string, init?: RequestInit): Promise<Response> => {
    if (!url.includes("cdninstagram.com/item/")) return await base(url, init);
    downloads += 1;
    return await new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });
  };
  // AbortSignal.timeout のタイマーはイベントループを保持しないため、テスト中だけ保持用タイマーを置く
  const keepAlive = setTimeout(() => undefined, 5_000);
  const startedAt = Date.now();
  const [built] = await buildInstagramReplyPayloads([target], {
    fetcher,
    attachmentSizeLimitBytes: 1024,
    translate: async () => ({ translations: {} }),
    mediaTotalTimeoutMs: 50,
  });
  const elapsed = Date.now() - startedAt;
  clearTimeout(keepAlive);
  assert.ok(elapsed < 1_000, `締め切りで打ち切る（${elapsed}ms）`);
  assert.equal(downloads, 1, "締め切り後は新たなダウンロードを始めない");
  assert.equal((built as InstagramPreviewPayload).files.length, 0);
}

// 上限件数までを1件ずつ構築→返信し、超えた分は元URLをまとめて返信する
{
  const targets = Array.from({ length: 6 }, (_, i) => parseInstagramUrl(`https://www.instagram.com/p/Code${i}xyz/`)!);
  const events: string[] = [];
  const replies: unknown[] = [];
  await expandInstagramLinks({
    id: "m",
    guildId: null,
    channelId: "c",
    reply: async (payload: unknown) => { events.push("reply"); replies.push(payload); return { id: "r" }; },
  } as never, targets, {
    db: {} as never,
    log: { warn: () => undefined },
    attachmentSizeLimitBytes: 1024,
    queue: new LocalLlmQueue({ maxConcurrent: 1, maxQueue: 10 }),
    buildReplyPayloads: async (batch) => {
      events.push(`build:${batch.map((t) => t.shortcode).join(",")}`);
      return [{ content: "x" }];
    },
  });
  assert.deepEqual(events, [
    ...targets.slice(0, MAX_INSTAGRAM_TARGETS_PER_MESSAGE).flatMap((t) => [`build:${t.shortcode}`, "reply"]),
    "reply",
  ]);
  assert.equal(
    (replies.at(-1) as { content?: string }).content,
    targets.slice(MAX_INSTAGRAM_TARGETS_PER_MESSAGE).map((t) => t.url).join("\n"),
  );
}

// 翻訳が必要な投稿は返信後に状態を保存する
{
  const saved: unknown[] = [];
  await expandInstagramLinks({
    id: "m",
    guildId: "g",
    channelId: "c",
    reply: async () => ({ id: "reply-1" }),
  } as never, [target], {
    db: {} as never,
    log: { warn: () => undefined },
    attachmentSizeLimitBytes: 1024,
    queue: new LocalLlmQueue({ maxConcurrent: 1, maxQueue: 10 }),
    saveState: async (_db, state) => { saved.push(state); },
    buildReplyPayloads: async () => [{
      embeds: [],
      flags: MessageFlags.IsComponentsV2,
      components: [],
      files: [],
      allowedMentions: { parse: [], repliedUser: false },
      previewState: {
        document: { version: 1, source: "instagram", url: target.url, openLabel: "Instagramで開く", blocks: [] },
        translations: { translations: {} },
      },
    }],
  });
  assert.equal(saved.length, 1);
  assert.deepEqual(
    (saved[0] as { messageId: string; guildId: string; sourceUrl: string }),
    {
      version: 1,
      messageId: "reply-1",
      guildId: "g",
      channelId: "c",
      sourceUrl: target.url,
      document: { version: 1, source: "instagram", url: target.url, openLabel: "Instagramで開く", blocks: [] },
      translations: { translations: {} },
    },
  );
}

// TikTok と Instagram の構築は同じ共有キューで1件ずつしか走らない（動画バッファを同時に抱えない）
{
  let running = 0;
  let maxRunning = 0;
  let builds = 0;
  const slowBuild = async () => {
    builds += 1;
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    await new Promise((resolve) => setTimeout(resolve, 2));
    return [{ content: "x" }];
  };
  const message = (id: string) => ({
    id,
    guildId: null,
    channelId: "c",
    reply: async () => { running -= 1; return { id: `r-${id}` }; },
  }) as never;
  const base = { db: {} as never, log: { warn: () => undefined }, attachmentSizeLimitBytes: 1024 };
  await Promise.all([
    expandInstagramLinks(message("m1"), [target], { ...base, buildReplyPayloads: slowBuild }),
    expandTikTokLinks(message("m1"), [{ url: "https://vm.tiktok.com/ZMabc/" }], { ...base, buildReplyPayloads: slowBuild }),
    expandInstagramLinks(message("m2"), [target], { ...base, buildReplyPayloads: slowBuild }),
  ]);
  assert.equal(maxRunning, 1);
  assert.equal(builds, 3, "同じメッセージの TikTok と Instagram が重複扱いで弾かれない");
}
