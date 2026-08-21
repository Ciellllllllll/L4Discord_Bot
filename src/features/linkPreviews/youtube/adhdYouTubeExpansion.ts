import {
  MessageFlags,
  type AttachmentBuilder,
  type APIEmbed,
  type APIMessageTopLevelComponent,
  type Client,
  type GuildTextBasedChannel,
  type Message,
} from "discord.js";
import type { BotContext } from "../../../bot/context.js";
import type { YouTubeFeedEntry } from "../../youtubeWatcher/youtubeRss.js";
import { youtubeVideoThumbnailUrl, type YouTubeVideoCachePostMedia } from "../../youtubeWatcher/youtubeVideoCache.service.js";
import { YOUTUBE_GOOGLEVIDEO_PENDING_PREFIX, youtubeGoogleVideoPendingError } from "../../youtubeWatcher/youtubeWatcher.repository.js";
import {
  resolveYouTubeVideoMedia,
  resolveYouTubeVideoMediaWithRetry,
} from "../../utilities/youtubeVideoMedia.js";
import type { PreviewDocument } from "../shared/previewDocument.js";
import { buildTranslatedPreview, type PreviewPipelineState } from "../shared/previewPipeline.js";
import { buildPreviewComponents, replacePreviewMedia } from "../shared/previewRenderer.js";
import { savePreviewTranslationState } from "../shared/previewState.repository.js";
import {
  translatePreviewDocument,
  type PreviewDocumentTranslations,
} from "../shared/previewTranslationGate.js";
import {
  fetchYouTubePreview,
  nativeYouTubeEmbedToDocument,
  youTubePreviewToDocument,
  youTubeRssEntryToDocument,
  type YouTubePreviewResult,
  type YouTubeReplyTarget,
} from "./youtubePreviewSource.js";
import { addYouTubeMediaRefreshButton } from "./youtubeMediaRefresh.js";
import {
  downloadYouTubeMediaAttachment,
  youtubeAttachmentSizeLimitForPremiumTier,
  type YouTubeMediaAttachmentOptions,
} from "./youtubeMediaAttachment.js";

const NATIVE_EMBED_WAIT_MS = 3_000;

export type YouTubeWatcherPostMedia = YouTubeVideoCachePostMedia;
export type YouTubeWatcherNotificationPayload = {
  embeds: [];
  flags: MessageFlags.IsComponentsV2;
  components: APIMessageTopLevelComponent[];
  allowedMentions: { parse: never[] };
  files?: AttachmentBuilder[];
};
export type YouTubeWatcherNotificationResult = {
  message: Message;
  media?: YouTubeWatcherPostMedia;
};
export type PreparedAdhdYouTubeNotification = {
  document: PreviewDocument;
  translations: PreviewDocumentTranslations;
  state?: PreviewPipelineState;
  media?: YouTubeWatcherPostMedia;
  firstPayload: YouTubeWatcherNotificationPayload;
  retryPayload: YouTubeWatcherNotificationPayload;
};

type PrepareContext = Pick<BotContext, "client" | "config" | "log"> & Partial<Pick<BotContext, "aiRouter">>;
type PrepareDeps = {
  cacheForPost?: (entry: YouTubeFeedEntry, mediaResolver: typeof resolveYouTubeVideoMedia) => Promise<YouTubeWatcherPostMedia>;
  probeNative?: (target: GuildTextBasedChannel, entry: YouTubeFeedEntry, client: Client) => Promise<APIEmbed | null>;
  fetchPreview?: (target: YouTubeReplyTarget) => Promise<YouTubePreviewResult>;
  translate?: (document: PreviewDocument) => Promise<PreviewDocumentTranslations>;
  mediaResolver?: typeof resolveYouTubeVideoMedia;
  fetcher?: YouTubeMediaAttachmentOptions["fetcher"];
  attachmentSizeLimitBytes?: number;
};

function isGoogleVideoUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    return parsed.protocol === "https:" && (host === "googlevideo.com" || host.endsWith(".googlevideo.com"));
  } catch { return false; }
}

async function resolveAdhdMedia(
  ctx: PrepareContext,
  entry: YouTubeFeedEntry,
  cached: YouTubeWatcherPostMedia | undefined,
  resolver: typeof resolveYouTubeVideoMedia,
  attachmentSizeLimitBytes: number,
): Promise<YouTubeWatcherPostMedia | undefined> {
  if ((cached?.mediaMode === "vps" || cached?.mediaMode === "google") && cached.mediaUrl) return cached;
  if (cached?.mediaMode === "none" && cached.lastError?.startsWith(YOUTUBE_GOOGLEVIDEO_PENDING_PREFIX)) return cached;
  try {
    const resolved = await resolveYouTubeVideoMediaWithRetry(entry.videoUrl, {
      timeoutMs: ctx.config.YOUTUBE_REQUEST_TIMEOUT_MS,
      maxBytes: attachmentSizeLimitBytes,
    }, { resolver });
    if (resolved.status === "ok" && isGoogleVideoUrl(resolved.mediaUrl)) {
      return { mediaMode: "google", mediaUrl: resolved.mediaUrl, lastError: cached?.lastError ?? null };
    }
    return {
      mediaMode: "none",
      lastError: youtubeGoogleVideoPendingError(resolved.status === "fallback" ? resolved.reason : "invalid_google_url"),
    };
  } catch (error) {
    ctx.log.warn({ err: error, videoId: entry.videoId }, "youtube watcher fallback media resolution failed");
    return { mediaMode: "none", lastError: youtubeGoogleVideoPendingError("inner_tube_error") };
  }
}

function toApiEmbed(value: unknown): APIEmbed | null {
  if (!value || typeof value !== "object") return null;
  const object = value as { toJSON?: () => unknown };
  const json = typeof object.toJSON === "function" ? object.toJSON() : value;
  return json && typeof json === "object" ? json as APIEmbed : null;
}

function nativeEmbedFromMessage(message: Pick<Message, "embeds">): APIEmbed | null {
  for (const value of message.embeds) {
    const embed = toApiEmbed(value);
    if (embed?.type === "video" || embed?.video) return embed;
  }
  return null;
}

export async function probeYouTubeNativeEmbed(
  target: GuildTextBasedChannel,
  entry: YouTubeFeedEntry,
  client: Client,
): Promise<APIEmbed | null> {
  const probe = await target.send({ content: entry.videoUrl, allowedMentions: { parse: [] } });
  try {
    const immediate = nativeEmbedFromMessage(probe);
    if (immediate) return immediate;
    const events = client as unknown as {
      on?: (event: string, listener: (oldMessage: unknown, newMessage: unknown) => void) => unknown;
      off?: (event: string, listener: (oldMessage: unknown, newMessage: unknown) => void) => unknown;
    };
    if (!events.on || !events.off) return null;
    return await new Promise<APIEmbed | null>((resolve) => {
      let settled = false;
      const finish = (embed: APIEmbed | null): void => {
        if (settled) return;
        settled = true;
        timeout.removeEventListener("abort", onTimeout);
        events.off?.("messageUpdate", onUpdate);
        resolve(embed);
      };
      const onTimeout = (): void => finish(null);
      const onUpdate = (_oldMessage: unknown, newMessage: unknown): void => {
        if (!newMessage || typeof newMessage !== "object" || (newMessage as { id?: string }).id !== probe.id) return;
        const embed = nativeEmbedFromMessage(newMessage as Pick<Message, "embeds">);
        if (embed) finish(embed);
      };
      const timeout = AbortSignal.timeout(NATIVE_EMBED_WAIT_MS);
      timeout.addEventListener("abort", onTimeout, { once: true });
      events.on?.("messageUpdate", onUpdate);
    });
  } finally {
    await probe.delete().catch(() => undefined);
  }
}

function translatedValue(document: PreviewDocument | undefined, key: string): string | undefined {
  if (!document) return undefined;
  for (const block of document.blocks) {
    if (block.type !== "text") continue;
    for (const line of block.lines) {
      const part = line.parts.find((candidate) => candidate.translationKey === key);
      if (part?.text.trim()) return part.text;
    }
  }
  return undefined;
}

function firstMediaUrl(document: PreviewDocument | undefined): string | null | undefined {
  return document?.blocks.find((block) => block.type === "media")?.items[0]?.url;
}

function watcherDocument(
  entry: YouTubeFeedEntry,
  source?: PreviewDocument,
  useSourceTitle = true,
): PreviewDocument {
  return youTubeRssEntryToDocument({
    ...entry,
    title: (useSourceTitle ? translatedValue(source, "title") : undefined) ?? entry.title,
    description: translatedValue(source, "description"),
    thumbnailUrl: firstMediaUrl(source) ?? entry.thumbnailUrl ?? youtubeVideoThumbnailUrl(entry.videoId),
  });
}

function payload(
  document: PreviewDocument,
  translations: PreviewDocumentTranslations,
  media: { replace: boolean; url?: string; fallback?: boolean; files?: AttachmentBuilder[] },
): YouTubeWatcherNotificationPayload {
  const rendered = buildPreviewComponents(document, translations);
  const withMedia = media.replace
    ? replacePreviewMedia(rendered, media.url, { fallback: media.fallback, description: "YouTube video" })
    : rendered;
  return {
    embeds: [],
    flags: MessageFlags.IsComponentsV2,
    components: addYouTubeMediaRefreshButton(withMedia),
    allowedMentions: { parse: [] },
    ...(media.files?.length && !media.fallback ? { files: media.files } : {}),
  };
}

type MediaRendering = {
  replace: boolean;
  url?: string;
  fallback?: boolean;
  files?: AttachmentBuilder[];
  persistedMedia?: YouTubeWatcherPostMedia;
};

async function mediaRendering(
  media: YouTubeWatcherPostMedia | undefined,
  options: Pick<PrepareDeps, "fetcher" | "attachmentSizeLimitBytes">,
): Promise<MediaRendering> {
  if (media?.mediaMode === "vps" && media.mediaUrl) return { replace: true, url: media.mediaUrl };
  if (media?.mediaMode === "google" && media.mediaUrl) {
    const attachment = await downloadYouTubeMediaAttachment(media.mediaUrl, {
      fetcher: options.fetcher,
      attachmentSizeLimitBytes: options.attachmentSizeLimitBytes,
    });
    if (attachment) {
      return {
        replace: true,
        url: attachment.mediaUrl,
        files: attachment.files,
        persistedMedia: media,
      };
    }
    return {
      replace: true,
      fallback: true,
      persistedMedia: {
        mediaMode: "none",
        lastError: youtubeGoogleVideoPendingError("attachment_unavailable"),
      },
    };
  }
  if (media?.mediaMode === "none") return { replace: true, fallback: true };
  return { replace: false };
}

export async function prepareAdhdYouTubeNotification(
  ctx: PrepareContext,
  target: GuildTextBasedChannel,
  entry: YouTubeFeedEntry,
  deps: PrepareDeps = {},
): Promise<PreparedAdhdYouTubeNotification> {
  const baseMediaResolver = deps.mediaResolver ?? resolveYouTubeVideoMedia;
  const cachedMedia = await deps.cacheForPost?.(entry, baseMediaResolver);
  const attachmentSizeLimitBytes = deps.attachmentSizeLimitBytes
    ?? youtubeAttachmentSizeLimitForPremiumTier(target.guild?.premiumTier);
  const media = await resolveAdhdMedia(ctx, entry, cachedMedia, baseMediaResolver, attachmentSizeLimitBytes);
  let nativeEmbed: APIEmbed | null = null;
  try {
    nativeEmbed = await (deps.probeNative ?? probeYouTubeNativeEmbed)(target, entry, ctx.client);
  } catch (error) {
    ctx.log.warn({ err: error, videoId: entry.videoId }, "youtube native embed probe failed");
  }

  let source: PreviewDocument | undefined;
  let useSourceTitle = true;
  if (nativeEmbed) {
    source = nativeYouTubeEmbedToDocument(nativeEmbed, entry.videoUrl);
    useSourceTitle = Boolean(nativeEmbed.title?.trim());
  } else {
    const targetValue: YouTubeReplyTarget = {
      kind: "video",
      originalUrl: entry.videoUrl,
      canonicalUrl: entry.videoUrl,
      id: entry.videoId,
    };
    try {
      const fetched = await (deps.fetchPreview ?? ((candidate) => fetchYouTubePreview(candidate, {
        apiKey: ctx.config.YOUTUBE_DATA_API_KEY,
        requestTimeoutMs: ctx.config.YOUTUBE_REQUEST_TIMEOUT_MS,
      })))(targetValue);
      if (fetched.status === "ok") source = youTubePreviewToDocument(fetched.preview);
    } catch (error) {
      ctx.log.warn({ err: error, videoId: entry.videoId }, "youtube watcher metadata fetch failed");
    }
  }
  const document = watcherDocument(entry, source, useSourceTitle);
  const built = await buildTranslatedPreview(document, {
    translate: deps.translate ?? ((candidate) => translatePreviewDocument(candidate, {
      config: ctx.config,
      log: ctx.log,
      router: ctx.aiRouter,
      guildId: target.guildId ?? ctx.config.GUILD_ID,
    })),
  });
  const translations = built.state?.translations ?? { translations: {} };
  const renderedMedia = await mediaRendering(media, { ...deps, attachmentSizeLimitBytes });
  return {
    document,
    translations,
    ...(built.state ? { state: built.state } : {}),
    ...(renderedMedia.persistedMedia ? { media: renderedMedia.persistedMedia } : media ? { media } : {}),
    firstPayload: payload(document, translations, renderedMedia),
    retryPayload: payload(document, translations, renderedMedia),
  };
}

type SendContext = Pick<BotContext, "client" | "config" | "log"> & Partial<Pick<BotContext, "db">>;
type SendDeps = {
  prepare?: typeof prepareAdhdYouTubeNotification;
  cacheForPost?: PrepareDeps["cacheForPost"];
  saveState?: typeof savePreviewTranslationState;
  probeNative?: PrepareDeps["probeNative"];
  fetchPreview?: PrepareDeps["fetchPreview"];
  translate?: PrepareDeps["translate"];
  mediaResolver?: PrepareDeps["mediaResolver"];
  fetcher?: PrepareDeps["fetcher"];
  attachmentSizeLimitBytes?: PrepareDeps["attachmentSizeLimitBytes"];
};

export async function sendYouTubeWatcherNotification(
  ctx: SendContext,
  target: GuildTextBasedChannel,
  entry: YouTubeFeedEntry,
  deps: SendDeps = {},
): Promise<YouTubeWatcherNotificationResult> {
  const prepare = deps.prepare ?? prepareAdhdYouTubeNotification;
  const prepared = await prepare(ctx, target, entry, {
    cacheForPost: deps.cacheForPost,
    probeNative: deps.probeNative,
    fetchPreview: deps.fetchPreview,
    translate: deps.translate,
    mediaResolver: deps.mediaResolver,
    fetcher: deps.fetcher,
    attachmentSizeLimitBytes: deps.attachmentSizeLimitBytes,
  });
  let message: Message;
  try {
    message = await target.send(prepared.firstPayload);
  } catch (error) {
    ctx.log.warn({ err: error, videoId: entry.videoId }, "youtube native notification send failed; retrying prepared payload");
    message = await target.send(prepared.retryPayload);
  }
  const guildId = target.guildId ?? ctx.config.GUILD_ID;
  if (prepared.state && ctx.db && guildId) {
    try {
      await (deps.saveState ?? savePreviewTranslationState)(ctx.db, {
        version: 1,
        messageId: message.id,
        guildId,
        channelId: target.id,
        sourceUrl: prepared.state.document.url,
        ...prepared.state,
      });
    } catch (error) {
      ctx.log.warn({ err: error, messageId: message.id }, "youtube watcher preview state save failed");
    }
  }
  return { message, media: prepared.media };
}
