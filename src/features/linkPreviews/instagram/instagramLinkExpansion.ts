import {
  AttachmentBuilder,
  MessageFlags,
  type APIMessageTopLevelComponent,
  type Message,
  type MessageCreateOptions,
} from "discord.js";
import type { BotContext } from "../../../bot/context.js";
import type { AppConfig } from "../../../core/config.js";
import type { AiProviderRouter } from "../../ai/aiProviderRouter.js";
import type { LocalLlmQueue } from "../../ai/localLlmQueue.js";
import type { PreviewDocument } from "../shared/previewDocument.js";
import {
  buildOriginalUrlReply,
  chunkUrlsForMessages,
  downloadMedia,
  IMAGE_EXTENSIONS,
  IMAGE_MAX_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MEDIA_TOTAL_TIMEOUT_MS,
  mediaPreviewBuildQueue,
  type DownloadedMedia,
} from "../shared/previewMediaDownload.js";
import { buildTranslatedPreview, type PreviewPipelineState } from "../shared/previewPipeline.js";
import { savePreviewTranslationState } from "../shared/previewState.repository.js";
import {
  translatePreviewDocument,
  type PreviewDocumentTranslations,
} from "../shared/previewTranslationGate.js";
import {
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

export type InstagramPreviewPayload = {
  embeds: [];
  flags: MessageFlags.IsComponentsV2;
  components: APIMessageTopLevelComponent[];
  files: AttachmentBuilder[];
  allowedMentions: { parse: []; repliedUser: false };
  previewState?: PreviewPipelineState;
};

export type InstagramReplyBuildOptions = {
  fetcher?: FetchLike;
  /** 動画・画像を添付できる合計サイズ（サーバーのブーストレベルに依存）。0 ならミラーにもアクセスしない */
  attachmentSizeLimitBytes: number;
  config?: Pick<AppConfig, "DEEPSEEK_API_KEY"> & Partial<AppConfig>;
  log?: LoggerLike;
  aiRouter?: AiProviderRouter;
  guildId?: string;
  translate?: (document: PreviewDocument) => Promise<PreviewDocumentTranslations>;
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
 * 投稿の各項目（動画・画像）をミラー経由で CDN から取得して添付する。合計が上限を超えないよう残り容量を減らしながら取得し、
 * 取得できなかった項目は表示しない。1件も取得できなければ本体の OG 画像（動画ならサムネイル）で表示する。
 */
async function attachInstagramMedia(post: InstagramPost, options: InstagramReplyBuildOptions): Promise<AttachedMedia> {
  if (options.attachmentSizeLimitBytes <= 0) return { files: [] };
  const deadline = AbortSignal.timeout(options.mediaTotalTimeoutMs ?? MEDIA_TOTAL_TIMEOUT_MS);
  let remaining = options.attachmentSizeLimitBytes;
  const files: AttachmentBuilder[] = [];
  const mediaUrls: string[] = [];
  const attach = (media: DownloadedMedia, name: string): void => {
    remaining -= media.buffer.byteLength;
    files.push(new AttachmentBuilder(media.buffer, { name }));
    mediaUrls.push(`attachment://${name}`);
  };

  for (let index = 1; index <= MAX_INSTAGRAM_MEDIA_ITEMS; index += 1) {
    if (remaining <= 0 || files.length >= MAX_ATTACHMENTS_PER_MESSAGE || deadline.aborted) break;
    const cdnUrl = await resolveInstagramMirrorMedia(post.shortcode, index, deadline, options.fetcher);
    // 項目が尽きたか、ミラーが使えない
    if (!cdnUrl) break;
    const media = await downloadMedia(
      cdnUrl,
      { video: remaining, image: Math.min(IMAGE_MAX_BYTES, remaining) },
      deadline,
      options.fetcher,
    );
    if (media) attach(media, attachmentName(media, index));
  }
  if (files.length > 0) return { mediaUrls, files };

  if (!post.imageUrl) return { files };
  const image = await downloadMedia(post.imageUrl, { image: Math.min(IMAGE_MAX_BYTES, remaining) }, deadline, options.fetcher);
  if (!image) return { mediaUrls: [post.imageUrl], files };
  attach(image, attachmentName(image, 1));
  return { mediaUrls, files };
}

async function translateForInstagram(
  document: PreviewDocument,
  options: InstagramReplyBuildOptions,
): Promise<PreviewDocumentTranslations> {
  try {
    if (options.translate) return await options.translate(document);
    if (!options.config) return { translations: {} };
    return await translatePreviewDocument(document, {
      config: options.config,
      log: options.log,
      router: options.aiRouter,
      guildId: options.guildId,
    });
  } catch (err) {
    options.log?.warn({ reason: "request_or_response_error", err: String(err) }, "instagram preview translation skipped");
    return { translations: {} };
  }
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
  const translations = await translateForInstagram(sourceDocument, options);
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
  const buildAndReply = async (target: InstagramReplyTarget): Promise<void> => {
    const [payload] = await build([target], options);
    if (!payload) return;
    const { previewState, ...replyPayload } = payload as InstagramPreviewPayload;
    const reply = await message.reply(replyPayload);
    if (!previewState || !message.guildId) return;
    try {
      await (deps.saveState ?? savePreviewTranslationState)(deps.db, {
        version: 1,
        messageId: reply.id,
        guildId: message.guildId,
        channelId: message.channelId,
        sourceUrl: previewState.document.url,
        ...previewState,
      });
    } catch (err) {
      deps.log.warn({ err: String(err), messageId: reply.id }, "instagram preview state save failed");
    }
  };
  const queue = deps.queue ?? mediaPreviewBuildQueue;
  // 構築→返信を共有キューで1件ずつ行い、返信済みの動画バッファを次の構築前に手放す
  for (const [index, target] of targets.slice(0, MAX_INSTAGRAM_TARGETS_PER_MESSAGE).entries()) {
    try {
      const ticket = queue.enqueue({ userId: `instagram:${message.id}:${index}`, run: () => buildAndReply(target) });
      if (ticket.ok) {
        await ticket.promise;
        continue;
      }
      deps.log.warn({ reason: ticket.reason, messageId: message.id }, "instagram preview queue full; replying original url");
      await message.reply(buildOriginalUrlReply(target.url));
    } catch (err) {
      deps.log.warn({ err: String(err) }, "instagram preview reply error");
    }
  }
  // 上限を超えた分も元メッセージの埋め込みは非表示になっているため、元URLをまとめて返信する。
  // 正規化でURLが元より長くなりうるので、文字数上限に収まるよう複数通に分ける
  const overflowUrls = targets.slice(MAX_INSTAGRAM_TARGETS_PER_MESSAGE).map((target) => target.url);
  for (const urls of chunkUrlsForMessages(overflowUrls)) {
    try {
      await message.reply(buildOriginalUrlReply(urls));
    } catch (err) {
      deps.log.warn({ err: String(err) }, "instagram preview overflow reply error");
    }
  }
}
