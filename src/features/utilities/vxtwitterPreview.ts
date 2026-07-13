import { URL } from "node:url";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  MessageFlags,
  type APIActionRowComponent,
  type APIButtonComponent,
  type APIComponentInContainer,
  type APIContainerComponent,
  type APIMediaGalleryComponent,
  type APIMessageTopLevelComponent,
  type APISectionComponent,
  type APITextDisplayComponent,
  type MessageCreateOptions,
} from "discord.js";
import type { AppConfig } from "../../core/config.js";
import type { AiProviderRouter } from "../ai/aiProviderRouter.js";
import { translateVxTwitterTexts, type VxTwitterTextTranslations } from "./vxtwitterTranslation.js";

const VX_DOMAIN = "vxtwitter.com";
const X_DOMAINS = new Set(["x.com", "twitter.com", "mobile.twitter.com"]);
const REQUEST_TIMEOUT_MS = 10_000;
const USER_AGENT = "L4DiscordBot/0.1 VxTwitterPreview (+https://api.fxtwitter.com/)";
const TRIM_TAIL_CHARS = ".,!?;:)]}>,、。」』）";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type ParsedXStatusUrl = {
  id: string;
  screenName: string;
  originalUrl: string;
  vxUrl: string;
};

export type VxTwitterReplyTarget = {
  vxUrl: string;
  screenName?: string;
  statusId?: string;
};

export type TweetMediaKind = "photo" | "video" | "gif";

export type TweetMedia = {
  kind: TweetMediaKind;
  url: string;
  thumbnailUrl?: string;
  description?: string;
  sensitive: boolean;
};

export type TweetPreview = {
  id: string;
  url: string;
  text: string;
  createdTimestamp?: number;
  author: {
    name?: string;
    screenName: string;
    avatarUrl?: string;
  };
  likes?: number;
  retweets?: number;
  replies?: number;
  views?: number;
  sensitive: boolean;
  media: TweetMedia[];
  quote?: {
    id?: string;
    url?: string;
    text: string;
    author: {
      name?: string;
      screenName: string;
    };
  };
};

export type FixTweetPreviewResult =
  | { status: "ok"; tweet: TweetPreview }
  | { status: "fallback"; reason: string };

export type VxTwitterPreviewPayload = {
  embeds: [];
  flags: MessageFlags.IsComponentsV2;
  components: APIMessageTopLevelComponent[];
  allowedMentions: { parse: []; repliedUser: false };
  previewState?: { tweet: TweetPreview; translations: VxTwitterTextTranslations };
};

export type VxTwitterDisplayMode = "translation" | "original";
export const VX_PREVIEW_SHOW_ORIGINAL_ID = "vxpreview:show-original";
export const VX_PREVIEW_SHOW_TRANSLATION_ID = "vxpreview:show-translation";

type LoggerLike = {
  warn: (obj: unknown, msg?: string) => void;
};

type VxTwitterReplyBuildOptions = {
  fetcher?: FetchLike;
  config?: Pick<AppConfig, "DEEPSEEK_API_KEY"> & Partial<AppConfig>;
  log?: LoggerLike;
  translate?: (tweet: TweetPreview) => Promise<VxTwitterTextTranslations>;
  aiRouter?: AiProviderRouter;
  guildId?: string;
};

function ensureScheme(urlText: string): string {
  return /^https?:\/\//i.test(urlText) ? urlText : `https://${urlText}`;
}

function stripUrlTail(urlText: string): string {
  let out = urlText.trim();
  while (out && TRIM_TAIL_CHARS.includes(out[out.length - 1]!)) {
    out = out.slice(0, -1);
  }
  return out;
}

function hostWithoutWww(host: string): string {
  const normalized = host.trim().toLowerCase();
  return normalized.startsWith("www.") ? normalized.slice(4) : normalized;
}

function safeHttpsUrl(value: unknown): string | undefined {
  const raw = stringValue(value);
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "https:" ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function parseXStatusUrl(urlText: string): ParsedXStatusUrl | null {
  try {
    const parsed = new URL(ensureScheme(stripUrlTail(String(urlText || ""))));
    const host = hostWithoutWww(parsed.host);
    if (!X_DOMAINS.has(host)) return null;
    const parts = parsed.pathname.split("/").filter(Boolean);
    const statusIndex = parts.findIndex((part) => part.toLowerCase() === "status");
    const screenName = statusIndex > 0 ? parts[statusIndex - 1] : "";
    const id = statusIndex >= 0 ? parts[statusIndex + 1] : undefined;
    if (!screenName || !id || !/^\d+$/.test(id)) return null;
    const vx = new URL(parsed.toString());
    vx.host = VX_DOMAIN;
    return {
      id,
      screenName,
      originalUrl: parsed.toString(),
      vxUrl: vx.toString(),
    };
  } catch {
    return null;
  }
}

function toVxTwitterUrl(urlText: string): string | null {
  try {
    const parsed = new URL(ensureScheme(stripUrlTail(String(urlText || ""))));
    const host = hostWithoutWww(parsed.host);
    if (!X_DOMAINS.has(host)) return null;
    parsed.host = VX_DOMAIN;
    return parsed.toString();
  } catch {
    return null;
  }
}

export function collectVxTwitterReplyTargets(links: readonly string[]): VxTwitterReplyTarget[] {
  const targets: VxTwitterReplyTarget[] = [];
  const seen = new Set<string>();
  for (const link of links) {
    const parsed = parseXStatusUrl(link);
    const vxUrl = parsed?.vxUrl ?? toVxTwitterUrl(link);
    if (!vxUrl || seen.has(vxUrl)) continue;
    seen.add(vxUrl);
    targets.push({
      vxUrl,
      screenName: parsed?.screenName,
      statusId: parsed?.id,
    });
  }
  return targets;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function boolValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const s = stringValue(value);
    if (s) return s;
  }
  return undefined;
}

function mediaKind(type: string | undefined): TweetMediaKind | null {
  if (type === "photo" || type === "image") return "photo";
  if (type === "video") return "video";
  if (type === "gif") return "gif";
  return null;
}

function normalizeMediaItem(raw: unknown, tweetSensitive: boolean): TweetMedia | null {
  const item = asRecord(raw);
  if (!item) return null;
  const kind = mediaKind(stringValue(item.type));
  if (!kind) return null;
  const url = safeHttpsUrl(firstString(item.url, item.media_url_https, item.mediaURL));
  if (!url) return null;
  const thumbnailUrl = safeHttpsUrl(firstString(item.thumbnail_url, item.thumbnailUrl));
  return {
    kind,
    url,
    thumbnailUrl,
    description: firstString(item.altText, item.alt_text, item.description),
    sensitive: tweetSensitive || boolValue(item.possibly_sensitive) === true || boolValue(item.sensitive) === true,
  };
}

function normalizeMosaic(raw: unknown, tweetSensitive: boolean): TweetMedia | null {
  const mosaic = asRecord(raw);
  const formats = asRecord(mosaic?.formats);
  const url = safeHttpsUrl(formats?.webp) ?? safeHttpsUrl(formats?.jpeg);
  if (!url) return null;
  return {
    kind: "photo",
    url,
    sensitive: tweetSensitive || boolValue(mosaic?.possibly_sensitive) === true || boolValue(mosaic?.sensitive) === true,
  };
}

function normalizeMedia(rawTweet: Record<string, unknown>, tweetSensitive: boolean): TweetMedia[] {
  const media = asRecord(rawTweet.media);
  const mediaExtended = arrayValue(rawTweet.media_extended);
  const ordered = [
    ...arrayValue(media?.all),
    ...(arrayValue(media?.all).length === 0 ? [...arrayValue(media?.photos), ...arrayValue(media?.videos)] : []),
    ...(media?.external ? [media.external] : []),
    ...(media?.mosaic ? [media.mosaic] : []),
    ...mediaExtended,
  ];
  const out: TweetMedia[] = [];
  const seen = new Set<string>();
  for (const item of ordered) {
    const itemType = stringValue(asRecord(item)?.type);
    const normalized = itemType === "mosaic_photo"
      ? normalizeMosaic(item, tweetSensitive)
      : normalizeMediaItem(item, tweetSensitive);
    if (normalized && !seen.has(normalized.url)) {
      seen.add(normalized.url);
      out.push(normalized);
    }
  }
  return out.slice(0, 10);
}

function normalizeQuote(raw: unknown): TweetPreview["quote"] | undefined {
  const quote = asRecord(raw);
  if (!quote) return undefined;
  const author = asRecord(quote.author);
  const screenName = firstString(author?.screen_name, author?.screenName, quote.screen_name, quote.screenName);
  const text = firstString(quote.text, quote.full_text);
  if (!screenName || !text) return undefined;
  return {
    id: firstString(quote.id, quote.tweetID),
    url: firstString(quote.url),
    text,
    author: {
      name: firstString(author?.name),
      screenName,
    },
  };
}

export function normalizeFixTweetResponse(raw: unknown): FixTweetPreviewResult {
  const root = asRecord(raw);
  const code = numberValue(root?.code);
  if (code !== 200) {
    return { status: "fallback", reason: stringValue(root?.message) ?? `code_${code ?? "missing"}` };
  }

  const tweet = asRecord(root?.tweet);
  if (!tweet) return { status: "fallback", reason: "missing_tweet" };
  const author = asRecord(tweet.author);
  const screenName = firstString(author?.screen_name, author?.screenName, tweet.screen_name, tweet.screenName);
  const id = firstString(tweet.id, tweet.tweetID);
  const text = firstString(tweet.text, tweet.full_text) ?? "";
  if (!screenName || (!id && !text)) {
    return { status: "fallback", reason: "invalid_tweet" };
  }

  const sensitive =
    boolValue(tweet.possibly_sensitive) === true
    || boolValue(tweet.sensitive) === true
    || boolValue(tweet.nsfw) === true;
  const fallbackTweetUrl = id ? `https://twitter.com/${screenName}/status/${id}` : `https://twitter.com/${screenName}`;

  return {
    status: "ok",
    tweet: {
      id: id ?? "",
      url: safeHttpsUrl(tweet.url) ?? fallbackTweetUrl,
      text,
      createdTimestamp: numberValue(tweet.created_timestamp) ?? numberValue(tweet.date_epoch),
      author: {
        name: firstString(author?.name),
        screenName,
        avatarUrl: safeHttpsUrl(firstString(author?.avatar_url, author?.avatarUrl)),
      },
      likes: numberValue(tweet.likes),
      retweets: numberValue(tweet.retweets),
      replies: numberValue(tweet.replies),
      views: numberValue(tweet.views),
      sensitive,
      media: normalizeMedia(tweet, sensitive),
      quote: normalizeQuote(tweet.quote),
    },
  };
}

function apiUrlFor(input: Pick<ParsedXStatusUrl, "id" | "screenName">): string {
  return `https://api.fxtwitter.com/${encodeURIComponent(input.screenName)}/status/${encodeURIComponent(input.id)}`;
}

export async function fetchFixTweetPreview(
  input: Pick<ParsedXStatusUrl, "id" | "screenName">,
  fetcher: FetchLike = fetch,
): Promise<FixTweetPreviewResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetcher(apiUrlFor(input), {
      signal: controller.signal,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      },
    });
    const text = await response.text();
    if (!response.ok) {
      return { status: "fallback", reason: `http_${response.status}` };
    }
    try {
      return normalizeFixTweetResponse(JSON.parse(text) as unknown);
    } catch {
      return { status: "fallback", reason: "invalid_json" };
    }
  } catch (err) {
    return { status: "fallback", reason: err instanceof Error ? err.name : "fetch_error" };
  } finally {
    clearTimeout(timer);
  }
}

function compactText(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function formatCount(icon: string, value: number | undefined): string | null {
  return typeof value === "number" ? `${icon} ${value.toLocaleString("ja-JP")}` : null;
}

function formatDate(timestamp: number | undefined): string | null {
  if (typeof timestamp !== "number") return null;
  const date = new Date(timestamp * 1000);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}/${month}/${day}`;
}

function hasUsefulTranslation(translations?: VxTwitterTextTranslations): boolean {
  return Boolean(translations?.main?.translatedText || translations?.quote?.translatedText);
}

function buildBodyText(
  tweet: TweetPreview,
  translations: VxTwitterTextTranslations | undefined,
  displayMode: VxTwitterDisplayMode,
): string {
  const lines: string[] = [];
  const authorName = tweet.author.name ? `${tweet.author.name} (@${tweet.author.screenName})` : `@${tweet.author.screenName}`;
  lines.push(`**${authorName}**`);
  if (tweet.text) {
    lines.push("");
    lines.push((displayMode === "translation" ? translations?.main?.translatedText : undefined)?.slice(0, 3000) ?? tweet.text.slice(0, 3000));
  }
  if (tweet.quote) {
    lines.push("");
    const quoteText = displayMode === "translation" ? translations?.quote?.translatedText : undefined;
    lines.push(`> 引用: @${tweet.quote.author.screenName} ${compactText(quoteText ?? tweet.quote.text, 180)}`);
    if (tweet.quote.url) lines.push(`> ${tweet.quote.url}`);
  }
  return lines.join("\n").slice(0, 4000);
}

function buildBodyComponent(
  tweet: TweetPreview,
  translations: VxTwitterTextTranslations | undefined,
  displayMode: VxTwitterDisplayMode,
): APITextDisplayComponent | APISectionComponent {
  const body: APITextDisplayComponent = {
    type: ComponentType.TextDisplay,
    content: buildBodyText(tweet, translations, displayMode),
  };
  if (!tweet.author.avatarUrl) return body;
  const authorName = tweet.author.name ? `${tweet.author.name} (@${tweet.author.screenName})` : `@${tweet.author.screenName}`;
  return {
    type: ComponentType.Section,
    components: [body],
    accessory: {
      type: ComponentType.Thumbnail,
      media: { url: tweet.author.avatarUrl },
      description: `${authorName} icon`,
    },
  };
}

function buildMetaDisplay(tweet: TweetPreview): APITextDisplayComponent | null {
  const stats = [
    formatCount("💬", tweet.replies),
    formatCount("🔁", tweet.retweets),
    formatCount("❤️", tweet.likes),
    formatCount("👁️", tweet.views),
  ].filter((part): part is string => Boolean(part));
  const meta = [
    formatDate(tweet.createdTimestamp),
    stats.length ? stats.join(" / ") : null,
  ].filter(Boolean);
  if (meta.length === 0) return null;
  return {
    type: ComponentType.TextDisplay,
    content: `-# ${meta.join(" / ")}`,
  };
}

function buildTranslationAttribution(translations: VxTwitterTextTranslations | undefined): APITextDisplayComponent | null {
  if (!hasUsefulTranslation(translations) || !translations?.model) return null;
  return { type: ComponentType.TextDisplay, content: `-# この投稿は ${translations.model.slice(0, 120)} によって翻訳されました。Made by Ciel` };
}

function mediaDisplayUrl(media: TweetMedia): string {
  return media.url;
}

function buildMediaGallery(tweet: TweetPreview): APIMediaGalleryComponent | null {
  const items = tweet.media
    .map((media) => ({
      media: { url: mediaDisplayUrl(media) },
      ...(media.description ? { description: media.description.slice(0, 1024) } : {}),
      ...(media.sensitive ? { spoiler: true } : {}),
    }))
    .slice(0, 10);
  if (items.length === 0) return null;
  return {
    type: ComponentType.MediaGallery,
    items,
  };
}

function buildLinkRow(
  tweet: TweetPreview,
  translations: VxTwitterTextTranslations | undefined,
  displayMode: VxTwitterDisplayMode,
): APIActionRowComponent<APIButtonComponent> {
  const row = new ActionRowBuilder<ButtonBuilder>()
    .addComponents(new ButtonBuilder().setLabel("Xで開く").setStyle(ButtonStyle.Link).setURL(tweet.url));
  if (hasUsefulTranslation(translations)) {
    row.addComponents(
      new ButtonBuilder()
        .setLabel(displayMode === "translation" ? "原文を表示" : "翻訳を表示")
        .setStyle(ButtonStyle.Secondary)
        .setCustomId(displayMode === "translation" ? VX_PREVIEW_SHOW_ORIGINAL_ID : VX_PREVIEW_SHOW_TRANSLATION_ID),
    );
  }
  return row
    .toJSON() as APIActionRowComponent<APIButtonComponent>;
}

export function buildVxTwitterPreviewPayload(
  tweet: TweetPreview,
  _vxUrl: string,
  translations?: VxTwitterTextTranslations,
  displayMode: VxTwitterDisplayMode = "translation",
): VxTwitterPreviewPayload {
  const body = buildBodyComponent(tweet, translations, displayMode);
  const gallery = buildMediaGallery(tweet);
  const attribution = buildTranslationAttribution(translations);
  const meta = buildMetaDisplay(tweet);
  const components: APIComponentInContainer[] = [
    body,
    ...(attribution ? [attribution] : []),
    ...(gallery ? [gallery] : []),
    ...(meta ? [meta] : []),
    buildLinkRow(tweet, translations, displayMode),
  ];
  const container: APIContainerComponent = {
    type: ComponentType.Container,
    components,
  };
  return {
    embeds: [],
    flags: MessageFlags.IsComponentsV2,
    components: [container],
    allowedMentions: { parse: [], repliedUser: false },
    ...(hasUsefulTranslation(translations) ? { previewState: { tweet, translations: translations! } } : {}),
  };
}

export function buildVxTwitterFallbackReply(vxUrls: readonly string[]): MessageCreateOptions {
  return {
    content: vxUrls.join("\n"),
    allowedMentions: { parse: [], repliedUser: false },
  };
}

export async function buildVxTwitterReplyPayloads(
  links: readonly string[] | readonly VxTwitterReplyTarget[],
  fetcherOrOptions: FetchLike | VxTwitterReplyBuildOptions = fetch,
  maybeOptions?: VxTwitterReplyBuildOptions,
): Promise<MessageCreateOptions[]> {
  const fetcher = typeof fetcherOrOptions === "function" ? fetcherOrOptions : (fetcherOrOptions.fetcher ?? fetch);
  const options = typeof fetcherOrOptions === "function" ? (maybeOptions ?? {}) : fetcherOrOptions;
  const targets = typeof links[0] === "string"
    ? collectVxTwitterReplyTargets(links as readonly string[])
    : (links as readonly VxTwitterReplyTarget[]);
  return await Promise.all(targets.map(async (target): Promise<MessageCreateOptions> => {
    if (!target.statusId || !target.screenName) {
      return buildVxTwitterFallbackReply([target.vxUrl]);
    }
    const result = await fetchFixTweetPreview({ id: target.statusId, screenName: target.screenName }, fetcher);
    if (result.status === "ok") {
      let translations: VxTwitterTextTranslations | undefined;
      try {
        translations = options.translate
          ? await options.translate(result.tweet)
          : options.config
            ? await translateVxTwitterTexts(
              {
                mainText: result.tweet.text,
                quoteText: result.tweet.quote?.text,
              },
              {
                config: options.config,
                log: options.log,
                router: options.aiRouter,
                guildId: options.guildId,
              },
            )
            : undefined;
      } catch {
        translations = undefined;
      }
      return buildVxTwitterPreviewPayload(result.tweet, target.vxUrl, translations);
    }
    return buildVxTwitterFallbackReply([target.vxUrl]);
  }));
}
