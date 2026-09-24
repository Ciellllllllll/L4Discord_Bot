import assert from "node:assert/strict";
import test from "node:test";
import type { YouTubeFeedEntry } from "./youtubeRss.js";
import {
  fallbackEntriesSinceLastNotified,
  normalizeYouTubeChannelVideos,
  parseRelativePublishedText,
  resolveYouTubeWatcherEntries,
  type FallbackCache,
  type YouTubeChannelVideo,
} from "./youtubeWatcherFallback.js";

const NOW = Date.parse("2026-09-24T07:00:00.000Z");
const HOUR = 60 * 60 * 1000;

function video(videoId: string, publishedText?: string): YouTubeChannelVideo {
  return {
    videoId,
    title: `title ${videoId}`,
    ...(publishedText ? { publishedText } : {}),
    thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hq720.jpg`,
  };
}

function feedEntry(videoId: string, publishedAt: string): YouTubeFeedEntry {
  return {
    videoId,
    title: videoId,
    channelTitle: "channel",
    publishedAt,
    videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
    thumbnailUrl: null,
  };
}

test("parseRelativePublishedText understands YouTube's relative publish times", () => {
  assert.equal(parseRelativePublishedText("4 hours ago", NOW), NOW - 4 * HOUR);
  assert.equal(parseRelativePublishedText("1 day ago", NOW), NOW - 24 * HOUR);
  assert.equal(parseRelativePublishedText("Streamed 30 minutes ago", NOW), NOW - 30 * 60 * 1000);
  assert.equal(parseRelativePublishedText("Premiered 2 weeks ago", NOW), NOW - 14 * 24 * HOUR);
  assert.equal(parseRelativePublishedText("45 seconds ago", NOW), NOW - 45 * 1000);
  assert.equal(parseRelativePublishedText("Scheduled for 9/30/26, 8:00 PM", NOW), undefined);
  assert.equal(parseRelativePublishedText("", NOW), undefined);
});

test("fallback only treats videos newer than the latest notified one as new", () => {
  const videos = [video("new2", "1 hour ago"), video("new1", "5 hours ago"), video("sent1", "1 day ago"), video("old", "2 years ago")];
  const entries = fallbackEntriesSinceLastNotified(videos, "channel", new Set(["sent1"]), NOW);
  // 古い順（通知する順）に並べ、チャンネル名や URL を RSS と同じ形で埋める
  assert.deepEqual(entries.map((entry) => entry.videoId), ["new1", "new2"]);
  assert.deepEqual(entries[1], {
    videoId: "new2",
    title: "title new2",
    channelTitle: "channel",
    publishedAt: new Date(NOW - HOUR).toISOString(),
    videoUrl: "https://www.youtube.com/watch?v=new2",
    thumbnailUrl: "https://i.ytimg.com/vi/new2/hq720.jpg",
  });
});

test("fallback posts nothing when no notified video appears in the list", () => {
  // 通知済みの動画が一覧に無いと、どこからが新着か分からない。古い動画を大量に通知しないよう何もしない
  const videos = [video("a", "1 hour ago"), video("b", "1 day ago")];
  assert.deepEqual(fallbackEntriesSinceLastNotified(videos, "channel", new Set(["elsewhere"]), NOW), []);
  assert.deepEqual(fallbackEntriesSinceLastNotified(videos, "channel", new Set(), NOW), []);
});

test("fallback keeps the list order even when publish times are coarse or unknown", () => {
  const videos = [video("c", "1 day ago"), video("b"), video("a", "1 day ago"), video("sent", "2 days ago")];
  const entries = fallbackEntriesSinceLastNotified(videos, "channel", new Set(["sent"]), NOW);
  assert.deepEqual(entries.map((entry) => entry.videoId), ["a", "b", "c"]);
  const times = entries.map((entry) => Date.parse(entry.publishedAt));
  assert.ok(times[0]! < times[1]! && times[1]! < times[2]!, "新しい順の一覧の並びを保つ");
});

test("fallback caps how many videos one scan can post", () => {
  const videos = [...Array.from({ length: 20 }, (_, i) => video(`new${i}`, `${i + 1} hours ago`)), video("sent", "3 days ago")];
  const entries = fallbackEntriesSinceLastNotified(videos, "channel", new Set(["sent"]), NOW);
  // 起点（通知済み）に近い古い方から通知する。次回のスキャンでは通知済みが増えて起点が進み、残りを順に拾う
  assert.deepEqual(entries.map((entry) => entry.videoId), Array.from({ length: 10 }, (_, i) => `new${19 - i}`));
});

test("normalizeYouTubeChannelVideos reads lockup and legacy video nodes", () => {
  const text = (value: string) => ({ toString: () => value });
  const videos = normalizeYouTubeChannelVideos([
    {
      type: "LockupView",
      content_type: "VIDEO",
      content_id: "lockup1",
      metadata: {
        title: text("Lockup title"),
        metadata: { metadata_rows: [{ metadata_parts: [{ text: text("452 views") }, { text: text("22 hours ago") }] }] },
      },
      content_image: { image: [{ url: "https://i.ytimg.com/vi/lockup1/hq720.jpg" }] },
    },
    { type: "LockupView", content_type: "PLAYLIST", content_id: "PL123", metadata: { title: text("playlist") } },
    { type: "Video", id: "legacy1", title: text("Legacy title"), published: text("3 days ago"), thumbnails: [{ url: "http://insecure/thumb.jpg" }] },
    { type: "Video", title: text("no id") },
  ]);
  assert.deepEqual(videos, [
    { videoId: "lockup1", title: "Lockup title", publishedText: "22 hours ago", thumbnailUrl: "https://i.ytimg.com/vi/lockup1/hq720.jpg" },
    { videoId: "legacy1", title: "Legacy title", publishedText: "3 days ago" },
  ]);
});

test("resolveYouTubeWatcherEntries prefers RSS and does not call the fallback when RSS works", async () => {
  let fallbackCalls = 0;
  const result = await resolveYouTubeWatcherEntries("UCabc", new Set(["v1"]), {
    fetchFeed: async () => ({ ok: true, entries: [feedEntry("v2", "2026-09-24T02:00:00.000Z"), feedEntry("v1", "2026-09-23T00:00:00.000Z")] }),
    fetchFallback: async () => { fallbackCalls += 1; return { ok: false, error: "unused" }; },
    now: NOW,
  });
  assert.equal(fallbackCalls, 0);
  assert.deepEqual(result.ok ? result.entries.map((entry) => entry.videoId) : result, ["v2"]);
  assert.equal(result.ok ? result.notice : undefined, undefined);
});

test("resolveYouTubeWatcherEntries falls back only when RSS fails and records why", async () => {
  const result = await resolveYouTubeWatcherEntries("UCabc", new Set(["sent"]), {
    fallbackCache: new Map(),
    fetchFeed: async () => ({ ok: false, error: "RSSの取得に失敗しました。(HTTP 404)" }),
    fetchFallback: async () => ({ ok: true, channelTitle: "channel", videos: [video("new", "2 hours ago"), video("sent", "1 day ago")] }),
    now: NOW,
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.entries.map((entry) => entry.videoId), ["new"]);
    assert.equal(result.notice, "RSSの取得に失敗しました。(HTTP 404)（代替手段で確認中）");
    assert.equal(result.usedFallback, true);
  }

  const bothFailed = await resolveYouTubeWatcherEntries("UCabc", new Set(), {
    fallbackCache: new Map(),
    fetchFeed: async () => ({ ok: false, error: "RSSの取得に失敗しました。(HTTP 404)" }),
    fetchFallback: async () => ({ ok: false, error: "代替手段での取得に失敗しました。" }),
    now: NOW,
  });
  assert.deepEqual(bothFailed, { ok: false, error: "RSSの取得に失敗しました。(HTTP 404) / 代替手段での取得に失敗しました。" });
});

test("resolveYouTubeWatcherEntries fetches the fallback at most once per interval for each channel", async () => {
  const throttle: FallbackCache = new Map();
  let fallbackCalls = 0;
  const deps = (now: number) => ({
    fetchFeed: async () => ({ ok: false as const, error: "RSSの取得に失敗しました。(HTTP 404)" }),
    fetchFallback: async () => {
      fallbackCalls += 1;
      return { ok: true as const, channelTitle: "channel", videos: [video("new", "1 hour ago"), video("sent", "1 day ago")] };
    },
    fallbackCache: throttle,
    now,
  });
  const first = await resolveYouTubeWatcherEntries("UCabc", new Set(["sent"]), deps(NOW));
  assert.deepEqual(first.ok ? first.entries.map((entry) => entry.videoId) : first, ["new"]);

  // 間隔内は YouTube にアクセスせず、前回取得した一覧を使う（ログ用に今回は取得していないと分かるようにする）
  const cached = await resolveYouTubeWatcherEntries("UCabc", new Set(["sent", "new"]), deps(NOW + 60_000));
  assert.deepEqual(cached, {
    ok: true,
    entries: [],
    notice: "RSSの取得に失敗しました。(HTTP 404)（代替手段で確認中）",
    usedFallback: false,
  });
  assert.equal(fallbackCalls, 1);

  // 別のチャンネルは独立して使える
  await resolveYouTubeWatcherEntries("UCother", new Set(["sent"]), deps(NOW + 60_000));
  assert.equal(fallbackCalls, 2);

  // 間隔が過ぎれば再び使う
  await resolveYouTubeWatcherEntries("UCabc", new Set(["sent"]), deps(NOW + 5 * 60_000));
  assert.equal(fallbackCalls, 3);
});

test("a failed fallback keeps reporting its error until it is retried on the next interval", async () => {
  const throttle: FallbackCache = new Map();
  let fallbackCalls = 0;
  const deps = (now: number) => ({
    fetchFeed: async () => ({ ok: false as const, error: "RSSの取得に失敗しました。(HTTP 404)" }),
    fetchFallback: async () => { fallbackCalls += 1; return { ok: false as const, error: "代替手段での取得に失敗しました。" }; },
    fallbackCache: throttle,
    now,
  });
  const error = "RSSの取得に失敗しました。(HTTP 404) / 代替手段での取得に失敗しました。";
  assert.deepEqual(await resolveYouTubeWatcherEntries("UCabc", new Set(), deps(NOW)), { ok: false, error });
  // 間隔内は再試行しないが、「確認中」で上書きせず前回の失敗を報告し続ける
  assert.deepEqual(await resolveYouTubeWatcherEntries("UCabc", new Set(), deps(NOW + 60_000)), { ok: false, error });
  assert.equal(fallbackCalls, 1);
});

test("the same YouTube channel registered to several Discord channels shares one fallback fetch", async () => {
  // 登録ごとに通知済みの履歴が違うので、同じ一覧からそれぞれの新着を判定する
  const cache: FallbackCache = new Map();
  let fallbackCalls = 0;
  const deps = {
    fetchFeed: async () => ({ ok: false as const, error: "RSSの取得に失敗しました。(HTTP 404)" }),
    fetchFallback: async () => {
      fallbackCalls += 1;
      return { ok: true as const, channelTitle: "channel", videos: [video("new2", "1 hour ago"), video("new1", "3 hours ago"), video("old", "1 day ago")] };
    },
    fallbackCache: cache,
    now: NOW,
  };
  const first = await resolveYouTubeWatcherEntries("UCabc", new Set(["old"]), deps);
  const second = await resolveYouTubeWatcherEntries("UCabc", new Set(["new1"]), deps);
  assert.equal(fallbackCalls, 1);
  assert.deepEqual(first.ok ? first.entries.map((entry) => entry.videoId) : first, ["new1", "new2"]);
  assert.deepEqual(second.ok ? second.entries.map((entry) => entry.videoId) : second, ["new2"]);
  // 同じ一覧から作るので、近似の投稿日時も登録間でそろう
  assert.equal(first.ok && second.ok ? first.entries[1]?.publishedAt === second.entries[0]?.publishedAt : false, true);
});

test("RSS recovering resets the fallback interval for the next outage", async () => {
  const throttle: FallbackCache = new Map([["UCabc", { fetchedAt: NOW, result: { ok: false, error: "x" } }]]);
  await resolveYouTubeWatcherEntries("UCabc", new Set(), {
    fetchFeed: async () => ({ ok: true, entries: [] }),
    fetchFallback: async () => ({ ok: false, error: "unused" }),
    fallbackCache: throttle,
    now: NOW + 60_000,
  });
  assert.equal(throttle.has("UCabc"), false);
});

test("a fallback video that failed to post is retried even after a newer one was notified", async () => {
  // 古い方の通知が失敗して新しい方が成功すると、新しい方が起点になる。失敗した古い方も再試行の対象に残す
  const videos = [video("newer", "1 hour ago"), video("failedOlder", "2 hours ago"), video("sent", "1 day ago"), video("old", "2 years ago")];
  const entries = fallbackEntriesSinceLastNotified(videos, "channel", new Set(["newer", "sent"]), NOW, new Set(["failedOlder"]));
  assert.deepEqual(entries.map((entry) => entry.videoId), ["failedOlder"]);

  // 起点より新しい未通知の動画と一緒に、古い順で返す
  const withNew = fallbackEntriesSinceLastNotified(
    [video("brandNew", "10 minutes ago"), ...videos],
    "channel",
    new Set(["newer", "sent"]),
    NOW,
    new Set(["failedOlder"]),
  );
  assert.deepEqual(withNew.map((entry) => entry.videoId), ["failedOlder", "brandNew"]);

  // 通知済みの動画が一覧に無くても、一度試みて失敗した動画は再試行する（それ以外は古い動画かもしれないので通知しない）
  const noAnchor = fallbackEntriesSinceLastNotified([video("x", "1 hour ago"), video("failed", "2 hours ago")], "channel", new Set(), NOW, new Set(["failed"]));
  assert.deepEqual(noAnchor.map((entry) => entry.videoId), ["failed"]);

  const resolved = await resolveYouTubeWatcherEntries("UCabc", new Set(["newer", "sent"]), {
    fetchFeed: async () => ({ ok: false as const, error: "RSSの取得に失敗しました。(HTTP 404)" }),
    fetchFallback: async () => ({ ok: true as const, channelTitle: "channel", videos }),
    fallbackCache: new Map(),
    failedVideoIds: new Set(["failedOlder"]),
    now: NOW,
  });
  assert.deepEqual(resolved.ok ? resolved.entries.map((entry) => entry.videoId) : resolved, ["failedOlder"]);
});
