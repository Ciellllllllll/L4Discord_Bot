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
  buildYouTubeReplyPayloads,
  prepareYouTubeLinkExpansion,
  sendYouTubeLinkExpansion,
  waitForNativeYouTubeEmbed,
  type YouTubePreviewBuildOptions,
} from "./youtube/youtubeLinkExpansion.js";
import { collectYouTubeReplyTargets, parseYouTubeUrl } from "./youtube/youtubePreviewSource.js";
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
};

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
    };
  }

  async onMessage(message: Message): Promise<void> {
    if (message.author?.bot || !message.guild || message.guild.id !== this.ctx.config.GUILD_ID) return;
    if (looksLikePrefixCommandLine(message.content)) return;
    const settings = await getGuildSettingsData(this.ctx.db, message.guild.id);
    if (settings.auto_reply_excluded_channel_ids?.includes(message.channelId)) return;

    const content = String(message.content || "");
    const twitterTargets = collectTwitterReplyTargets(extractXLinks(content));
    const youtubeTargets = this.ctx.config.YOUTUBE_PREVIEW_ENABLED
      ? collectYouTubeReplyTargets(extractYouTubeLinks(content))
      : [];
    if (twitterTargets.length === 0 && youtubeTargets.length === 0) return;

    const youtubePlan = await prepareYouTubeLinkExpansion(message, youtubeTargets, {
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
    });

    try {
      await message.suppressEmbeds(true);
    } catch {}

    await this.deps.expandTwitterLinks(message, twitterTargets, {
      db: this.ctx.db,
      log: this.ctx.log,
      config: this.ctx.config,
      aiRouter: this.ctx.aiRouter,
      buildReplyPayloads: this.deps.buildVxTwitterReplyPayloads,
    });
    await sendYouTubeLinkExpansion(message, youtubePlan, {
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
    });
  }
}

type RefreshDeps = {
  buildTwitter?: typeof buildTwitterReplyPayloads;
  buildYouTube?: typeof buildYouTubeReplyPayloads;
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

export async function refreshPreviewTranslationState(
  message: Pick<Message, "id" | "components">,
  ctx: Pick<BotContext, "config" | "log" | "aiRouter">,
  guildId: string,
  channelId: string,
  deps: RefreshDeps = {},
): Promise<PreviewTranslationStateV1 | null> {
  const urls = componentUrls(message.components);
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
  return null;
}
