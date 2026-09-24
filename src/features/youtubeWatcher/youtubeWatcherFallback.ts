import { Innertube } from "youtubei.js";
import { toUnnotifiedEntries } from "./youtubeWatcher.repository.js";
import type { YouTubeFeedEntry } from "./youtubeRss.js";

/**
 * RSS が取れないときの代替手段（フォールバック）。YouTube の Web クライアント（youtubei.js）で
 * チャンネルの「動画」タブの一覧を取得する。投稿日時は「4 hours ago」のような大まかな表記しか無く、
 * ショート動画も含まれないため、あくまで RSS が復旧するまでのつなぎとして使う。
 */

/** 1回のスキャンで代替手段から通知する上限。残りは次回のスキャンか RSS の復旧後に拾う */
const MAX_FALLBACK_ENTRIES_PER_SCAN = 10;
/**
 * 同じチャンネルに代替手段で取得しに行く最短の間隔。RSS の障害中は毎分スキャンが走るが、YouTube に頻繁にアクセスして
 * 制限されると、同じ IP から行う動画ファイルの取得まで巻き込むため間引く（障害中の通知は最大この分だけ遅れる）。
 * 間隔内は前回取得した一覧を使い回す（同じチャンネルを複数の Discord チャンネルに登録していても、すべての登録で使う）
 */
const FALLBACK_MIN_INTERVAL_MS = 5 * 60 * 1000;
/** チャンネルごとに、代替手段で最後に取得した時刻とその結果 */
export type FallbackCache = Map<string, { fetchedAt: number; result: YouTubeChannelVideosResult }>;
const fallbackResults: FallbackCache = new Map();
/** 使い回すクライアントを作り直す間隔（訪問者情報の期限切れに備える） */
const CLIENT_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const UNIT_MS: Readonly<Record<string, number>> = {
  second: 1_000,
  minute: 60 * 1_000,
  hour: 60 * 60 * 1_000,
  day: 24 * 60 * 60 * 1_000,
  week: 7 * 24 * 60 * 60 * 1_000,
  month: 30 * 24 * 60 * 60 * 1_000,
  year: 365 * 24 * 60 * 60 * 1_000,
};

export type YouTubeChannelVideo = {
  videoId: string;
  title: string;
  /** "4 hours ago" などの投稿時期の表記 */
  publishedText?: string;
  thumbnailUrl?: string;
};

export type YouTubeChannelVideosResult =
  | { ok: true; channelTitle: string; videos: YouTubeChannelVideo[] }
  | { ok: false; error: string };

export type YouTubeFeedResult = { ok: true; entries: YouTubeFeedEntry[] } | { ok: false; error: string };

/** "4 hours ago"・"Streamed 2 days ago" などを、おおよその投稿時刻（ミリ秒）にする。解釈できなければ undefined。 */
export function parseRelativePublishedText(text: string, now: number): number | undefined {
  const match = /(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/i.exec(text);
  if (!match) return undefined;
  return now - Number(match[1]) * UNIT_MS[match[2]!.toLowerCase()]!;
}

function nodeText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value && typeof value === "object" && typeof (value as { toString?: unknown }).toString === "function") {
    const text = String(value);
    return text === "[object Object]" ? "" : text.trim();
  }
  return "";
}

function httpsUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    return new URL(value).protocol === "https:" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** 構造の決まっていない youtubei.js のノードから、パスをたどって値を取り出す（配列は数値のキーで指定する）。 */
function pick(value: unknown, ...path: Array<string | number>): unknown {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** youtubei.js の「動画」タブの項目（新しいレイアウトの LockupView と、従来の Video 系）を共通の形にする。 */
export function normalizeYouTubeChannelVideos(nodes: readonly unknown[]): YouTubeChannelVideo[] {
  const videos: YouTubeChannelVideo[] = [];
  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    let video: YouTubeChannelVideo | undefined;
    if (pick(node, "type") === "LockupView") {
      const videoId = pick(node, "content_id");
      if (pick(node, "content_type") !== "VIDEO" || typeof videoId !== "string") continue;
      const parts = asArray(pick(node, "metadata", "metadata", "metadata_rows"))
        .flatMap((row) => asArray(pick(row, "metadata_parts")))
        .map((part) => nodeText(pick(part, "text")));
      const publishedText = parts.find((part) => /\bago\b/i.test(part));
      const thumbnailUrl = httpsUrl(pick(node, "content_image", "image", 0, "url"));
      video = {
        videoId,
        title: nodeText(pick(node, "metadata", "title")),
        ...(publishedText ? { publishedText } : {}),
        ...(thumbnailUrl ? { thumbnailUrl } : {}),
      };
    } else {
      const id = pick(node, "id") ?? pick(node, "video_id");
      if (typeof id !== "string") continue;
      const publishedText = nodeText(pick(node, "published"));
      const thumbnailUrl = httpsUrl(pick(node, "thumbnails", 0, "url"));
      video = {
        videoId: id,
        title: nodeText(pick(node, "title")),
        ...(publishedText ? { publishedText } : {}),
        ...(thumbnailUrl ? { thumbnailUrl } : {}),
      };
    }
    if (video.videoId && video.title) videos.push(video);
  }
  return videos;
}

/**
 * 代替手段の一覧（新しい順）から、新着として通知する動画を古い順に返す。
 * 一覧は RSS より長く、登録前の古い動画も含むため、一覧の中で最も新しい通知済みの動画より新しいものだけを新着とみなす。
 * 通知済みの動画が一覧に無ければ、どこからが新着か分からないので何も返さない（古い動画を大量に通知しない）。
 * ただし、一度通知を試みて失敗した動画（`failedVideoIds`）は新着と判定済みなので、起点より古くても再試行する。
 */
export function fallbackEntriesSinceLastNotified(
  videos: readonly YouTubeChannelVideo[],
  channelTitle: string,
  sentVideoIds: ReadonlySet<string>,
  now: number,
  failedVideoIds: ReadonlySet<string> = new Set(),
): YouTubeFeedEntry[] {
  const anchor = videos.findIndex((video) => sentVideoIds.has(video.videoId));
  const isTarget = (video: YouTubeChannelVideo, index: number) =>
    !sentVideoIds.has(video.videoId) && ((anchor > 0 && index < anchor) || failedVideoIds.has(video.videoId));
  let lastTarget = videos.length - 1;
  while (lastTarget >= 0 && !isTarget(videos[lastTarget]!, lastTarget)) lastTarget -= 1;
  if (lastTarget < 0) return [];
  // 投稿時期は大まかなので、新しい順の一覧の並びを保つよう、前の動画より必ず古い時刻にする
  let upperBound = now;
  const entries = videos.slice(0, lastTarget + 1).map((video, index) => {
    const publishedMs = Math.min(parseRelativePublishedText(video.publishedText ?? "", now) ?? upperBound, upperBound);
    upperBound = publishedMs - 1;
    const entry: YouTubeFeedEntry = {
      videoId: video.videoId,
      title: video.title,
      channelTitle,
      publishedAt: new Date(publishedMs).toISOString(),
      videoUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(video.videoId)}`,
      thumbnailUrl: video.thumbnailUrl ?? null,
    };
    return isTarget(video, index) ? [entry] : [];
  }).flat();
  // 起点に近い古い方から通知する（次回のスキャンで起点が進み、残りを順に拾える）
  return entries.slice(-MAX_FALLBACK_ENTRIES_PER_SCAN).reverse();
}

type ResolveDeps = {
  fetchFeed: (channelId: string) => Promise<YouTubeFeedResult>;
  fetchFallback: (channelId: string) => Promise<YouTubeChannelVideosResult>;
  now?: number;
  /** テスト用。省略時はプロセス全体で共有するキャッシュを使う */
  fallbackCache?: FallbackCache;
  /** 通知に失敗した動画。代替手段では起点より古くても再試行する（RSS では通知済み以外がすべて対象） */
  failedVideoIds?: ReadonlySet<string>;
};

/**
 * 通知する動画を古い順に返す。RSS を優先し、RSS が取れないときだけ代替手段を使う。
 * 代替手段を使ったときは、RSS の失敗理由を `notice` に入れる（登録一覧の「最終エラー」に表示するため）。
 * 代替手段で取得しに行くのは同じチャンネルに対して一定間隔に1回までで、間隔内は前回の結果を使い回す
 * （前回が失敗なら、その失敗を報告し続ける）。`usedFallback` は今回実際に代替手段で取得したかどうか（ログ用）。
 */
export async function resolveYouTubeWatcherEntries(
  channelId: string,
  sentVideoIds: ReadonlySet<string>,
  deps: ResolveDeps,
): Promise<{ ok: true; entries: YouTubeFeedEntry[]; notice?: string; usedFallback?: boolean } | { ok: false; error: string }> {
  const cache = deps.fallbackCache ?? fallbackResults;
  const feed = await deps.fetchFeed(channelId);
  if (feed.ok) {
    // RSS が復旧したら、次の障害ではすぐ代替手段で取得できるよう前回の結果を消す
    cache.delete(channelId);
    return { ok: true, entries: toUnnotifiedEntries(feed.entries, new Set(sentVideoIds)) };
  }
  const now = deps.now ?? Date.now();
  const notice = `${feed.error}（代替手段で確認中）`;
  const cached = cache.get(channelId);
  const usedFallback = !cached || now - cached.fetchedAt >= FALLBACK_MIN_INTERVAL_MS;
  const current = usedFallback ? { fetchedAt: now, result: await deps.fetchFallback(channelId) } : cached;
  if (usedFallback) cache.set(channelId, current);
  const fallback = current.result;
  if (!fallback.ok) return { ok: false, error: `${feed.error} / ${fallback.error}` };
  return {
    ok: true,
    // 近似の投稿日時は取得した時点を基準にし、使い回しても登録間でそろえる
    entries: fallbackEntriesSinceLastNotified(fallback.videos, fallback.channelTitle, sentVideoIds, current.fetchedAt, deps.failedVideoIds),
    notice,
    usedFallback,
  };
}

let clientCache: { promise: Promise<Innertube>; createdAt: number } | undefined;

function getClient(timeoutMs: number): Promise<Innertube> {
  if (clientCache && Date.now() - clientCache.createdAt < CLIENT_MAX_AGE_MS) return clientCache.promise;
  const promise = Innertube.create({
    // 投稿時期を "4 hours ago" の形で受け取って解釈するため英語にする
    lang: "en",
    location: "US",
    retrieve_player: false,
    fetch: (input, init) => fetch(input, {
      ...init,
      signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(init?.signal ? [init.signal] : [])]),
    }),
  });
  clientCache = { promise, createdAt: Date.now() };
  promise.catch(() => {
    if (clientCache?.promise === promise) clientCache = undefined;
  });
  return promise;
}

/** 代替手段：youtubei.js でチャンネルの「動画」タブの一覧を新しい順に取得する。 */
export async function fetchYouTubeChannelVideos(
  channelId: string,
  options: { timeoutMs?: number } = {},
): Promise<YouTubeChannelVideosResult> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  try {
    const client = await getClient(timeoutMs);
    const channel = await client.getChannel(channelId);
    const tab = await channel.getVideos();
    const channelTitle = nodeText(channel.metadata?.title);
    if (!channelTitle) return { ok: false, error: "代替手段でチャンネル名を取得できませんでした。" };
    return { ok: true, channelTitle, videos: normalizeYouTubeChannelVideos(tab.videos as unknown[]) };
  } catch (error) {
    // 壊れたクライアントを使い続けないよう、次回は作り直す
    clientCache = undefined;
    const timedOut = error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
    return { ok: false, error: timedOut ? "代替手段での取得がタイムアウトしました。" : "代替手段での取得に失敗しました。" };
  }
}
