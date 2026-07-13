import { load } from "cheerio";

const CHANNEL_URL_PATTERN = /^https:\/\/(?:www\.)?youtube\.com\/channel\/(UC[\w-]+)\/?$/i;
const FEED_URL = "https://www.youtube.com/feeds/videos.xml";

export type YouTubeChannelUrl = {
  channelId: string;
  canonicalUrl: string;
};

export type YouTubeFeedEntry = {
  videoId: string;
  title: string;
  channelTitle: string;
  publishedAt: string;
  videoUrl: string;
  thumbnailUrl: string | null;
};

export function parseYouTubeChannelUrl(value: string): YouTubeChannelUrl | null {
  const match = CHANNEL_URL_PATTERN.exec(value.trim());
  if (!match?.[1]) return null;
  const channelId = match[1];
  return { channelId, canonicalUrl: `https://www.youtube.com/channel/${channelId}` };
}

function textAt($: ReturnType<typeof load>, selector: string): string {
  return $(selector).first().text().trim();
}

function validHttpsUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function parseYouTubeChannelFeed(xml: string): YouTubeFeedEntry[] {
  const $ = load(xml, { xmlMode: true });
  const channelTitle = textAt($, "feed > title");
  if (!channelTitle) throw new Error("RSSにチャンネル名がありません。");
  const entries: YouTubeFeedEntry[] = [];
  $("feed > entry").each((_index, element) => {
    const entry = $(element);
    const videoId = entry.find("yt\\:videoId").first().text().trim();
    const title = entry.find("title").first().text().trim();
    const publishedAtRaw = entry.find("published").first().text().trim();
    const publishedAtMs = Date.parse(publishedAtRaw);
    const videoUrl = validHttpsUrl(entry.find("link[rel='alternate']").attr("href") ?? "");
    if (!videoId || !title || !Number.isFinite(publishedAtMs) || !videoUrl) return;
    const thumbnailUrl = validHttpsUrl(entry.find("media\\:thumbnail").first().attr("url") ?? "");
    entries.push({
      videoId,
      title,
      channelTitle,
      publishedAt: new Date(publishedAtMs).toISOString(),
      videoUrl,
      thumbnailUrl,
    });
  });
  return entries;
}

export async function fetchYouTubeChannelFeed(
  channelId: string,
  options: { fetcher?: typeof fetch; timeoutMs?: number } = {},
): Promise<{ ok: true; entries: YouTubeFeedEntry[] } | { ok: false; error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  try {
    const url = new URL(FEED_URL);
    url.searchParams.set("channel_id", channelId);
    const response = await (options.fetcher ?? fetch)(url.toString(), { signal: controller.signal });
    if (!response.ok) return { ok: false, error: `RSSの取得に失敗しました。(HTTP ${response.status})` };
    try {
      return { ok: true, entries: parseYouTubeChannelFeed(await response.text()) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "RSSの解析に失敗しました。" };
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error && error.name === "AbortError" ? "RSSの取得がタイムアウトしました。" : "RSSの取得に失敗しました。" };
  } finally {
    clearTimeout(timer);
  }
}
