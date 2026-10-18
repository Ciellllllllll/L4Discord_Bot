import { load, type CheerioAPI } from "cheerio";
import { URL } from "node:url";
import type { PreviewDocument, PreviewTextBlock } from "../shared/previewDocument.js";
import { extractSteamLinks } from "../steam/steamPreviewSource.js";

const WEB_URL_PATTERN = /https:\/\/[^\s<>\u3000]+/giu;
const TRIM_TAIL_CHARS = ".,!?;:)]}>,、。」』）*_~`|";
/** 1投稿でページを取得してカードにするリンクの数。超えた分は取得せず「ほかのリンク」カードにまとめる */
export const MAX_WEB_PREVIEWS = 3;
/** 「ほかのリンク」カードに並べるリンクの上限 */
const MAX_WEB_TARGETS = 20;
const MAX_LINK_BUTTON_URL_LENGTH = 512;
const MAX_TITLE_CHARS = 200;
const MAX_DESCRIPTION_CHARS = 300;
/** 要約に使う本文の上限。AI に渡すときにさらに切り詰める */
const MAX_TEXT_CHARS = 12_000;

/**
 * 汎用の展開から外すホスト。専用の展開があるもの（X・YouTube・TikTok・Instagram・GitHub・Steam）、
 * Discord 自身のリンク、GIF、公式の Embed で再生できるもの（抑制すると再生できなくなる）は Discord に任せる。
 */
const EXCLUDED_HOSTS = [
  "x.com", "twitter.com", "vxtwitter.com", "fxtwitter.com", "fixupx.com",
  "youtube.com", "youtu.be",
  "tiktok.com",
  "instagram.com", "instagr.am",
  "github.com",
  "discord.com", "discordapp.com", "discordapp.net", "discord.gg", "discord.media",
  "tenor.com", "giphy.com",
  "spotify.com", "spotify.link", "twitch.tv", "soundcloud.com", "vimeo.com", "streamable.com",
];
/** 画像・動画・音声への直リンクは Discord がそのまま表示するので展開しない */
const DIRECT_MEDIA_EXTENSIONS = /\.(?:png|jpe?g|gif|webp|avif|bmp|svg|mp4|webm|mov|m4v|mp3|wav|ogg|flac|m4a)$/iu;

export type WebReplyTarget = {
  url: string;
};

export type WebPagePreview = {
  /** 利用者が貼った URL。開くボタンに使う */
  url: string;
  title: string;
  description?: string;
  siteName?: string;
  imageUrl?: string;
  imageAlt?: string;
  /** twitter:card が summary のページは画像を小さなサムネイルにする */
  largeImage: boolean;
  /** AI要約に使う本文 */
  text: string;
};

function stripUrlTail(urlText: string): string {
  let out = urlText.trim();
  while (out && TRIM_TAIL_CHARS.includes(out[out.length - 1]!)) out = out.slice(0, -1);
  return out;
}

function isExcludedHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return EXCLUDED_HOSTS.some((excluded) => host === excluded || host.endsWith(`.${excluded}`));
}

/** 汎用の展開の対象にする URL か。対象なら正規化した URL を返す */
export function parseWebUrl(urlText: string): WebReplyTarget | null {
  let url: URL;
  try { url = new URL(stripUrlTail(urlText)); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return null;
  if (!url.hostname.includes(".") || isExcludedHost(url.hostname)) return null;
  if (DIRECT_MEDIA_EXTENSIONS.test(url.pathname)) return null;
  if (extractSteamLinks(url.toString()).length > 0) return null;
  url.hash = "";
  // 開くボタンの URL の上限（512 文字）を超えるとカードごと送れないので展開しない
  if (url.toString().length > MAX_LINK_BUTTON_URL_LENGTH) return null;
  return { url: url.toString() };
}

/**
 * 本文から https のリンクを取り出す。`<https://...>` のように Embed を抑制する書き方をしたリンクは、
 * 投稿者が展開を望んでいないので取り出さない。
 */
export function extractWebLinks(content: string): string[] {
  const text = String(content || "");
  const found: string[] = [];
  for (const match of text.matchAll(WEB_URL_PATTERN)) {
    const index = match.index ?? 0;
    if (text[index - 1] === "<") continue;
    const trimmed = stripUrlTail(match[0]);
    if (trimmed) found.push(trimmed);
  }
  return found;
}

export function collectWebReplyTargets(links: readonly string[]): WebReplyTarget[] {
  const seen = new Set<string>();
  const targets: WebReplyTarget[] = [];
  for (const link of links) {
    const target = parseWebUrl(link);
    if (!target || seen.has(target.url)) continue;
    seen.add(target.url);
    targets.push(target);
    if (targets.length >= MAX_WEB_TARGETS) break;
  }
  return targets;
}

const CHARSET_PATTERN = /charset\s*=\s*["']?\s*([\w-]+)/iu;

/** Content-Type か HTML 内の meta charset から文字コードを決めて復号する（日本のサイトの Shift_JIS・EUC-JP など） */
export function decodeHtml(body: Buffer, contentType: string): string {
  const declared = CHARSET_PATTERN.exec(contentType)?.[1]
    ?? CHARSET_PATTERN.exec(body.subarray(0, 4_096).toString("latin1"))?.[1];
  try {
    return new TextDecoder(declared?.toLowerCase() ?? "utf-8").decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
}

function compactText(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function metaContent($: CheerioAPI, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = $(`meta[property="${key}"]`).attr("content") ?? $(`meta[name="${key}"]`).attr("content");
    const text = value?.trim();
    if (text) return text;
  }
  return undefined;
}

function resolveHttpsUrl(value: string | undefined, base: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value, base);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** ナビゲーションや広告を除いた本文。記事（article・main）があればそこから取る */
function extractMainText($: CheerioAPI): string {
  $("script, style, noscript, template, svg, iframe, form, nav, header, footer, aside, [aria-hidden='true']").remove();
  const roots = ["article", "main", "[role='main']", "body"];
  for (const selector of roots) {
    const root = $(selector).first();
    if (root.length === 0) continue;
    const blocks = root.find("h1, h2, h3, h4, p, li, blockquote, pre, td")
      .toArray()
      .map((element) => $(element).text().replace(/\s+/g, " ").trim())
      .filter((text) => text.length > 0);
    const text = (blocks.length > 0 ? blocks.join("\n") : root.text().replace(/\s+/g, " ")).trim();
    if (text.length >= 200 || selector === "body") return text.slice(0, MAX_TEXT_CHARS);
  }
  return "";
}

/** ページの OGP と本文を読む。タイトルが取れないページは展開しない */
export function parseWebPageHtml(html: string, url: string, finalUrl = url): WebPagePreview | null {
  const $ = load(html);
  const title = metaContent($, "og:title", "twitter:title") ?? $("title").first().text().trim();
  if (!title) return null;
  const description = metaContent($, "og:description", "twitter:description", "description");
  const siteName = metaContent($, "og:site_name", "application-name");
  const imageUrl = resolveHttpsUrl(
    metaContent($, "og:image:secure_url", "og:image", "og:image:url", "twitter:image", "twitter:image:src"),
    finalUrl,
  );
  const imageAlt = metaContent($, "og:image:alt", "twitter:image:alt");
  const largeImage = metaContent($, "twitter:card")?.toLowerCase() !== "summary";
  const text = extractMainText($);
  return {
    url,
    title: compactText(title, MAX_TITLE_CHARS),
    ...(description ? { description: compactText(description, MAX_DESCRIPTION_CHARS) } : {}),
    ...(siteName ? { siteName: compactText(siteName, 100) } : {}),
    ...(imageUrl ? { imageUrl } : {}),
    ...(imageAlt ? { imageAlt: compactText(imageAlt, 1_000) } : {}),
    largeImage,
    text,
  };
}

/**
 * X の記事カードと同じ構成のカード。大きな画像のページは記事画像をメディアギャラリーに、
 * それ以外は右側の小さなサムネイルにする。タイトルと説明は翻訳の対象にする。
 */
export function webPreviewToDocument(page: WebPagePreview): PreviewDocument {
  const largeImage = page.imageUrl && page.largeImage ? page.imageUrl : undefined;
  const thumbnailUrl = page.imageUrl && !largeImage ? page.imageUrl : undefined;
  const imageDescription = page.imageAlt ?? "記事の画像";
  const host = new URL(page.url).hostname;
  const siteLabel = page.siteName && page.siteName.toLowerCase() !== host.toLowerCase()
    ? `${page.siteName} · ${host}`
    : host;
  const text: PreviewTextBlock = {
    type: "text",
    id: "card",
    ...(thumbnailUrl ? { thumbnailUrl, thumbnailDescription: imageDescription } : {}),
    lines: [
      { prefix: "🔗 ", parts: [{ text: page.title, translationKey: "title", strong: true }] },
      ...(page.description ? [{ parts: [{ text: page.description, translationKey: "description" }] }] : []),
      { prefix: "-# ", parts: [{ text: siteLabel }] },
    ],
  };
  return {
    version: 1,
    source: "web",
    url: page.url,
    openLabel: "リンクを開く",
    summaryAction: true,
    blocks: [
      ...(largeImage
        ? [{ type: "media" as const, id: "card-media", items: [{ url: largeImage, description: imageDescription }] }]
        : []),
      text,
    ],
  };
}
