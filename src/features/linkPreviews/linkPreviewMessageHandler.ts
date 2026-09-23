import type { Message } from "discord.js";
import { URL } from "node:url";
import type { BotContext } from "../../bot/context.js";
import { getGuildSettingsData } from "../../core/guildSettings.js";
import { looksLikePrefixCommandLine } from "../../message/commandLike.js";
import {
  cacheYouTubeVideoForPost,
  saveYouTubeVideoCacheReferenceForPost,
} from "../youtubeWatcher/youtubeVideoCache.service.js";
import type { PreviewTranslationStateV1 } from "./shared/previewState.repository.js";
import {
  buildTwitterReplyPayloads,
  expandTwitterLinks,
} from "./twitter/twitterLinkExpansion.js";
import { collectTwitterReplyTargets, parseXStatusUrl } from "./twitter/twitterPreviewSource.js";
import {
  buildSteamReplyPayloads,
  sendSteamLinkExpansion,
} from "./steam/steamLinkExpansion.js";
import { collectSteamReplyTargets, extractSteamLinks, parseSteamUrl } from "./steam/steamPreviewSource.js";
import {
  buildYouTubeReplyPayloads,
  prepareYouTubeLinkExpansion,
  sendYouTubeLinkExpansion,
  waitForNativeYouTubeEmbed,
  type YouTubePreviewBuildOptions,
} from "./youtube/youtubeLinkExpansion.js";
import { collectYouTubeReplyTargets, parseYouTubeUrl } from "./youtube/youtubePreviewSource.js";
import { collectGithubReplyTargets, extractGithubLinks as extractGithubLinksFromContent, parseGithubUrl } from "./github/githubPreviewSource.js";
import {
  buildGithubReplyPayloads,
  sendGithubLinkExpansion,
  type GithubPreviewBuildResult,
} from "./github/githubLinkExpansion.js";
import { buildTikTokReplyPayloads, expandTikTokLinks } from "./tiktok/tiktokLinkExpansion.js";
import { collectTikTokReplyTargets, isTikTokHost, parseTikTokUrl } from "./tiktok/tiktokPreviewSource.js";
import { resolveYouTubeVideoMedia } from "../utilities/youtubeVideoMedia.js";
import { youtubeAttachmentSizeLimitForPremiumTier } from "./youtube/youtubeMediaAttachment.js";

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
const BARE_URL_BOUNDARY_CHARS = new Set(["<", "(", "[", "{", "\"", "'"]);
const TRIM_TAIL_CHARS = ".,!?;:)]}>,、。」』）";

function stripUrlTail(urlText: string): string {
  let url = String(urlText || "").trim();
  while (url && TRIM_TAIL_CHARS.includes(url[url.length - 1]!)) url = url.slice(0, -1);
  return url;
}

function ensureScheme(urlText: string): string {
  return /^https?:\/\//i.test(urlText) ? urlText : `https://${urlText}`;
}

function hasUrlCandidateBoundary(content: string, index: number, urlText: string): boolean {
  if (/^https?:\/\//i.test(urlText) || index <= 0) return true;
  const previous = content[index - 1] ?? "";
  return /\s/u.test(previous) || previous === "\u3000" || BARE_URL_BOUNDARY_CHARS.has(previous);
}

function hostWithoutWww(host: string): string {
  const normalized = host.trim().toLowerCase();
  return normalized.startsWith("www.") ? normalized.slice(4) : normalized;
}

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
    if (!hasUrlCandidateBoundary(content, match.index ?? 0, raw)) continue;
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
  const found: string[] = [];
  for (const match of String(content || "").matchAll(TIKTOK_URL_PATTERN)) {
    const raw = match.groups?.url ?? "";
    if (!hasUrlCandidateBoundary(content, match.index ?? 0, raw)) continue;
    const trimmed = stripUrlTail(raw);
    try {
      if (trimmed && isTikTokHost(new URL(ensureScheme(trimmed)).host)) found.push(trimmed);
    } catch {}
  }
  return found;
}

export function extractGithubLinks(content: string): string[] {
  return extractGithubLinksFromContent(String(content || ""));
}

function attachmentSizeLimitForMessage(message: Message): number {
  return youtubeAttachmentSizeLimitForPremiumTier(message.guild?.premiumTier);
}

type LinkPreviewMessageHandlerDeps = {
  buildVxTwitterReplyPayloads?: typeof buildTwitterReplyPayloads;
  expandTwitterLinks?: typeof expandTwitterLinks;
  buildYouTubeReplyPayloads?: typeof buildYouTubeReplyPayloads;
  cacheYouTubeVideoForPost?: typeof cacheYouTubeVideoForPost;
  saveYouTubeVideoCacheReference?: typeof saveYouTubeVideoCacheReferenceForPost;
  mediaResolver?: YouTubePreviewBuildOptions["mediaResolver"];
  fetcher?: YouTubePreviewBuildOptions["fetcher"];
  buildSteamReplyPayloads?: typeof buildSteamReplyPayloads;
  buildGithubReplyPayloads?: typeof buildGithubReplyPayloads;
  expandTikTokLinks?: typeof expandTikTokLinks;
};

function extractSteamLinksFromMessage(message: Pick<Message, "content" | "embeds">): string[] {
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
    for (const item of [value.url, value.title, value.description]) {
      if (typeof item === "string") values.push(item);
    }
    for (const item of [value.author?.name, value.footer?.text]) {
      if (typeof item === "string") values.push(item);
    }
    for (const field of value.fields ?? []) {
      if (typeof field.name === "string") values.push(field.name);
      if (typeof field.value === "string") values.push(field.value);
    }
  }
  return values.flatMap((value) => extractSteamLinks(value));
}

function extractGithubLinksFromMessage(message: Pick<Message, "content" | "embeds">): string[] {
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
  return values.flatMap((value) => extractGithubLinks(value));
}

function safeHttpsUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function extractGithubEmbedImageUrls(
  message: Pick<Message, "embeds">,
): Map<string, string> {
  const images = new Map<string, string>();
  for (const embed of message.embeds ?? []) {
    const raw = typeof (embed as { toJSON?: unknown }).toJSON === "function"
      ? (embed as { toJSON: () => unknown }).toJSON()
      : embed;
    if (!raw || typeof raw !== "object") continue;
    const value = raw as {
      url?: unknown;
      image?: { url?: unknown };
      thumbnail?: { url?: unknown };
    };
    if (typeof value.url !== "string") continue;
    const target = parseGithubUrl(value.url);
    if (!target) continue;
    const imageUrl = safeHttpsUrl(value.image?.url) ?? safeHttpsUrl(value.thumbnail?.url);
    if (imageUrl) images.set(target.canonicalUrl, imageUrl);
  }
  return images;
}

export class LinkPreviewMessageHandler {
  private readonly deps: Required<LinkPreviewMessageHandlerDeps>;

  constructor(private readonly ctx: BotContext, deps: LinkPreviewMessageHandlerDeps = {}) {
    this.deps = {
      buildVxTwitterReplyPayloads: deps.buildVxTwitterReplyPayloads ?? buildTwitterReplyPayloads,
      expandTwitterLinks: deps.expandTwitterLinks ?? expandTwitterLinks,
      buildYouTubeReplyPayloads: deps.buildYouTubeReplyPayloads ?? buildYouTubeReplyPayloads,
      cacheYouTubeVideoForPost: deps.cacheYouTubeVideoForPost ?? cacheYouTubeVideoForPost,
      saveYouTubeVideoCacheReference: deps.saveYouTubeVideoCacheReference ?? saveYouTubeVideoCacheReferenceForPost,
      mediaResolver: deps.mediaResolver ?? resolveYouTubeVideoMedia,
      fetcher: deps.fetcher ?? fetch,
      buildSteamReplyPayloads: deps.buildSteamReplyPayloads ?? buildSteamReplyPayloads,
      buildGithubReplyPayloads: deps.buildGithubReplyPayloads ?? buildGithubReplyPayloads,
      expandTikTokLinks: deps.expandTikTokLinks ?? expandTikTokLinks,
    };
  }

  async onMessage(message: Message): Promise<void> {
    if (message.author?.bot || !message.guild || message.guild.id !== this.ctx.config.GUILD_ID) return;
    if (looksLikePrefixCommandLine(message.content)) return;
    const settings = await getGuildSettingsData(this.ctx.db, message.guild.id);
    if (settings.auto_reply_excluded_channel_ids?.includes(message.channelId)) return;

    const content = String(message.content || "");
    const directSteamLinks = extractSteamLinksFromMessage(message);
    const githubTargets = collectGithubReplyTargets(extractGithubLinksFromMessage(message));
    const githubImageUrls = extractGithubEmbedImageUrls(message);
    const twitterTargets = collectTwitterReplyTargets(extractXLinks(content));
    const youtubeTargets = this.ctx.config.YOUTUBE_PREVIEW_ENABLED
      ? collectYouTubeReplyTargets(extractYouTubeLinks(content))
      : [];
    const tiktokTargets = collectTikTokReplyTargets(extractTikTokLinks(content));
    if (
      directSteamLinks.length === 0
      && twitterTargets.length === 0
      && youtubeTargets.length === 0
      && githubTargets.length === 0
      && tiktokTargets.length === 0
    ) return;

    const youtubePlan = youtubeTargets.length > 0
      ? await prepareYouTubeLinkExpansion(message, youtubeTargets, {
        production: this.ctx.config.BOT_PROFILE === "production",
        cache: async (target) => await this.deps.cacheYouTubeVideoForPost(this.ctx, {
          videoId: target.id!,
          videoUrl: target.canonicalUrl,
        }, { attachmentSizeLimitBytes: attachmentSizeLimitForMessage(message) }),
        waitForNative: async (target) => await waitForNativeYouTubeEmbed(
          message,
          target,
          youtubeTargets.length === 1,
          this.ctx.client as unknown as { on?: (...args: unknown[]) => unknown; off?: (...args: unknown[]) => unknown },
        ),
      })
      : null;

    let githubResults: GithubPreviewBuildResult[] = [];
    if (githubTargets.length > 0) {
      try {
        githubResults = await this.deps.buildGithubReplyPayloads(githubTargets, {
          token: this.ctx.config.GITHUB_API_TOKEN,
          config: this.ctx.config,
          log: this.ctx.log,
          aiRouter: this.ctx.aiRouter,
          guildId: message.guildId ?? this.ctx.config.GUILD_ID,
          imageUrlByCanonicalUrl: githubImageUrls,
        });
      } catch (error) {
        this.ctx.log.warn({ error: String(error) }, "github preview build failed");
      }
    }

    const hasExistingPreview = directSteamLinks.length > 0
      || twitterTargets.length > 0
      || youtubeTargets.length > 0
      || tiktokTargets.length > 0;
    const hasGithubSuccess = githubResults.some((result) => result.status === "success");
    if (hasExistingPreview || hasGithubSuccess) {
      try {
        await message.suppressEmbeds(true);
      } catch {}
    }

    const nestedTwitterSteamLinks = twitterTargets.length > 0
      ? await this.deps.expandTwitterLinks(message, twitterTargets, {
        db: this.ctx.db,
        log: this.ctx.log,
        config: this.ctx.config,
        aiRouter: this.ctx.aiRouter,
        buildReplyPayloads: this.deps.buildVxTwitterReplyPayloads,
      })
      : [];
    if (tiktokTargets.length > 0) {
      // 共有キューの待ちで後続処理（AutoMod など）を止めないよう、完了を待たずに実行する
      void this.deps.expandTikTokLinks(message, tiktokTargets, {
        db: this.ctx.db,
        log: this.ctx.log,
        config: this.ctx.config,
        aiRouter: this.ctx.aiRouter,
        attachmentSizeLimitBytes: attachmentSizeLimitForMessage(message),
      }).catch((err: unknown) => {
        this.ctx.log.warn({ err: String(err), messageId: message.id }, "tiktok preview expansion failed");
      });
    }
    const nestedYouTubeSteamLinks = youtubePlan
      ? await sendYouTubeLinkExpansion(message, youtubePlan, {
        db: this.ctx.db,
        mainPgPool: this.ctx.mainPgPool,
        config: this.ctx.config,
        log: this.ctx.log,
        aiRouter: this.ctx.aiRouter,
        buildReplyPayloads: this.deps.buildYouTubeReplyPayloads,
        attachmentSizeLimitBytes: attachmentSizeLimitForMessage(message),
        saveReference: this.deps.saveYouTubeVideoCacheReference,
        mediaResolver: this.deps.mediaResolver,
        fetcher: this.deps.fetcher,
      })
      : [];
    const steamTargets = collectSteamReplyTargets([
      ...directSteamLinks,
      ...nestedTwitterSteamLinks,
      ...nestedYouTubeSteamLinks,
    ]);
    if (steamTargets.length > 0) {
      await sendSteamLinkExpansion(message, steamTargets, {
        db: this.ctx.db,
        mainPgPool: this.ctx.mainPgPool,
        config: this.ctx.config,
        log: this.ctx.log,
        aiRouter: this.ctx.aiRouter,
        buildReplyPayloads: this.deps.buildSteamReplyPayloads,
      });
    }
    if (githubResults.length > 0 && (hasExistingPreview || hasGithubSuccess)) {
      await sendGithubLinkExpansion(message, githubResults, {
        db: this.ctx.db,
        config: this.ctx.config,
        log: this.ctx.log,
        aiRouter: this.ctx.aiRouter,
      }, { includeFailures: true });
    }
  }
}

type RefreshDeps = {
  buildTwitter?: typeof buildTwitterReplyPayloads;
  buildYouTube?: typeof buildYouTubeReplyPayloads;
  buildSteam?: typeof buildSteamReplyPayloads;
  buildGithub?: typeof buildGithubReplyPayloads;
  buildTikTok?: typeof buildTikTokReplyPayloads;
};

function componentUrls(components: readonly unknown[]): string[] {
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

function componentMediaUrls(components: readonly unknown[]): string[] {
  const urls: string[] = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    const component = value as {
      items?: readonly unknown[];
      components?: readonly unknown[];
      toJSON?: () => unknown;
    };
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

export async function refreshPreviewTranslationState(
  message: Pick<Message, "id" | "components">,
  ctx: Pick<BotContext, "config" | "log" | "aiRouter"> & Partial<Pick<BotContext, "mainPgPool">>,
  guildId: string,
  channelId: string,
  deps: RefreshDeps = {},
): Promise<PreviewTranslationStateV1 | null> {
  const urls = componentUrls(message.components);
  const mediaUrl = componentMediaUrls(message.components)[0];
  for (const url of urls) {
    const steam = parseSteamUrl(url);
    if (!steam) continue;
    const [payload] = await (deps.buildSteam ?? buildSteamReplyPayloads)([steam], {
      mainPgPool: ctx.mainPgPool,
      config: ctx.config,
      log: ctx.log,
      aiRouter: ctx.aiRouter,
      guildId,
    });
    if (!payload?.previewState) return null;
    return {
      version: 1, messageId: message.id, guildId, channelId,
      sourceUrl: payload.previewState.document.url,
      ...payload.previewState,
    };
  }
  for (const url of urls) {
    const x = parseXStatusUrl(url);
    if (x) {
      const [payload] = await (deps.buildTwitter ?? buildTwitterReplyPayloads)([{
        vxUrl: x.vxUrl, screenName: x.screenName, statusId: x.id,
      }], { config: ctx.config, log: ctx.log, aiRouter: ctx.aiRouter, guildId });
      if (!payload?.previewState) return null;
      return {
        version: 1, messageId: message.id, guildId, channelId,
        sourceUrl: payload.previewState.document.url,
        ...payload.previewState,
      };
    }
  }
  for (const url of urls) {
    const youtube = parseYouTubeUrl(url);
    if (!youtube) continue;
    const [payload] = await (deps.buildYouTube ?? buildYouTubeReplyPayloads)([youtube], {
      apiKey: ctx.config.YOUTUBE_DATA_API_KEY,
      requestTimeoutMs: ctx.config.YOUTUBE_REQUEST_TIMEOUT_MS,
      componentsOnly: true,
      mediaMode: "none",
      config: ctx.config,
      log: ctx.log,
      aiRouter: ctx.aiRouter,
      guildId,
    });
    if (!payload?.previewState) return null;
    return {
      version: 1, messageId: message.id, guildId, channelId,
      sourceUrl: payload.previewState.document.url,
      ...payload.previewState,
    };
  }
  for (const url of urls) {
    const tiktok = parseTikTokUrl(url);
    if (!tiktok) continue;
    // 表示切り替えはテキストのみ差し替えるため、動画は再ダウンロードしない
    const [payload] = await (deps.buildTikTok ?? buildTikTokReplyPayloads)([tiktok], {
      attachmentSizeLimitBytes: 0,
      config: ctx.config,
      log: ctx.log,
      aiRouter: ctx.aiRouter,
      guildId,
    });
    const previewState = payload && "previewState" in payload ? payload.previewState : undefined;
    if (!previewState) return null;
    return {
      version: 1, messageId: message.id, guildId, channelId,
      sourceUrl: previewState.document.url,
      ...previewState,
    };
  }
  for (const url of urls) {
    const github = parseGithubUrl(url);
    if (!github) continue;
    const [result] = await (deps.buildGithub ?? buildGithubReplyPayloads)([github], {
      token: ctx.config.GITHUB_API_TOKEN,
      config: ctx.config,
      log: ctx.log,
      aiRouter: ctx.aiRouter,
      guildId,
      ...(mediaUrl ? { imageUrlByCanonicalUrl: new Map([[github.canonicalUrl, mediaUrl]]) } : {}),
    });
    if (!result || result.status !== "success" || !result.payload.previewState) return null;
    return {
      version: 1, messageId: message.id, guildId, channelId,
      sourceUrl: result.payload.previewState.document.url,
      ...result.payload.previewState,
    };
  }
  return null;
}
