import type { PreviewDocument, PreviewTextPart } from "../shared/previewDocument.js";
import {
  compactText,
  ensureScheme,
  hasBareUrlBoundary as hasBoundary,
  QUOTED_TRIM_TAIL_CHARS,
  stripUrlTail as sharedStripUrlTail,
} from "../shared/urlUtils.js";
import {
  canonicalSteamUrl,
  isOfficialSteamHost,
  type SteamPagePreview,
} from "../../steam/steamStoreClient.js";

const STEAM_URL_PATTERN = /(?<url>(?:https?:\/\/)?(?:[a-z\d-]+\.)*(?:steampowered\.com|steamcommunity\.com)\/[^\s<>\u3000]+)/giu;

export type SteamReplyTarget = {
  canonicalUrl: string;
  appid?: string;
};

function stripUrlTail(value: string): string {
  return sharedStripUrlTail(value, QUOTED_TRIM_TAIL_CHARS);
}

export function parseSteamUrl(value: string): SteamReplyTarget | null {
  const originalUrl = stripUrlTail(String(value || ""));
  if (!originalUrl) return null;
  try {
    const parsed = new URL(ensureScheme(originalUrl));
    if (parsed.protocol !== "https:" || !isOfficialSteamHost(parsed.hostname)) return null;
    const canonicalUrl = canonicalSteamUrl(parsed.toString());
    if (!canonicalUrl) return null;
    return {
      canonicalUrl,
      ...(canonicalUrl.match(/\/app\/(\d+)/i)?.[1] ? { appid: canonicalUrl.match(/\/app\/(\d+)/i)![1] } : {}),
    };
  } catch {
    return null;
  }
}

export function extractSteamLinks(content: string): string[] {
  const links: string[] = [];
  for (const match of String(content || "").matchAll(STEAM_URL_PATTERN)) {
    const raw = match.groups?.url ?? "";
    if (!hasBoundary(content, match.index ?? 0, raw)) continue;
    const value = stripUrlTail(raw);
    if (value && parseSteamUrl(value)) links.push(value);
  }
  return links;
}

export function collectSteamReplyTargets(links: readonly string[]): SteamReplyTarget[] {
  const targets: SteamReplyTarget[] = [];
  const seen = new Set<string>();
  for (const link of links) {
    const target = parseSteamUrl(link);
    if (!target || seen.has(target.canonicalUrl)) continue;
    seen.add(target.canonicalUrl);
    targets.push(target);
    if (targets.length >= 5) break;
  }
  return targets;
}

function usableExchangeRate(value: number | null): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 50 && value < 300 ? value : null;
}

function pricePart(preview: SteamPagePreview, exchangeRate: number | null): PreviewTextPart {
  if (preview.price.kind === "free") {
    return { text: "無料" };
  }
  if (preview.price.kind !== "paid") return { text: "不明" };
  const usd = `$${preview.price.usd.toFixed(2)}`;
  const rate = usableExchangeRate(exchangeRate);
  if (rate === null) return { text: `${usd}（為替未取得）` };
  const yen = Math.round(preview.price.usd * rate).toLocaleString("ja-JP");
  return { text: `¥${yen}円 (${usd})` };
}

function ratingParts(preview: SteamPagePreview): PreviewTextPart[] {
  const label = preview.rating.label || "不明";
  const parts: PreviewTextPart[] = [{ text: label, ...(preview.rating.label ? { translationKey: "rating" } : {}) }];
  if (typeof preview.rating.percent === "number") parts.push({ text: ` - ${preview.rating.percent}%` });
  if (typeof preview.rating.reviewCount === "number") parts.push({ text: `（${preview.rating.reviewCount.toLocaleString("ja-JP")}件）` });
  return parts;
}

export function steamPreviewToDocument(preview: SteamPagePreview, exchangeRate: number | null): PreviewDocument {
  const title = preview.title || "Steamページ";
  const lines = [
    { parts: [{ text: title, strong: true }] },
    ...(preview.body
      ? [{ parts: [] }, { parts: [{ text: compactText(preview.body, 3_000), translationKey: "body" }] }]
      : [{ parts: [{ text: "本文: 不明" }] }]),
    { parts: [] },
    { prefix: "価格: ", parts: [pricePart(preview, exchangeRate)] },
    { prefix: "評価: ", parts: ratingParts(preview) },
  ];
  return {
    version: 1,
    source: "steam",
    url: preview.canonicalUrl,
    openLabel: "ブラウザで閲覧",
    ...(preview.appid ? {
      secondaryAction: { label: "Steam Clientで開く", url: `https://s.team/a/${encodeURIComponent(preview.appid)}` },
    } : {}),
    blocks: [
      {
        type: "text",
        id: "summary",
        lines,
      },
      ...(preview.imageUrl ? [{
        type: "media" as const,
        id: "image",
        items: [{ url: preview.imageUrl, description: `${title} image` }],
      }] : []),
    ],
  };
}
