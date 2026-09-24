import {
  AttachmentBuilder,
  MessageFlags,
  type Message,
  type MessageCreateOptions,
} from "discord.js";
import type { BotContext } from "../../../bot/context.js";
import type { AppConfig } from "../../../core/config.js";
import type { AiProviderRouter } from "../../ai/aiProviderRouter.js";
import type { LocalLlmQueue } from "../../ai/localLlmQueue.js";
import {
  expandQueuedMediaPreviews,
  translateMediaPreview,
  type MediaPreviewPayload,
  type MediaPreviewTranslationOptions,
} from "../shared/mediaPreviewExpansion.js";
import {
  buildOriginalUrlReply,
  chunkUrlsForMessages,
  downloadMedia,
  IMAGE_EXTENSIONS,
  IMAGE_MAX_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MEDIA_TOTAL_TIMEOUT_MS,
  type DownloadedMedia,
} from "../shared/previewMediaDownload.js";
import { buildTranslatedPreview } from "../shared/previewPipeline.js";
import type { savePreviewTranslationState } from "../shared/previewState.repository.js";
import {
  fetchTikTokPreview,
  tiktokPreviewToDocument,
  tiktokStillMediaUrls,
  type FetchLike,
  type TikTokPreview,
  type TikTokReplyTarget,
} from "./tiktokPreviewSource.js";

export { chunkUrlsForMessages };

/** 1メッセージで展開する TikTok リンクの上限。動画は最大100MBをメモリに保持するため絞る */
export const MAX_TIKTOK_TARGETS_PER_MESSAGE = 3;
export const TIKTOK_MEDIA_ATTACHMENT_FILENAME = "tiktok-preview.mp4";

type LoggerLike = {
  warn: (obj: unknown, msg?: string) => void;
};

export type TikTokPreviewPayload = MediaPreviewPayload;

export type TikTokReplyBuildOptions = MediaPreviewTranslationOptions & {
  fetcher?: FetchLike;
  /** 動画を添付できる最大サイズ（サーバーのブーストレベルに依存）。0 なら動画をダウンロードしない */
  attachmentSizeLimitBytes: number;
  /** テスト用。メディア取得全体の締め切り（既定 30 秒） */
  mediaTotalTimeoutMs?: number;
};

export function buildTikTokFallbackReply(urls: string | readonly string[]): MessageCreateOptions {
  return buildOriginalUrlReply(urls);
}

type AttachedMedia = { mediaUrls: string[]; avatarUrl?: string; files: AttachmentBuilder[] };

/**
 * 動画・画像・アイコンを添付ファイルにする。合計が上限を超えないよう残り容量を減らしながら取得し、
 * 取得できなかった画像や締め切り後の分は元URLのまま表示する。
 */
async function attachTikTokMedia(video: TikTokPreview, options: TikTokReplyBuildOptions): Promise<AttachedMedia> {
  const deadline = AbortSignal.timeout(options.mediaTotalTimeoutMs ?? MEDIA_TOTAL_TIMEOUT_MS);
  let remaining = options.attachmentSizeLimitBytes;
  const files: AttachmentBuilder[] = [];
  const attach = (media: DownloadedMedia, name: string): string => {
    remaining -= media.buffer.byteLength;
    files.push(new AttachmentBuilder(media.buffer, { name }));
    return `attachment://${name}`;
  };
  const attachImage = async (url: string, baseName: string): Promise<string> => {
    // 写真10枚＋アイコンなど、添付数の上限を超える分は元URLのまま表示する
    if (files.length >= MAX_ATTACHMENTS_PER_MESSAGE) return url;
    const media = await downloadMedia(url, { image: Math.min(IMAGE_MAX_BYTES, remaining) }, deadline, options.fetcher);
    return media ? attach(media, `${baseName}.${IMAGE_EXTENSIONS[media.contentType] ?? "jpg"}`) : url;
  };

  const mediaUrls: string[] = [];
  const videoMedia = video.playUrl ? await downloadMedia(video.playUrl, { video: remaining }, deadline, options.fetcher) : undefined;
  if (videoMedia) {
    mediaUrls.push(attach(videoMedia, TIKTOK_MEDIA_ATTACHMENT_FILENAME));
  } else {
    for (const [index, url] of tiktokStillMediaUrls(video).entries()) {
      mediaUrls.push(await attachImage(url, `tiktok-image-${index + 1}`));
    }
  }
  const avatarUrl = video.author.avatarUrl ? await attachImage(video.author.avatarUrl, "tiktok-avatar") : undefined;
  return { mediaUrls, ...(avatarUrl ? { avatarUrl } : {}), files };
}

async function buildTikTokReplyPayload(
  target: TikTokReplyTarget,
  options: TikTokReplyBuildOptions,
): Promise<TikTokPreviewPayload | MessageCreateOptions> {
  const result = await fetchTikTokPreview(target, options.fetcher);
  if (result.status !== "ok") return buildTikTokFallbackReply(target.url);
  // 翻訳はメディアに依存しないため先に行い、ダウンロードしたバッファを保持する時間を短くする。
  // 保存スキーマは https URL のみ許可するため、状態には attachment:// を含まないこの文書を保存する
  // （表示切り替えは本文テキストのみ差し替えるので、メディア部分の違いは影響しない）。
  const sourceDocument = tiktokPreviewToDocument(result.video);
  const translations = await translateMediaPreview(sourceDocument, options, "tiktok");
  const media = await attachTikTokMedia(result.video, options);
  const built = await buildTranslatedPreview(tiktokPreviewToDocument(result.video, media), {
    translate: async () => translations,
  });
  return {
    embeds: [],
    flags: MessageFlags.IsComponentsV2,
    components: built.components,
    files: media.files,
    allowedMentions: { parse: [], repliedUser: false },
    ...(built.state ? { previewState: { ...built.state, document: sourceDocument } } : {}),
  } satisfies TikTokPreviewPayload;
}

/** 渡された対象を1件ずつ順番に構築する（ダウンロードを同時に走らせない）。 */
export async function buildTikTokReplyPayloads(
  targets: readonly TikTokReplyTarget[],
  options: TikTokReplyBuildOptions,
): Promise<Array<TikTokPreviewPayload | MessageCreateOptions>> {
  const payloads: Array<TikTokPreviewPayload | MessageCreateOptions> = [];
  for (const target of targets) {
    payloads.push(await buildTikTokReplyPayload(target, options));
  }
  return payloads;
}

type TikTokExpansionDeps = {
  db: BotContext["db"];
  log: LoggerLike;
  attachmentSizeLimitBytes: number;
  config?: AppConfig;
  aiRouter?: AiProviderRouter;
  buildReplyPayloads?: typeof buildTikTokReplyPayloads;
  saveState?: typeof savePreviewTranslationState;
  /** テスト用。省略時はプロセス全体で共有するキューを使う */
  queue?: LocalLlmQueue;
};

export async function expandTikTokLinks(
  message: Message,
  targets: readonly TikTokReplyTarget[],
  deps: TikTokExpansionDeps,
): Promise<void> {
  const build = deps.buildReplyPayloads ?? buildTikTokReplyPayloads;
  const options: TikTokReplyBuildOptions = {
    attachmentSizeLimitBytes: deps.attachmentSizeLimitBytes,
    ...(deps.config ? { config: deps.config } : {}),
    log: deps.log,
    aiRouter: deps.aiRouter,
    guildId: message.guildId ?? deps.config?.GUILD_ID,
  };
  await expandQueuedMediaPreviews(message, targets, {
    source: "tiktok",
    maxTargets: MAX_TIKTOK_TARGETS_PER_MESSAGE,
    build: async (target) => (await build([target], options))[0],
    db: deps.db,
    log: deps.log,
    ...(deps.saveState ? { saveState: deps.saveState } : {}),
    ...(deps.queue ? { queue: deps.queue } : {}),
  });
}
