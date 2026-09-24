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
  fetchInstagramPageMedia,
  fetchInstagramPreview,
  instagramPreviewToDocument,
  MAX_INSTAGRAM_MEDIA_ITEMS,
  resolveInstagramMirrorMedia,
  type FetchLike,
  type InstagramPost,
  type InstagramReplyTarget,
} from "./instagramPreviewSource.js";

/** 1メッセージで展開する Instagram リンクの上限。動画をメモリに保持するため TikTok と同じく絞る */
export const MAX_INSTAGRAM_TARGETS_PER_MESSAGE = 3;

type LoggerLike = {
  warn: (obj: unknown, msg?: string) => void;
};

export type InstagramPreviewPayload = MediaPreviewPayload;

export type InstagramReplyBuildOptions = MediaPreviewTranslationOptions & {
  fetcher?: FetchLike;
  /** 動画・画像を添付できる合計サイズ（サーバーのブーストレベルに依存）。0 ならミラーにもアクセスしない */
  attachmentSizeLimitBytes: number;
  /** テスト用。メディア取得全体の締め切り（既定 30 秒） */
  mediaTotalTimeoutMs?: number;
};

type AttachedMedia = { mediaUrls?: string[]; files: AttachmentBuilder[] };

function attachmentName(media: DownloadedMedia, index: number): string {
  return media.kind === "video"
    ? `instagram-video-${index}.mp4`
    : `instagram-image-${index}.${IMAGE_EXTENSIONS[media.contentType] ?? "jpg"}`;
}

/**
 * 投稿の各項目（動画・画像）を CDN から取得して添付する。項目の URL は本体ページの投稿データから得て、
 * 得られなければミラー経由で得る。合計が上限を超えないよう残り容量を減らしながら取得し、
 * 取得できなかった項目は表示しない。ただし1番目の項目（リールの動画やカルーセルの先頭）が取れなかったときは、
 * そのカバー画像である本体の OG 画像を先頭に表示する。
 */
async function attachInstagramMedia(post: InstagramPost, options: InstagramReplyBuildOptions): Promise<AttachedMedia> {
  if (options.attachmentSizeLimitBytes <= 0) return { files: [] };
  const deadline = AbortSignal.timeout(options.mediaTotalTimeoutMs ?? MEDIA_TOTAL_TIMEOUT_MS);
  let remaining = options.attachmentSizeLimitBytes;
  const items: Array<{ url: string; file: AttachmentBuilder }> = [];
  const download = async (url: string, limits: Parameters<typeof downloadMedia>[1], index: number) => {
    const media = await downloadMedia(url, limits, deadline, options.fetcher);
    if (!media) return undefined;
    remaining -= media.buffer.byteLength;
    const name = attachmentName(media, index);
    return { url: `attachment://${name}`, file: new AttachmentBuilder(media.buffer, { name }) };
  };

  const pageMediaUrls = await fetchInstagramPageMedia(post, deadline, options.fetcher);
  let firstItemAttached = false;
  for (let index = 1; index <= MAX_INSTAGRAM_MEDIA_ITEMS; index += 1) {
    // 先頭を OG 画像で補う枠を1件残す
    if (remaining <= 0 || items.length >= MAX_ATTACHMENTS_PER_MESSAGE - (firstItemAttached ? 0 : 1) || deadline.aborted) break;
    const cdnUrl = pageMediaUrls
      ? pageMediaUrls[index - 1]
      : await resolveInstagramMirrorMedia(post.shortcode, index, deadline, options.fetcher);
    // 項目が尽きたか、ミラーが使えない
    if (!cdnUrl) break;
    const item = await download(cdnUrl, { video: remaining, image: Math.min(IMAGE_MAX_BYTES, remaining) }, index);
    if (!item) continue;
    items.push(item);
    if (index === 1) firstItemAttached = true;
  }
  const mediaUrls = items.map((item) => item.url);
  const files = items.map((item) => item.file);
  if (firstItemAttached || !post.imageUrl) return { ...(items.length > 0 ? { mediaUrls } : {}), files };

  const cover = await download(post.imageUrl, { image: Math.min(IMAGE_MAX_BYTES, remaining) }, 1);
  // 取得できなければ OG 画像のURLのまま表示する（CDN のURLは失効するが、何も出ないよりよい）
  return {
    mediaUrls: [cover?.url ?? post.imageUrl, ...mediaUrls],
    files: cover ? [cover.file, ...files] : files,
  };
}

async function buildInstagramReplyPayload(
  target: InstagramReplyTarget,
  options: InstagramReplyBuildOptions,
): Promise<InstagramPreviewPayload | MessageCreateOptions> {
  const result = await fetchInstagramPreview(target, options.fetcher);
  if (result.status !== "ok") {
    options.log?.warn({ reason: result.reason, url: target.url }, "instagram preview fallback");
    return buildOriginalUrlReply(target.url);
  }
  // 翻訳はメディアに依存しないため先に行い、ダウンロードしたバッファを保持する時間を短くする。
  // 保存スキーマは https URL のみ許可するため、状態には attachment:// を含まないこの文書を保存する
  // （表示切り替えは本文テキストのみ差し替えるので、メディア部分の違いは影響しない）。
  const sourceDocument = instagramPreviewToDocument(result.post);
  const translations = await translateMediaPreview(sourceDocument, options, "instagram");
  const media = await attachInstagramMedia(result.post, options);
  const built = await buildTranslatedPreview(
    instagramPreviewToDocument(result.post, media.mediaUrls ? { mediaUrls: media.mediaUrls } : {}),
    { translate: async () => translations },
  );
  return {
    embeds: [],
    flags: MessageFlags.IsComponentsV2,
    components: built.components,
    files: media.files,
    allowedMentions: { parse: [], repliedUser: false },
    ...(built.state ? { previewState: { ...built.state, document: sourceDocument } } : {}),
  } satisfies InstagramPreviewPayload;
}

/** 渡された対象を1件ずつ順番に構築する（ダウンロードを同時に走らせない）。 */
export async function buildInstagramReplyPayloads(
  targets: readonly InstagramReplyTarget[],
  options: InstagramReplyBuildOptions,
): Promise<Array<InstagramPreviewPayload | MessageCreateOptions>> {
  const payloads: Array<InstagramPreviewPayload | MessageCreateOptions> = [];
  for (const target of targets) {
    payloads.push(await buildInstagramReplyPayload(target, options));
  }
  return payloads;
}

type InstagramExpansionDeps = {
  db: BotContext["db"];
  log: LoggerLike;
  attachmentSizeLimitBytes: number;
  config?: AppConfig;
  aiRouter?: AiProviderRouter;
  buildReplyPayloads?: typeof buildInstagramReplyPayloads;
  saveState?: typeof savePreviewTranslationState;
  /** テスト用。省略時はプロセス全体で共有するキュー（TikTok と共用）を使う */
  queue?: LocalLlmQueue;
};

export async function expandInstagramLinks(
  message: Message,
  targets: readonly InstagramReplyTarget[],
  deps: InstagramExpansionDeps,
): Promise<void> {
  const build = deps.buildReplyPayloads ?? buildInstagramReplyPayloads;
  const options: InstagramReplyBuildOptions = {
    attachmentSizeLimitBytes: deps.attachmentSizeLimitBytes,
    ...(deps.config ? { config: deps.config } : {}),
    log: deps.log,
    aiRouter: deps.aiRouter,
    guildId: message.guildId ?? deps.config?.GUILD_ID,
  };
  await expandQueuedMediaPreviews(message, targets, {
    source: "instagram",
    maxTargets: MAX_INSTAGRAM_TARGETS_PER_MESSAGE,
    build: async (target) => (await build([target], options))[0],
    db: deps.db,
    log: deps.log,
    ...(deps.saveState ? { saveState: deps.saveState } : {}),
    ...(deps.queue ? { queue: deps.queue } : {}),
  });
}
