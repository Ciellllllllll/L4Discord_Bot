import type { ExpansionReply } from "./shared/linkExpansionTracker.js";
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
import { collectTikTokReplyTargets, parseTikTokUrl, TIKTOK_DOMAINS } from "./tiktok/tiktokPreviewSource.js";
import { buildInstagramReplyPayloads, expandInstagramLinks } from "./instagram/instagramLinkExpansion.js";
import { collectInstagramReplyTargets, INSTAGRAM_DOMAINS, parseInstagramUrl } from "./instagram/instagramPreviewSource.js";
import { resolveYouTubeVideoMedia } from "../utilities/youtubeVideoMedia.js";
import { LateEmbedWatcher } from "./shared/lateEmbedWatcher.js";
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
const INSTAGRAM_URL_PATTERN =
  /(?<url>(?:https?:\/\/)?(?:(?:www\.|m\.)?instagram\.com|(?:www\.)?instagr\.am)\/[^\s<>\u3000]+)/gi;
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
  return extractLinks(String(content || ""), TIKTOK_URL_PATTERN, TIKTOK_DOMAINS, true);
}

export function extractInstagramLinks(content: string): string[] {
  return extractLinks(String(content || ""), INSTAGRAM_URL_PATTERN, INSTAGRAM_DOMAINS, true);
}

export function extractGithubLinks(content: string): string[] {
  return extractGithubLinksFromContent(String(content || ""));
}

function attachmentSizeLimitForMessage(message: Message): number {
  return youtubeAttachmentSizeLimitForPremiumTier(message.guild?.premiumTier);
}

/**
 * Discord の公式 Embed はメッセージ作成後に遅れて生成されることがあり、最初の抑制の後から付くと残ってしまう。
 * プレビューのカードを送った後にメッセージを API から取り直し、Embed が残っていればもう一度抑制する。
 */
export async function suppressLateEmbeds(
  message: Pick<Message, "id" | "fetch">,
  log: Pick<BotContext["log"], "warn">,
): Promise<void> {
  try {
    const latest = await message.fetch(true);
    if (latest.embeds.length > 0) await latest.suppressEmbeds(true);
  } catch (err) {
    log.warn({ err: String(err), messageId: message.id }, "late embed suppression failed");
  }
}

type LinkPreviewMessageHandlerDeps = {
  replyExpansion?: ExpansionReply;
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
  expandInstagramLinks?: typeof expandInstagramLinks;
  suppressLateEmbeds?: (message: Message) => Promise<void>;
  /** 抑制した後に遅れて付く公式 Embed を messageUpdate で監視する。null なら監視しない */
  lateEmbedWatcher?: Pick<LateEmbedWatcher, "watch" | "unwatch"> | null;
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

type MessageUpdateSource = ConstructorParameters<typeof LateEmbedWatcher>[0];

function hasMessageUpdateEvents(client: unknown): client is MessageUpdateSource {
  const candidate = client as { on?: unknown; off?: unknown } | null | undefined;
  return typeof candidate?.on === "function" && typeof candidate.off === "function";
}

export class LinkPreviewMessageHandler {
  private readonly deps: Required<LinkPreviewMessageHandlerDeps>;
  private readonly tracked: boolean;

  constructor(private readonly ctx: BotContext, deps: LinkPreviewMessageHandlerDeps = {}) {
    this.tracked = Boolean(deps.replyExpansion);
    this.deps = {
      replyExpansion: deps.replyExpansion ?? ((message, _key, payload) => message.reply(payload)),
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
      expandInstagramLinks: deps.expandInstagramLinks ?? expandInstagramLinks,
      suppressLateEmbeds: deps.suppressLateEmbeds ?? ((message) => suppressLateEmbeds(message, this.ctx.log)),
      lateEmbedWatcher: deps.lateEmbedWatcher !== undefined
        ? deps.lateEmbedWatcher
        : hasMessageUpdateEvents(ctx.client) ? new LateEmbedWatcher(ctx.client, ctx.log) : null,
    };
  }

  hasLinks(message: Message): boolean {
    if (message.author?.bot || message.guildId !== this.ctx.config.GUILD_ID || looksLikePrefixCommandLine(message.content)) return false;
    return extractSteamLinksFromMessage(message).length > 0 || extractGithubLinksFromMessage(message).length > 0
      || extractXLinks(message.content).length > 0 || extractTikTokLinks(message.content).length > 0
      || extractInstagramLinks(message.content).length > 0
      || (this.ctx.config.YOUTUBE_PREVIEW_ENABLED && extractYouTubeLinks(message.content).length > 0);
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
    const instagramTargets = collectInstagramReplyTargets(extractInstagramLinks(content));
    if (
      directSteamLinks.length === 0
      && twitterTargets.length === 0
      && youtubeTargets.length === 0
      && githubTargets.length === 0
      && tiktokTargets.length === 0
      && instagramTargets.length === 0
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
      || tiktokTargets.length > 0
      || instagramTargets.length > 0;
    const hasGithubSuccess = githubResults.some((result) => result.status === "success");
    // 最初の抑制に成功したときだけ、カードを送った後に遅れて付いた公式 Embed を確認する
    // （権限不足などで失敗したチャンネルでは、確認しても抑制できない）
    let suppressed = false;
    if (hasExistingPreview || hasGithubSuccess) {
      // 抑制との間に付いた Embed も取りこぼさないよう、抑制の前に messageUpdate の監視を始める
      this.deps.lateEmbedWatcher?.watch(message);
      try {
        await message.suppressEmbeds(true);
        suppressed = true;
      } catch {
        this.deps.lateEmbedWatcher?.unwatch(message.id);
      }
    }
    const recheckLateEmbeds = () => suppressed ? this.deps.suppressLateEmbeds(message) : Promise.resolve();

    const nestedTwitterSteamLinks = twitterTargets.length > 0
      ? await this.deps.expandTwitterLinks(message, twitterTargets, {
        db: this.ctx.db,
        replyExpansion: this.deps.replyExpansion,
        log: this.ctx.log,
        config: this.ctx.config,
        aiRouter: this.ctx.aiRouter,
        buildReplyPayloads: this.deps.buildVxTwitterReplyPayloads,
      })
      : [];
    const mediaTasks: Promise<void>[] = [];
    if (tiktokTargets.length > 0) {
      // 共有キューの待ちで後続処理（AutoMod など）を止めないよう、完了を待たずに実行する
      mediaTasks.push(this.deps.expandTikTokLinks(message, tiktokTargets, {
        db: this.ctx.db,
        replyExpansion: this.deps.replyExpansion,
        log: this.ctx.log,
        config: this.ctx.config,
        aiRouter: this.ctx.aiRouter,
        attachmentSizeLimitBytes: attachmentSizeLimitForMessage(message),
      }).then(recheckLateEmbeds).catch((err: unknown) => {
        this.ctx.log.warn({ err: String(err), messageId: message.id }, "tiktok preview expansion failed");
      }));
    }
    if (instagramTargets.length > 0) {
      // TikTok と同じ共有キューを使うため、待ちで後続処理を止めないよう完了を待たずに実行する
      mediaTasks.push(this.deps.expandInstagramLinks(message, instagramTargets, {
        db: this.ctx.db,
        replyExpansion: this.deps.replyExpansion,
        log: this.ctx.log,
        config: this.ctx.config,
        aiRouter: this.ctx.aiRouter,
        attachmentSizeLimitBytes: attachmentSizeLimitForMessage(message),
      }).then(recheckLateEmbeds).catch((err: unknown) => {
        this.ctx.log.warn({ err: String(err), messageId: message.id }, "instagram preview expansion failed");
      }));
    }
    const nestedYouTubeSteamLinks = youtubePlan
      ? await sendYouTubeLinkExpansion(message, youtubePlan, {
        db: this.ctx.db,
        replyExpansion: this.deps.replyExpansion,
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
        replyExpansion: this.deps.replyExpansion,
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
        replyExpansion: this.deps.replyExpansion,
        config: this.ctx.config,
        log: this.ctx.log,
        aiRouter: this.ctx.aiRouter,
      }, { includeFailures: true });
    }
    // カードを送り終えた後に、遅れて付いた公式 Embed が残っていないか確認する。
    // TikTok・Instagram だけのときはまだカードを送っていないので、それぞれの展開完了後に確認する
    const sentCardsHere = twitterTargets.length > 0 || youtubeTargets.length > 0 || steamTargets.length > 0 || githubResults.length > 0;
    if (sentCardsHere) await recheckLateEmbeds();
    if (this.tracked) await Promise.all(mediaTasks);
  }
}

type RefreshDeps = {
  buildTwitter?: typeof buildTwitterReplyPayloads;
  buildYouTube?: typeof buildYouTubeReplyPayloads;
  buildSteam?: typeof buildSteamReplyPayloads;
  buildGithub?: typeof buildGithubReplyPayloads;
  buildTikTok?: typeof buildTikTokReplyPayloads;
  buildInstagram?: typeof buildInstagramReplyPayloads;
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
  // 種類の判定には先頭のリンクボタン（「Xで開く」などの開くボタン）の URL だけを使う。
  // X の記事カードの「記事を開く」など2つ目のボタンが Steam などを指していても、別のプレビューとして作り直さない
  const urls = componentUrls(message.components).slice(0, 1);
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
    const instagram = parseInstagramUrl(url);
    if (!instagram) continue;
    // 表示切り替えはテキストのみ差し替えるため、メディアは再取得しない
    const [payload] = await (deps.buildInstagram ?? buildInstagramReplyPayloads)([instagram], {
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
