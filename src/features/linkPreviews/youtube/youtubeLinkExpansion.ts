import {
  AttachmentBuilder,
  MessageFlags,
  type APIEmbed,
  type APIMessageTopLevelComponent,
  type Message,
  type MessageCreateOptions,
} from "discord.js";
import type { BotContext } from "../../../bot/context.js";
import type { AppConfig } from "../../../core/config.js";
import type { AiProviderRouter } from "../../ai/aiProviderRouter.js";
import { PostgresYouTubeWatcherRepository } from "../../youtubeWatcher/youtubeWatcher.repository.js";
import type {
  saveYouTubeVideoCacheReferenceForPost,
  YouTubeVideoCachePostMedia,
} from "../../youtubeWatcher/youtubeVideoCache.service.js";
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
  getYouTubeNativeEmbedVideoUrl,
  nativeYouTubeEmbedToDocument,
  parseYouTubeUrl,
  safeYouTubeHttpsUrl,
  youTubePreviewToDocument,
  type YouTubePreview,
  type YouTubeReplyTarget,
  type YouTubeSourceFetchOptions,
} from "./youtubePreviewSource.js";
import { addYouTubeMediaRefreshButton } from "./youtubeMediaRefresh.js";
import {
  DEFAULT_YOUTUBE_MEDIA_ATTACHMENT_MAX_BYTES,
  downloadYouTubeMediaAttachment,
  YOUTUBE_MEDIA_ATTACHMENT_FILENAME,
} from "./youtubeMediaAttachment.js";

const NATIVE_EMBED_WAIT_MS = 3_000;

type LoggerLike = { warn: (...args: unknown[]) => void };

export type YouTubePreviewPayload = {
  embeds: [];
  flags: MessageFlags.IsComponentsV2;
  components: APIMessageTopLevelComponent[];
  allowedMentions: { parse: []; repliedUser: false };
  files?: AttachmentBuilder[];
  previewState?: PreviewPipelineState;
  resolvedMedia?: ResolvedMedia;
  mediaResolutionError?: string;
};
export type YouTubeReplyPayload = MessageCreateOptions & { previewState?: PreviewPipelineState };

export type YouTubePreviewBuildOptions = YouTubeSourceFetchOptions & {
  attachmentSizeLimitBytes?: number;
  componentsOnly?: boolean;
  mediaResolver?: typeof resolveYouTubeVideoMedia;
  mediaUrlOverride?: string;
  mediaMode?: "vps" | "google" | "none";
  log?: { warn?: (...args: unknown[]) => void };
  config?: Pick<AppConfig, "DEEPSEEK_API_KEY"> & Partial<AppConfig>;
  aiRouter?: AiProviderRouter;
  guildId?: string;
  translate?: (document: PreviewDocument) => Promise<PreviewDocumentTranslations>;
};

export type YouTubePreviewPayloadOptions = {
  mediaUrl?: string;
  files?: AttachmentBuilder[];
  fallback?: boolean;
  mediaMode?: "vps" | "google" | "none";
};

function isGoogleVideoUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === "googlevideo.com" || host.endsWith(".googlevideo.com");
  } catch { return false; }
}

function safeMediaUrl(value: unknown): string | undefined {
  if (value === `attachment://${YOUTUBE_MEDIA_ATTACHMENT_FILENAME}`) return value;
  return safeYouTubeHttpsUrl(value);
}

function selectedMediaUrl(options: YouTubePreviewPayloadOptions): string | undefined {
  if (options.mediaMode === "none") return undefined;
  const media = safeMediaUrl(options.mediaUrl);
  if (!media) return undefined;
  if (options.mediaMode === "google") return media.startsWith("attachment://") ? media : undefined;
  return media;
}

export function replaceYouTubePreviewMedia(
  components: readonly unknown[],
  mediaUrl?: string,
  options: { fallback?: boolean } = {},
): APIMessageTopLevelComponent[] {
  return replacePreviewMedia(components, mediaUrl, {
    ...options,
    description: "YouTube video",
  });
}

function payloadFromDocument(
  document: PreviewDocument,
  translations: PreviewDocumentTranslations,
  options: YouTubePreviewPayloadOptions = {},
  state?: PreviewPipelineState,
): YouTubePreviewPayload {
  const components = buildPreviewComponents(document, translations);
  const mediaUrl = options.fallback ? selectedMediaUrl(options) : safeMediaUrl(options.mediaUrl);
  const replaced = mediaUrl !== undefined || options.fallback
    ? replaceYouTubePreviewMedia(components, mediaUrl, { fallback: options.fallback })
    : components;
  return {
    embeds: [], flags: MessageFlags.IsComponentsV2, components: addYouTubeMediaRefreshButton(replaced),
    allowedMentions: { parse: [], repliedUser: false },
    ...(options.files?.length && !options.fallback ? { files: options.files } : {}),
    ...(state ? { previewState: state } : {}),
  };
}

export function buildYouTubePreviewPayload(preview: YouTubePreview, options: YouTubePreviewPayloadOptions = {}): YouTubePreviewPayload {
  return payloadFromDocument(youTubePreviewToDocument(preview), { translations: {} }, options);
}

export function buildYouTubeFallbackReply(urls: readonly string[]): MessageCreateOptions {
  return { content: urls.join("\n"), allowedMentions: { parse: [], repliedUser: false } };
}

export function buildYouTubeComponentsOnlyFallbackPayload(url: string): YouTubePreviewPayload {
  return payloadFromDocument({
    version: 1, source: "youtube", url: safeYouTubeHttpsUrl(url) ?? "https://www.youtube.com", openLabel: "YouTubeで開く",
    blocks: [{ type: "text", id: "body", lines: [
      { parts: [{ text: "YouTube動画", strong: true }] },
      { parts: [{ text: "動画プレビューを取得できませんでした。ボタンからYouTubeで開けます。" }] },
    ] }],
  }, { translations: {} });
}

type ResolvedMedia = { mediaUrl: string; files?: AttachmentBuilder[]; sourceUrl?: string };
type MediaResolution = { media?: ResolvedMedia; failureReason?: string };
async function downloadAttachment(mediaUrl: string, options: YouTubePreviewBuildOptions): Promise<ResolvedMedia | undefined> {
  const attachment = await downloadYouTubeMediaAttachment(mediaUrl, {
    fetcher: options.fetcher,
    requestTimeoutMs: options.requestTimeoutMs,
    attachmentSizeLimitBytes: options.attachmentSizeLimitBytes ?? DEFAULT_YOUTUBE_MEDIA_ATTACHMENT_MAX_BYTES,
  });
  return attachment ? { ...attachment, sourceUrl: mediaUrl } : undefined;
}

async function resolveMedia(target: YouTubeReplyTarget, options: YouTubePreviewBuildOptions): Promise<MediaResolution> {
  if (target.kind !== "video") return {};
  const override = safeMediaUrl(options.mediaUrlOverride);
  if (override) return { media: { mediaUrl: override } };
  try {
    const resolved = await resolveYouTubeVideoMediaWithRetry(target.canonicalUrl, {
      timeoutMs: options.requestTimeoutMs, maxBytes: options.attachmentSizeLimitBytes,
    }, { resolver: options.mediaResolver });
    if (resolved.status !== "ok") return { failureReason: resolved.reason };
    const media = await downloadAttachment(resolved.mediaUrl, options);
    return media ? { media } : { failureReason: "attachment_unavailable" };
  } catch (error) {
    options.log?.warn?.({ error, url: target.canonicalUrl }, "youtube preview media resolver error");
    return { failureReason: "inner_tube_error" };
  }
}

async function translateDocument(document: PreviewDocument, options: YouTubePreviewBuildOptions): Promise<PreviewDocumentTranslations> {
  try {
    if (options.translate) return await options.translate(document);
    if (!options.config) return { translations: {} };
    return await translatePreviewDocument(document, {
      config: options.config, log: options.log as never, router: options.aiRouter, guildId: options.guildId,
    });
  } catch (error) {
    options.log?.warn?.({ error }, "youtube preview translation skipped");
    return { translations: {} };
  }
}

async function buildDocumentPayload(
  document: PreviewDocument,
  options: YouTubePreviewBuildOptions,
  resolution: MediaResolution = {},
): Promise<YouTubePreviewPayload> {
  const built = await buildTranslatedPreview(document, { translate: async () => await translateDocument(document, options) });
  const override = options.mediaMode === "none" ? undefined : safeMediaUrl(options.mediaUrlOverride);
  const requestedMedia = options.mediaMode
    ? (options.mediaMode === "google" && override && !isGoogleVideoUrl(override)
      ? undefined
      : override ? { mediaUrl: override } : undefined)
    : resolution.media;
  let media = requestedMedia;
  let failureReason = resolution.failureReason;
  if (
    media
    && !media.files?.length
    && !media.mediaUrl.startsWith(`attachment://`)
    && (options.mediaMode === "google" || isGoogleVideoUrl(media.mediaUrl))
  ) {
    media = await downloadAttachment(media.mediaUrl, options);
    if (!media) failureReason ??= "attachment_unavailable";
  }
  const fallback = Boolean(options.mediaMode || failureReason || requestedMedia) && !media;
  const payload = payloadFromDocument(document, built.state?.translations ?? { translations: {} }, {
    mediaUrl: media?.mediaUrl,
    files: media?.files,
    ...(fallback ? { fallback: true } : {}),
  }, built.state);
  return {
    ...payload,
    ...(media ? { resolvedMedia: media } : {}),
    ...(failureReason ? { mediaResolutionError: failureReason } : {}),
  };
}

export async function buildYouTubeReplyPayloads(
  targets: readonly YouTubeReplyTarget[],
  options: YouTubePreviewBuildOptions = {},
): Promise<YouTubeReplyPayload[]> {
  return await Promise.all(targets.map(async (target) => {
    if (target.kind === "fallback") return options.componentsOnly
      ? buildYouTubeComponentsOnlyFallbackPayload(target.canonicalUrl)
      : buildYouTubeFallbackReply([target.canonicalUrl]);
    const result = await fetchYouTubePreview(target, options);
    if (result.status !== "ok") return options.componentsOnly
      ? buildYouTubeComponentsOnlyFallbackPayload(target.canonicalUrl)
      : buildYouTubeFallbackReply([target.canonicalUrl]);
    const document = youTubePreviewToDocument(result.preview);
    const resolution = options.mediaMode || !["video", "oembed"].includes(result.preview.kind)
      ? {}
      : await resolveMedia(target, options);
    return await buildDocumentPayload(document, options, resolution);
  }));
}

function toApiEmbed(value: unknown): APIEmbed | null {
  if (!value || typeof value !== "object") return null;
  const toJSON = (value as { toJSON?: () => unknown }).toJSON;
  const json = typeof toJSON === "function" ? toJSON.call(value) : value;
  return json && typeof json === "object" ? json as APIEmbed : null;
}

function nativeEmbedForTarget(message: Message, target: YouTubeReplyTarget, allowUrlless: boolean): APIEmbed | null {
  for (const raw of message.embeds ?? []) {
    const embed = toApiEmbed(raw);
    if (!embed) continue;
    const parsed = embed.url ? parseYouTubeUrl(embed.url) : null;
    if (parsed?.canonicalUrl === target.canonicalUrl || (allowUrlless && !embed.url && embed.type === "video")) return embed;
  }
  return null;
}

export async function waitForNativeYouTubeEmbed(
  message: Message,
  target: YouTubeReplyTarget,
  allowUrlless: boolean,
  clientOverride?: { on?: (...args: unknown[]) => unknown; off?: (...args: unknown[]) => unknown },
): Promise<APIEmbed | null> {
  const existing = nativeEmbedForTarget(message, target, allowUrlless);
  if (existing) return existing;
  const client = clientOverride ?? (message.client ?? null) as unknown as { on?: (...args: unknown[]) => unknown; off?: (...args: unknown[]) => unknown } | null;
  if (!client?.on || !client.off) return null;
  return await new Promise((resolve) => {
    let done = false;
    const finish = (embed: APIEmbed | null): void => {
      if (done) return; done = true; timeout.removeEventListener("abort", onTimeout); client.off?.("messageUpdate", onUpdate); resolve(embed);
    };
    const onTimeout = (): void => finish(null);
    const onUpdate = (_old: unknown, next: unknown): void => {
      if (!next || typeof next !== "object" || (next as { id?: string }).id !== message.id) return;
      const embed = nativeEmbedForTarget(next as Message, target, allowUrlless);
      if (embed) finish(embed);
    };
    const timeout = AbortSignal.timeout(NATIVE_EMBED_WAIT_MS);
    timeout.addEventListener("abort", onTimeout, { once: true });
    client.on?.("messageUpdate", onUpdate);
  });
}

export type PreparedYouTubeExpansionItem = {
  target: YouTubeReplyTarget;
  nativeEmbed: APIEmbed | null;
  media?: YouTubeVideoCachePostMedia;
};
export type PreparedYouTubeLinkExpansion = { items: PreparedYouTubeExpansionItem[] };

export async function prepareYouTubeLinkExpansion(
  message: Message,
  targets: readonly YouTubeReplyTarget[],
  deps: {
    production: boolean;
    cache?: (target: YouTubeReplyTarget) => Promise<YouTubeVideoCachePostMedia>;
    waitForNative?: (target: YouTubeReplyTarget) => Promise<APIEmbed | null>;
  },
): Promise<PreparedYouTubeLinkExpansion> {
  const media = new Map<string, YouTubeVideoCachePostMedia>();
  if (deps.production && deps.cache) {
    for (const target of targets) {
      if (target.kind !== "video" || !target.id) continue;
      try { media.set(target.canonicalUrl, await deps.cache(target)); }
      catch { media.set(target.canonicalUrl, { mediaMode: "none", lastError: "cache_post_error" }); }
    }
  }
  const native = new Map<string, APIEmbed | null>();
  await Promise.all(targets.map(async (target) => native.set(target.canonicalUrl,
    await (deps.waitForNative?.(target) ?? waitForNativeYouTubeEmbed(message, target, targets.length === 1)))));
  return { items: targets.map((target) => ({ target, nativeEmbed: native.get(target.canonicalUrl) ?? null, ...(media.has(target.canonicalUrl) ? { media: media.get(target.canonicalUrl)! } : {}) })) };
}

export type SendYouTubeExpansionDeps = {
  db: BotContext["db"];
  mainPgPool?: BotContext["mainPgPool"];
  config: AppConfig;
  log: LoggerLike;
  aiRouter?: AiProviderRouter;
  translate?: (document: PreviewDocument) => Promise<PreviewDocumentTranslations>;
  buildReplyPayloads?: typeof buildYouTubeReplyPayloads;
  mediaResolver?: YouTubePreviewBuildOptions["mediaResolver"];
  fetcher?: YouTubePreviewBuildOptions["fetcher"];
  attachmentSizeLimitBytes?: number;
  saveState?: typeof savePreviewTranslationState;
  saveReference?: typeof saveYouTubeVideoCacheReferenceForPost;
  cacheReferenceRepo?: PostgresYouTubeWatcherRepository;
  createCacheReferenceRepo?: () => PostgresYouTubeWatcherRepository;
};

export async function sendYouTubeLinkExpansion(
  message: Message,
  plan: PreparedYouTubeLinkExpansion,
  deps: SendYouTubeExpansionDeps,
): Promise<void> {
  for (const item of plan.items) {
    try {
      const useNative = item.nativeEmbed !== null;
      const usableCachedMedia = item.media?.mediaMode === "vps" || item.media?.mediaMode === "google"
        ? item.media
        : undefined;
      let finalFallbackMedia: ResolvedMedia | undefined;
      let finalFallbackReason: string | undefined;
      let finalFallbackAttempted = false;
      const resolveFinalFallback = async (): Promise<ResolvedMedia | undefined> => {
        if (finalFallbackAttempted) return finalFallbackMedia;
        finalFallbackAttempted = true;
        const resolution = await resolveMedia(item.target, {
          requestTimeoutMs: deps.config.YOUTUBE_REQUEST_TIMEOUT_MS,
          attachmentSizeLimitBytes: deps.attachmentSizeLimitBytes,
          log: deps.log,
          ...(deps.mediaResolver ? { mediaResolver: deps.mediaResolver } : {}),
          ...(deps.fetcher ? { fetcher: deps.fetcher } : {}),
        });
        finalFallbackMedia = resolution.media;
        finalFallbackReason = resolution.failureReason;
        return finalFallbackMedia;
      };
      let payload: YouTubePreviewPayload;
      if (item.media?.mediaMode === "none" && item.media.lastError?.startsWith(YOUTUBE_GOOGLEVIDEO_PENDING_PREFIX)) {
        finalFallbackAttempted = true;
        finalFallbackReason = item.media.lastError.slice(YOUTUBE_GOOGLEVIDEO_PENDING_PREFIX.length);
      }
      if (useNative) {
        const preferredMediaUrl = usableCachedMedia?.mediaUrl ?? getYouTubeNativeEmbedVideoUrl(item.nativeEmbed!);
        const selectedResolution: MediaResolution = preferredMediaUrl
          ? { media: { mediaUrl: preferredMediaUrl } }
          : finalFallbackAttempted
            ? { failureReason: finalFallbackReason }
            : await resolveFinalFallback().then((media) => media ? { media } : { failureReason: finalFallbackReason });
        payload = await buildDocumentPayload(nativeYouTubeEmbedToDocument(item.nativeEmbed!, item.target.canonicalUrl), {
          config: deps.config, aiRouter: deps.aiRouter, guildId: message.guildId ?? deps.config.GUILD_ID,
          log: deps.log, translate: deps.translate,
          attachmentSizeLimitBytes: deps.attachmentSizeLimitBytes,
          ...(deps.fetcher ? { fetcher: deps.fetcher } : {}),
          ...(usableCachedMedia ? { mediaMode: usableCachedMedia.mediaMode, mediaUrlOverride: usableCachedMedia.mediaUrl } : {}),
        }, selectedResolution);
      } else {
        const [built] = await (deps.buildReplyPayloads ?? buildYouTubeReplyPayloads)([item.target], {
          apiKey: deps.config.YOUTUBE_DATA_API_KEY, requestTimeoutMs: deps.config.YOUTUBE_REQUEST_TIMEOUT_MS,
          componentsOnly: true,
          attachmentSizeLimitBytes: deps.attachmentSizeLimitBytes,
          config: deps.config, aiRouter: deps.aiRouter, guildId: message.guildId ?? deps.config.GUILD_ID,
          log: deps.log, translate: deps.translate,
          ...(deps.mediaResolver ? { mediaResolver: deps.mediaResolver } : {}),
          ...(deps.fetcher ? { fetcher: deps.fetcher } : {}),
          ...(usableCachedMedia
            ? { mediaMode: usableCachedMedia.mediaMode, mediaUrlOverride: usableCachedMedia.mediaUrl }
            : finalFallbackAttempted ? { mediaMode: "none" as const } : {}),
        });
        payload = built && (built as { flags?: number }).flags === MessageFlags.IsComponentsV2
          ? built as YouTubePreviewPayload
          : buildYouTubeComponentsOnlyFallbackPayload(item.target.canonicalUrl);
      }
      if (
        item.target.kind === "video"
        && !finalFallbackAttempted
        && (!payload.resolvedMedia || Boolean(payload.mediaResolutionError))
      ) {
        const resolvedMedia = await resolveFinalFallback();
        if (resolvedMedia) {
          const { mediaResolutionError: _mediaError, ...payloadWithoutError } = payload;
          payload = {
            ...payloadWithoutError,
            components: replaceYouTubePreviewMedia(payload.components, resolvedMedia.mediaUrl),
            files: resolvedMedia.files ?? [],
            resolvedMedia,
          };
        } else if (payload.mediaResolutionError) {
          payload = {
            ...payload,
            components: replaceYouTubePreviewMedia(payload.components, undefined, { fallback: true }),
            files: [],
          };
        }
      }
      const previewState = payload.previewState;
      const payloadResolvedMedia = payload.resolvedMedia;
      if (payload.mediaResolutionError) {
        finalFallbackAttempted = true;
        finalFallbackReason = payload.mediaResolutionError;
      }
      let pendingMedia: YouTubeVideoCachePostMedia | undefined = finalFallbackReason
        ? { mediaMode: "none", lastError: youtubeGoogleVideoPendingError(finalFallbackReason) }
        : undefined;
      const { previewState: _state, resolvedMedia: _resolvedMedia, mediaResolutionError: _mediaError, ...baseSendPayload } = payload;
      const sendPayload = pendingMedia
        ? { ...baseSendPayload, components: replaceYouTubePreviewMedia(baseSendPayload.components, undefined, { fallback: true }), files: [] }
        : baseSendPayload;
      let reply;
      try { reply = await message.reply(sendPayload); }
      catch (error) {
        if (!useNative) throw error;
        deps.log.warn({ error }, "youtube preview reply error; retrying without native media");
        const retryMedia = usableCachedMedia?.mediaMode === "vps"
          ? undefined
          : await resolveFinalFallback();
        reply = await message.reply({
          ...sendPayload,
          components: replaceYouTubePreviewMedia(
            sendPayload.components,
            retryMedia?.mediaUrl,
            { fallback: !retryMedia },
          ),
          files: retryMedia?.files ?? [],
        });
        if (!retryMedia) {
          pendingMedia = { mediaMode: "none", lastError: youtubeGoogleVideoPendingError(finalFallbackReason ?? "discord_send_error") };
        }
      }
      if (previewState && message.guildId) {
        try {
          await (deps.saveState ?? savePreviewTranslationState)(deps.db, {
            version: 1, messageId: reply.id, guildId: message.guildId, channelId: message.channelId,
            sourceUrl: previewState.document.url, ...previewState,
          });
        } catch (error) { deps.log.warn({ error, messageId: reply.id }, "youtube preview state save failed"); }
      }
      if ((item.media || pendingMedia) && item.target.kind === "video" && item.target.id) {
        try {
          if (!deps.saveReference) throw new Error("youtube cache reference saver is not configured");
          const resolvedDisplayMedia = finalFallbackMedia ?? payloadResolvedMedia;
          const displayedMedia: YouTubeVideoCachePostMedia = pendingMedia ?? usableCachedMedia ?? (resolvedDisplayMedia?.sourceUrl && isGoogleVideoUrl(resolvedDisplayMedia.sourceUrl)
            ? { mediaMode: "google", mediaUrl: resolvedDisplayMedia.sourceUrl, lastError: null }
            : item.media!);
          const repo = deps.cacheReferenceRepo
            ?? deps.createCacheReferenceRepo?.()
            ?? new PostgresYouTubeWatcherRepository(deps.mainPgPool!);
          await deps.saveReference(deps as never, repo, {
            guildId: message.guildId ?? deps.config.GUILD_ID, channelId: message.channelId,
          }, { videoId: item.target.id, videoUrl: item.target.canonicalUrl }, { message: reply as never, media: displayedMedia });
        } catch (error) { deps.log.warn({ error, messageId: reply.id }, "youtube video cache reference save failed"); }
      }
    } catch (error) { deps.log.warn({ error }, "youtube preview reply error"); }
  }
}
