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
import { muxVideoWithFfmpeg, type MuxVideo, type MuxVideoFailureReason } from "../shared/ffmpegMux.js";
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
  type InstagramPageMediaItem,
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
  /** テスト用。映像と音声の結合（既定は ffmpeg） */
  muxVideo?: MuxVideo;
};

type AttachedMedia = { mediaUrls?: string[]; files: AttachmentBuilder[] };

function attachmentName(media: DownloadedMedia, index: number): string {
  return media.kind === "video"
    ? `instagram-video-${index}.mp4`
    : `instagram-image-${index}.${IMAGE_EXTENSIONS[media.contentType] ?? "jpg"}`;
}

/**
 * 上限を超える動画を、DASH の低画質の映像トラックと音声トラックを結合して上限内に収める（再エンコードはしない）。
 * 収まる画質が無い・ffmpeg が使えないなどで作れなければ undefined。
 */
async function buildLowQualityVideo(
  dash: NonNullable<InstagramPageMediaItem["dash"]>,
  maxBytes: number,
  deadline: AbortSignal,
  post: InstagramPost,
  options: InstagramReplyBuildOptions,
): Promise<Buffer | undefined> {
  const audioBytes = dash.audio?.bytes ?? 0;
  // マニフェストのサイズで収まらないと分かっている画質は取得しない
  const candidates = dash.videos.filter((track) => track.bytes === undefined || track.bytes + audioBytes <= maxBytes);
  if (candidates.length === 0) return undefined;
  // 各トラックは映像だけ・音声だけでも content-type が video/mp4 のことがあるため、どちらも受け付ける
  const trackLimits = (limit: number) => ({ video: limit, audio: limit });
  const audio = dash.audio ? await downloadMedia(dash.audio.url, trackLimits(maxBytes), deadline, options.fetcher) : undefined;
  // 音声がある投稿で音声だけ取れなかったときは、無音の動画を送らずサムネイルにする
  if (dash.audio && !audio) return undefined;
  const videoLimit = maxBytes - (audio?.buffer.byteLength ?? 0);
  let lastFailure: MuxVideoFailureReason | undefined;
  for (const track of candidates) {
    const video = await downloadMedia(track.url, trackLimits(videoLimit), deadline, options.fetcher);
    if (!video) continue;
    const result = await (options.muxVideo ?? muxVideoWithFfmpeg)(video.buffer, audio?.buffer, {
      maxOutputBytes: maxBytes,
      signal: deadline,
    });
    if (result.ok) return result.buffer;
    lastFailure = result.reason;
    // 結合後にコンテナの分だけ上限を超えた・その画質の結合に失敗した場合は、次の低い画質で作り直す。
    // ffmpeg が無い・締め切りを過ぎた場合は画質を変えても作れないので打ち切る
    if (result.reason !== "too_large" && result.reason !== "ffmpeg_failed") break;
  }
  if (lastFailure) {
    options.log?.warn({ reason: lastFailure, shortcode: post.shortcode }, "instagram low-quality video unavailable");
  }
  return undefined;
}

/**
 * 投稿の各項目（動画・画像）を CDN から取得して添付する。項目の URL は本体ページの投稿データから得て、
 * 得られなければミラー経由で得る。合計が上限を超えないよう残り容量を減らしながら取得し、
 * 取得できなかった項目は表示しない。ただし1番目の項目（リールの動画やカルーセルの先頭）が取れなかったときは、
 * そのカバー画像である本体の OG 画像を先頭に表示する。
 * 上限を超える動画は、本体ページに画質違いのトラックがあれば低画質版を作って添付する。
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

  const pageMedia = await fetchInstagramPageMedia(post, deadline, options.fetcher);
  const itemCount = pageMedia?.length ?? MAX_INSTAGRAM_MEDIA_ITEMS;
  let firstItemAttached = false;
  for (let index = 1; index <= itemCount; index += 1) {
    // 先頭を OG 画像で補う枠を1件残す
    if (remaining <= 0 || items.length >= MAX_ATTACHMENTS_PER_MESSAGE - (firstItemAttached ? 0 : 1) || deadline.aborted) break;
    const limits = { video: remaining, image: Math.min(IMAGE_MAX_BYTES, remaining) };
    const pageItem = pageMedia?.[index - 1];
    const candidates = pageItem?.urls ?? [];
    let item: Awaited<ReturnType<typeof download>>;
    // 本体ページの候補（画質・サイズ違い）を順に試す
    for (const url of candidates) {
      item = await download(url, limits, index);
      if (item) break;
    }
    // 上限を超える動画は、低画質の映像と音声を結合して上限内に収める
    if (!item && pageItem?.dash) {
      const lowQuality = await buildLowQualityVideo(pageItem.dash, remaining, deadline, post, options);
      if (lowQuality) {
        remaining -= lowQuality.byteLength;
        const name = `instagram-video-${index}.mp4`;
        item = { url: `attachment://${name}`, file: new AttachmentBuilder(lowQuality, { name }) };
      }
    }
    if (!item) {
      // 本体ページで取れなかった項目だけ、同じ番号をミラーで補う
      const mirrorUrl = await resolveInstagramMirrorMedia(post.shortcode, index, deadline, options.fetcher);
      // ミラーだけが頼りのときは、項目が尽きたかミラーが使えないので打ち切る
      if (!mirrorUrl && !pageMedia) break;
      if (mirrorUrl && !candidates.includes(mirrorUrl)) item = await download(mirrorUrl, limits, index);
    }
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
