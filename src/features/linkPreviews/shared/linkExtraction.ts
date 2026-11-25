import type { Message } from "discord.js";
import { URL } from "node:url";
import { extractGithubLinks as extractGithubLinksFromContent, parseGithubUrl } from "../github/githubPreviewSource.js";
import { INSTAGRAM_DOMAINS } from "../instagram/instagramPreviewSource.js";
import { extractSteamLinks } from "../steam/steamPreviewSource.js";
import { TIKTOK_DOMAINS } from "../tiktok/tiktokPreviewSource.js";
import {
  ensureScheme,
  hasBareUrlBoundary,
  hostWithoutWww,
  safeHttpsUrl,
  stripUrlTail,
} from "./urlUtils.js";

const X_DOMAINS = new Set([
  "x.com", "twitter.com", "mobile.twitter.com", "vxtwitter.com", "fxtwitter.com", "fixupx.com",
]);
const YOUTUBE_DOMAINS = new Set([
  "youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be", "www.youtu.be",
]);
const X_URL_PATTERN =
  /(?<url>(?:https?:\/\/)?(?:www\.)?(?:vxtwitter\.com|fxtwitter\.com|fixupx\.com|x\.com|twitter\.com|mobile\.twitter\.com)\/[^\s<>\u3000]+)/gi;
const YOUTUBE_URL_PATTERN =
  /(?<url>(?:https?:\/\/)?(?:youtube\.com|www\.youtube\.com|m\.youtube\.com|music\.youtube\.com|youtu\.be|www\.youtu\.be)\/[^\s<>\u3000]+)/gi;
const TIKTOK_URL_PATTERN =
  /(?<url>(?:https?:\/\/)?(?:www\.|m\.|vm\.|vt\.)?tiktok\.com\/[^\s<>\u3000]+)/gi;
const INSTAGRAM_URL_PATTERN =
  /(?<url>(?:https?:\/\/)?(?:(?:www\.|m\.)?instagram\.com|(?:www\.)?instagr\.am)\/[^\s<>\u3000]+)/gi;

function matchesDomain(urlText: string, domains: ReadonlySet<string>, stripWww: boolean): boolean {
  try {
    const host = new URL(ensureScheme(urlText)).host.toLowerCase();
    return domains.has(stripWww ? hostWithoutWww(host) : host);
  } catch {
    return false;
  }
}

function extractLinks(content: string, pattern: RegExp, domains: ReadonlySet<string>, stripWww: boolean): string[] {
  const found: string[] = [];
  for (const match of String(content || "").matchAll(pattern)) {
    const raw = match.groups?.url ?? "";
    if (!hasBareUrlBoundary(content, match.index ?? 0, raw)) continue;
    const trimmed = stripUrlTail(raw);
    if (trimmed && matchesDomain(trimmed, domains, stripWww)) found.push(trimmed);
  }
  return found;
}

export function extractXLinks(content: string): string[] {
  return extractLinks(String(content || ""), X_URL_PATTERN, X_DOMAINS, true);
}

export function extractYouTubeLinks(content: string): string[] {
  return extractLinks(String(content || ""), YOUTUBE_URL_PATTERN, YOUTUBE_DOMAINS, false);
}

export function extractTikTokLinks(content: string): string[] {
  return extractLinks(String(content || ""), TIKTOK_URL_PATTERN, TIKTOK_DOMAINS, true);
}

export function extractInstagramLinks(content: string): string[] {
  return extractLinks(String(content || ""), INSTAGRAM_URL_PATTERN, INSTAGRAM_DOMAINS, true);
}

export function extractGithubLinks(content: string): string[] {
  return extractGithubLinksFromContent(String(content || ""));
}

function extractMessageTextValues(message: Pick<Message, "content" | "embeds">): string[] {
  const values: string[] = [String(message.content || "")];
  for (const embed of message.embeds ?? []) {
    const raw = typeof (embed as { toJSON?: unknown }).toJSON === "function"
      ? (embed as { toJSON: () => unknown }).toJSON()
      : embed;
    if (!raw || typeof raw !== "object") continue;
    const value = raw as {
      url?: unknown;
      title?: unknown;
      description?: unknown;
      fields?: Array<{ name?: unknown; value?: unknown }>;
      author?: { name?: unknown };
      footer?: { text?: unknown };
    };
    for (const item of [value.url, value.title, value.description, value.author?.name, value.footer?.text]) {
      if (typeof item === "string") values.push(item);
    }
    for (const field of value.fields ?? []) {
      if (typeof field.name === "string") values.push(field.name);
      if (typeof field.value === "string") values.push(field.value);
    }
  }
  return values;
}

export function extractSteamLinksFromMessage(message: Pick<Message, "content" | "embeds">): string[] {
  return extractMessageTextValues(message).flatMap((value) => extractSteamLinks(value));
}

export function extractGithubLinksFromMessage(message: Pick<Message, "content" | "embeds">): string[] {
  return extractMessageTextValues(message).flatMap((value) => extractGithubLinks(value));
}

export function extractGithubEmbedImageUrls(message: Pick<Message, "embeds">): Map<string, string> {
  const images = new Map<string, string>();
  for (const embed of message.embeds ?? []) {
    const raw = typeof (embed as { toJSON?: unknown }).toJSON === "function"
      ? (embed as { toJSON: () => unknown }).toJSON()
      : embed;
    if (!raw || typeof raw !== "object") continue;
    const value = raw as { url?: unknown; image?: { url?: unknown }; thumbnail?: { url?: unknown } };
    if (typeof value.url !== "string") continue;
    const target = parseGithubUrl(value.url);
    if (!target) continue;
    const imageUrl = safeHttpsUrl(value.image?.url) ?? safeHttpsUrl(value.thumbnail?.url);
    if (imageUrl) images.set(target.canonicalUrl, imageUrl);
  }
  return images;
}

export function extractComponentUrls(components: readonly unknown[]): string[] {
  const urls: string[] = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    const component = value as { url?: unknown; components?: readonly unknown[]; toJSON?: () => unknown };
    if (typeof component.toJSON === "function") {
      visit(component.toJSON());
      return;
    }
    if (typeof component.url === "string") urls.push(component.url);
    for (const child of component.components ?? []) visit(child);
  };
  for (const component of components) visit(component);
  return urls;
}

export function extractComponentMediaUrls(components: readonly unknown[]): string[] {
  const urls: string[] = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    const component = value as { items?: readonly unknown[]; components?: readonly unknown[]; toJSON?: () => unknown };
    if (typeof component.toJSON === "function") {
      visit(component.toJSON());
      return;
    }
    for (const item of component.items ?? []) {
      if (!item || typeof item !== "object") continue;
      const media = (item as { media?: { url?: unknown } }).media;
      const url = safeHttpsUrl(media?.url);
      if (url) urls.push(url);
    }
    for (const child of component.components ?? []) visit(child);
  };
  for (const component of components) visit(component);
  return urls;
}
