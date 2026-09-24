import assert from "node:assert/strict";
import {
  collectInstagramReplyTargets,
  extractInstagramOgMeta,
  fetchInstagramPreview,
  instagramPreviewToDocument,
  normalizeInstagramOgMeta,
  parseInstagramUrl,
  resolveInstagramMirrorMedia,
} from "./instagramPreviewSource.js";

// 投稿URLの各形式を正規化し、クエリや末尾の句読点を除く
assert.deepEqual(parseInstagramUrl("https://www.instagram.com/p/BsOGulcndj-/?igsh=abc"), {
  url: "https://www.instagram.com/p/BsOGulcndj-/",
  shortcode: "BsOGulcndj-",
  kind: "p",
});
assert.deepEqual(parseInstagramUrl("instagram.com/reel/DHVrPLrIyQ_。"), {
  url: "https://www.instagram.com/reel/DHVrPLrIyQ_/",
  shortcode: "DHVrPLrIyQ_",
  kind: "reel",
});
assert.equal(parseInstagramUrl("https://www.instagram.com/reels/DHVrPLrIyQ_/")?.kind, "reel");
assert.equal(parseInstagramUrl("https://m.instagram.com/tv/CabcdEFG/")?.kind, "tv");
assert.equal(parseInstagramUrl("https://instagr.am/p/CabcdEFG")?.shortcode, "CabcdEFG");
assert.equal(parseInstagramUrl("https://www.instagram.com/natgeo/reel/DHVrPLrIyQ_/")?.shortcode, "DHVrPLrIyQ_");
// プロフィール・ストーリー・他ドメインは対象外
assert.equal(parseInstagramUrl("https://www.instagram.com/natgeo/"), null);
assert.equal(parseInstagramUrl("https://www.instagram.com/stories/natgeo/123/"), null);
assert.equal(parseInstagramUrl("https://www.instagram.com/p/"), null);
assert.equal(parseInstagramUrl("https://example.com/p/BsOGulcndj-/"), null);
assert.equal(parseInstagramUrl("https://notinstagram.com/p/BsOGulcndj-/"), null);
assert.equal(collectInstagramReplyTargets([
  "https://www.instagram.com/p/BsOGulcndj-/",
  "https://instagram.com/world_record_egg/p/BsOGulcndj-/?img_index=1",
  "https://www.instagram.com/reel/DHVrPLrIyQ_/",
]).length, 2);

const eggTarget = parseInstagramUrl("https://www.instagram.com/p/BsOGulcndj-/")!;
const eggHtml = `<!DOCTYPE html><html><head>
<meta property="og:title" content="Just An Egg &#x1f95a; on Instagram: &quot;Let&#x2019;s set a world record - together #LikeTheEgg&quot;" />
<meta property="og:image" content="https://scontent-nrt1-2.cdninstagram.com/v/egg.jpg?a=1&amp;b=2" />
<meta property="og:url" content="https://www.instagram.com/world_record_egg/p/BsOGulcndj-/" />
<meta property="og:description" content="60M likes, 4,160 comments - world_record_egg on January 4, 2019: &quot;Let&#x2019;s set a world record - together #LikeTheEgg&quot;. " />
</head><body>${"x".repeat(1_000)}</body></html>`;

// OG メタから投稿者・キャプション・日付・いいね数・画像を取り出す（HTMLエンティティはデコードする）
{
  const result = normalizeInstagramOgMeta(extractInstagramOgMeta(eggHtml), eggTarget);
  assert.deepEqual(result, {
    status: "ok",
    post: {
      shortcode: "BsOGulcndj-",
      url: "https://www.instagram.com/p/BsOGulcndj-/",
      username: "world_record_egg",
      displayName: "Just An Egg 🥚",
      caption: "Let’s set a world record - together #LikeTheEgg",
      date: "2019/01/04",
      likes: "60M",
      comments: "4,160",
      imageUrl: "https://scontent-nrt1-2.cdninstagram.com/v/egg.jpg?a=1&b=2",
    },
  });
}

// キャプションなし・いいね数非表示・og:url にユーザー名がない投稿
{
  const result = normalizeInstagramOgMeta({
    "og:url": "https://www.instagram.com/p/BsOGulcndj-/",
    "og:title": "someone on Instagram",
    "og:description": "someone on March 18, 2025",
    "og:image": "http://insecure.example/image.jpg",
  }, eggTarget);
  assert.equal(result.status, "ok");
  if (result.status === "ok") {
    assert.equal(result.post.username, "someone");
    assert.equal(result.post.displayName, undefined);
    assert.equal(result.post.caption, "");
    assert.equal(result.post.date, "2025/03/18");
    assert.equal(result.post.likes, undefined);
    assert.equal(result.post.imageUrl, undefined, "https 以外の画像は使わない");
  }
}

// ログイン画面・別の投稿の OG は使わない
assert.deepEqual(normalizeInstagramOgMeta({ "og:url": "https://www.instagram.com/accounts/login/" }, eggTarget), {
  status: "fallback",
  reason: "post_unavailable",
});
assert.equal(normalizeInstagramOgMeta({ "og:url": "https://www.instagram.com/p/OtherCode1/" }, eggTarget).status, "fallback");
assert.equal(normalizeInstagramOgMeta({}, eggTarget).status, "fallback");

// クローラーとして取得し、head の終わりで読み込みをやめる
{
  let init: RequestInit | undefined;
  let pulled = 0;
  const encoder = new TextEncoder();
  const chunks = [eggHtml.slice(0, 200), eggHtml.slice(200), ...Array.from({ length: 50 }, () => "y".repeat(64 * 1024))];
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[pulled];
      pulled += 1;
      if (chunk === undefined) controller.close();
      else controller.enqueue(encoder.encode(chunk));
    },
  }, { highWaterMark: 0 });
  const result = await fetchInstagramPreview(eggTarget, async (_url, requestInit) => {
    init = requestInit;
    return new Response(body, { status: 200 });
  });
  assert.equal(result.status, "ok");
  assert.equal((init?.headers as Record<string, string>)["User-Agent"], "facebookexternalhit/1.1");
  assert.ok(pulled <= 3, `head の後は読まない（${pulled}）`);
}

// head が終わらない巨大な応答やエラー応答は読み切らずにフォールバックする
{
  let pulled = 0;
  const huge = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += 1;
      if (pulled > 64) controller.close();
      else controller.enqueue(new Uint8Array(64 * 1024).fill(0x61));
    },
  });
  const result = await fetchInstagramPreview(eggTarget, async () => new Response(huge, { status: 200 }));
  assert.equal(result.status, "fallback");
  assert.ok(pulled < 64, "上限を超えた時点で読み込みを打ち切る");

  let errorBodyRead = false;
  const errorBody = new ReadableStream<Uint8Array>({ pull() { errorBodyRead = true; } }, { highWaterMark: 0 });
  assert.deepEqual(
    await fetchInstagramPreview(eggTarget, async () => new Response(errorBody, { status: 429 })),
    { status: "fallback", reason: "http_429" },
  );
  assert.equal(errorBodyRead, false);
  assert.equal((await fetchInstagramPreview(eggTarget, async () => { throw new TypeError("network"); })).status, "fallback");
}

// ミラーのリダイレクトは自動で追わず、行き先が Instagram の CDN のときだけ採用する
{
  const deadline = new AbortController().signal;
  const redirect = (location: string, status = 302) => async (_url: string, init?: RequestInit) => {
    assert.equal(init?.redirect, "manual");
    return new Response(null, { status, headers: { location } });
  };
  assert.equal(
    await resolveInstagramMirrorMedia("BsOGulcndj-", 1, deadline, redirect("https://scontent.cdninstagram.com/v/a.jpg")),
    "https://scontent.cdninstagram.com/v/a.jpg",
  );
  assert.equal(
    await resolveInstagramMirrorMedia("BsOGulcndj-", 1, deadline, redirect("https://instagram.fiev25-1.fna.fbcdn.net/v/a.mp4", 307)),
    "https://instagram.fiev25-1.fna.fbcdn.net/v/a.mp4",
  );
  assert.equal(await resolveInstagramMirrorMedia("BsOGulcndj-", 1, deadline, redirect("https://ads.example/landing")), undefined);
  assert.equal(await resolveInstagramMirrorMedia("BsOGulcndj-", 1, deadline, redirect("http://scontent.cdninstagram.com/a.jpg")), undefined);
  assert.equal(await resolveInstagramMirrorMedia("BsOGulcndj-", 1, deadline, redirect("https://cdninstagram.com.evil.example/a.jpg")), undefined);
  // 存在しない番号は 200・空本文
  assert.equal(await resolveInstagramMirrorMedia("BsOGulcndj-", 5, deadline, async () => new Response("", { status: 200 })), undefined);
  assert.equal(await resolveInstagramMirrorMedia("BsOGulcndj-", 1, deadline, async () => { throw new Error("down"); }), undefined);
  let called = false;
  const aborted = AbortSignal.abort();
  assert.equal(await resolveInstagramMirrorMedia("BsOGulcndj-", 1, aborted, async () => { called = true; return new Response(null); }), undefined);
  assert.equal(called, false, "締め切り後はミラーにアクセスしない");
}

// 文書: キャプションだけを翻訳対象にし、メタ行に日付といいね数を出す
{
  const result = normalizeInstagramOgMeta(extractInstagramOgMeta(eggHtml), eggTarget);
  assert.equal(result.status, "ok");
  if (result.status === "ok") {
    const document = instagramPreviewToDocument(result.post);
    assert.equal(document.source, "instagram");
    assert.equal(document.openLabel, "Instagramで開く");
    const json = JSON.stringify(document);
    assert.equal(json.includes("Just An Egg 🥚 (@world_record_egg)"), true);
    assert.equal(json.includes("\"translationKey\":\"main\""), true);
    assert.equal(json.includes("2019/01/04 / ❤️ 60M / 💬 4,160"), true);
    assert.equal(json.includes("https://scontent-nrt1-2.cdninstagram.com/v/egg.jpg?a=1&b=2"), true);
    const attached = JSON.stringify(instagramPreviewToDocument(result.post, { mediaUrls: ["attachment://instagram-video-1.mp4"] }));
    assert.equal(attached.includes("attachment://instagram-video-1.mp4"), true);
    assert.equal(attached.includes("egg.jpg"), false);
  }
}
