import { URL } from "node:url";
import type { PreviewDocument, PreviewTextBlock } from "../shared/previewDocument.js";

const TIKTOK_DOMAINS = new Set(["tiktok.com", "m.tiktok.com", "vm.tiktok.com", "vt.tiktok.com"]);
const TIKWM_API_URL = "https://www.tikwm.com/api/";
const REQUEST_TIMEOUT_MS = 10_000;
const USER_AGENT = "L4DiscordBot/0.1 TikTokPreview";
const TRIM_TAIL_CHARS = ".,!?;:)]}>,、。」』）";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type TikTokReplyTarget = {
  /** 解析に使う正規化済みURL（短縮URLもそのまま渡す） */
  url: string;
  /** URLから動画IDを取れた場合のみ設定（短縮URLでは未設定） */
  videoId?: string;
};

export type TikTokPreview = {
  id: string;
  url: string;
  title: string;
  createdTimestamp?: number;
  author: {
    uniqueId: string;
    nickname?: string;
    avatarUrl?: string;
  };
  coverUrl?: string;
  playUrl?: string;
  images: string[];
  plays?: number;
  likes?: number;
  comments?: number;
  shares?: number;
};

export type TikTokPreviewResult =
  | { status: "ok"; video: TikTokPreview }
  | { status: "fallback"; reason: string };

function ensureScheme(urlText: string): string {
  return /^https?:\/\//i.test(urlText) ? urlText : `https://${urlText}`;
}

function stripUrlTail(urlText: string): string {
  let out = urlText.trim();
  while (out && TRIM_TAIL_CHARS.includes(out[out.length - 1]!)) out = out.slice(0, -1);
  return out;
}

function hostWithoutWww(host: string): string {
  const normalized = host.trim().toLowerCase();
  return normalized.startsWith("www.") ? normalized.slice(4) : normalized;
}

export function isTikTokHost(host: string): boolean {
  return TIKTOK_DOMAINS.has(hostWithoutWww(host));
}

/** TikTok の動画・写真投稿・短縮URLを解析する。プロフィール等の非投稿URLは null。 */
export function parseTikTokUrl(urlText: string): TikTokReplyTarget | null {
  try {
    const parsed = new URL(ensureScheme(stripUrlTail(String(urlText || ""))));
    const host = hostWithoutWww(parsed.host);
    if (!TIKTOK_DOMAINS.has(host)) return null;
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (host === "vm.tiktok.com" || host === "vt.tiktok.com") {
      const code = parts[0];
      return code && /^[A-Za-z0-9]+$/.test(code) ? { url: `https://${host}/${code}/` } : null;
    }
    if (parts[0] === "t" && parts[1] && /^[A-Za-z0-9]+$/.test(parts[1])) {
      return { url: `https://www.tiktok.com/t/${parts[1]}/` };
    }
    const kindIndex = parts.findIndex((part) => part === "video" || part === "photo");
    const user = kindIndex > 0 ? parts[kindIndex - 1] : undefined;
    const id = kindIndex >= 0 ? parts[kindIndex + 1] : undefined;
    if (user?.startsWith("@") && id && /^\d+$/.test(id)) {
      return { url: `https://www.tiktok.com/${user}/${parts[kindIndex]}/${id}`, videoId: id };
    }
    // m.tiktok.com/v/<id>.html
    const mobileId = parts[0] === "v" ? parts[1]?.replace(/\.html$/, "") : undefined;
    if (mobileId && /^\d+$/.test(mobileId)) {
      return { url: `https://m.tiktok.com/v/${mobileId}.html`, videoId: mobileId };
    }
    return null;
  } catch {
    return null;
  }
}

export function collectTikTokReplyTargets(links: readonly string[]): TikTokReplyTarget[] {
  const targets: TikTokReplyTarget[] = [];
  const seen = new Set<string>();
  for (const link of links) {
    const target = parseTikTokUrl(link);
    const key = target?.videoId ?? target?.url;
    if (!target || !key || seen.has(key)) continue;
    seen.add(key);
    targets.push(target);
  }
  return targets;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function safeHttpsUrl(value: unknown): string | undefined {
  const raw = stringValue(value);
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw.startsWith("/") ? `https://www.tikwm.com${raw}` : raw);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function normalizeTikwmResponse(raw: unknown): TikTokPreviewResult {
  const root = asRecord(raw);
  if (numberValue(root?.code) !== 0) return { status: "fallback", reason: stringValue(root?.msg) ?? "api_error" };
  const data = asRecord(root?.data);
  const id = stringValue(data?.id);
  const author = asRecord(data?.author);
  const uniqueId = stringValue(author?.unique_id);
  if (!data || !id || !uniqueId) return { status: "fallback", reason: "invalid_data" };
  const images = (Array.isArray(data.images) ? data.images : [])
    .map(safeHttpsUrl)
    .filter((url): url is string => Boolean(url))
    .slice(0, 10);
  const nickname = stringValue(author?.nickname);
  const avatarUrl = safeHttpsUrl(author?.avatar);
  const coverUrl = safeHttpsUrl(data.cover) ?? safeHttpsUrl(data.origin_cover);
  const playUrl = images.length === 0 ? safeHttpsUrl(data.play) : undefined;
  const createdTimestamp = numberValue(data.create_time);
  return {
    status: "ok",
    video: {
      id,
      url: `https://www.tiktok.com/@${uniqueId}/${images.length > 0 ? "photo" : "video"}/${id}`,
      title: stringValue(data.title) ?? "",
      ...(createdTimestamp !== undefined ? { createdTimestamp } : {}),
      author: {
        uniqueId,
        ...(nickname ? { nickname } : {}),
        ...(avatarUrl ? { avatarUrl } : {}),
      },
      ...(coverUrl ? { coverUrl } : {}),
      ...(playUrl ? { playUrl } : {}),
      images,
      ...(numberValue(data.play_count) !== undefined ? { plays: numberValue(data.play_count) } : {}),
      ...(numberValue(data.digg_count) !== undefined ? { likes: numberValue(data.digg_count) } : {}),
      ...(numberValue(data.comment_count) !== undefined ? { comments: numberValue(data.comment_count) } : {}),
      ...(numberValue(data.share_count) !== undefined ? { shares: numberValue(data.share_count) } : {}),
    },
  };
}

export async function fetchTikTokPreview(
  target: TikTokReplyTarget,
  fetcher: FetchLike = fetch,
): Promise<TikTokPreviewResult> {
  try {
    const response = await fetcher(
      `${TIKWM_API_URL}?url=${encodeURIComponent(target.url)}&hd=0`,
      { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), headers: { "User-Agent": USER_AGENT, Accept: "application/json" } },
    );
    const text = await response.text();
    if (!response.ok) return { status: "fallback", reason: `http_${response.status}` };
    try {
      return normalizeTikwmResponse(JSON.parse(text) as unknown);
    } catch {
      return { status: "fallback", reason: "invalid_json" };
    }
  } catch (err) {
    return { status: "fallback", reason: err instanceof Error ? (err.name === "TimeoutError" ? "AbortError" : err.name) : "fetch_error" };
  }
}

function formatDate(timestamp: number | undefined): string | null {
  if (typeof timestamp !== "number") return null;
  const date = new Date(timestamp * 1_000);
  return `${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, "0")}/${String(date.getUTCDate()).padStart(2, "0")}`;
}

function formatCount(icon: string, value: number | undefined): string | null {
  return typeof value === "number" ? `${icon} ${value.toLocaleString("ja-JP")}` : null;
}

/**
 * `videoMediaUrl` には添付した動画（attachment://）を渡す。
 * 未指定時は写真投稿なら画像、動画ならカバー画像を表示する。
 */
export function tiktokPreviewToDocument(video: TikTokPreview, videoMediaUrl?: string): PreviewDocument {
  const authorName = video.author.nickname
    ? `${video.author.nickname} (@${video.author.uniqueId})`
    : `@${video.author.uniqueId}`;
  const body: PreviewTextBlock = {
    type: "text",
    id: "body",
    ...(video.author.avatarUrl ? {
      thumbnailUrl: video.author.avatarUrl,
      thumbnailDescription: `${authorName} icon`,
    } : {}),
    lines: [
      { parts: [{ text: authorName, strong: true }] },
      ...(video.title ? [{ parts: [] }, { parts: [{ text: video.title.slice(0, 3_000), translationKey: "main" }] }] : []),
    ],
  };
  const mediaUrls = videoMediaUrl
    ? [videoMediaUrl]
    : video.images.length > 0
      ? video.images
      : video.coverUrl ? [video.coverUrl] : [];
  const stats = [
    formatCount("▶️", video.plays),
    formatCount("❤️", video.likes),
    formatCount("💬", video.comments),
    formatCount("🔁", video.shares),
  ].filter((part): part is string => Boolean(part));
  const meta = [formatDate(video.createdTimestamp), stats.length ? stats.join(" / ") : null].filter(Boolean).join(" / ");
  return {
    version: 1,
    source: "tiktok",
    url: video.url,
    openLabel: "TikTokで開く",
    blocks: [
      body,
      ...(mediaUrls.length > 0
        ? [{ type: "media" as const, id: "main-media", items: mediaUrls.map((url) => ({ url, description: "TikTok media" })) }]
        : []),
      ...(meta ? [{ type: "text" as const, id: "meta", lines: [{ prefix: "-# ", parts: [{ text: meta }] }] }] : []),
    ],
  };
}
