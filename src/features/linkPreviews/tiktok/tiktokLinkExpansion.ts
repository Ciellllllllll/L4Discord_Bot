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

export type TikTokPreviewPayload = {
  embeds: [];
  flags: MessageFlags.IsComponentsV2;
  components: APIMessageTopLevelComponent[];
  files: AttachmentBuilder[];
  allowedMentions: { parse: []; repliedUser: false };
  previewState?: PreviewPipelineState;
};

export type TikTokReplyBuildOptions = {
  fetcher?: FetchLike;
  /** 動画を添付できる最大サイズ（サーバーのブーストレベルに依存）。0 なら動画をダウンロードしない */
  attachmentSizeLimitBytes: number;
  config?: Pick<AppConfig, "DEEPSEEK_API_KEY"> & Partial<AppConfig>;
  log?: LoggerLike;
  aiRouter?: AiProviderRouter;
  guildId?: string;
  translate?: (document: PreviewDocument) => Promise<PreviewDocumentTranslations>;
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

async function translateForTikTok(
  document: PreviewDocument,
  options: TikTokReplyBuildOptions,
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
    options.log?.warn({ reason: "request_or_response_error", err: String(err) }, "tiktok preview translation skipped");
    return { translations: {} };
  }
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
  const translations = await translateForTikTok(sourceDocument, options);
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
  const buildAndReply = async (target: TikTokReplyTarget): Promise<void> => {
    const [payload] = await build([target], options);
    if (!payload) return;
    const { previewState, ...replyPayload } = payload as TikTokPreviewPayload;
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
      deps.log.warn({ err: String(err), messageId: reply.id }, "tiktok preview state save failed");
    }
  };
  const queue = deps.queue ?? mediaPreviewBuildQueue;
  // 構築→返信を共有キューで1件ずつ行い、返信済みの動画バッファを次の構築前に手放す
  for (const [index, target] of targets.slice(0, MAX_TIKTOK_TARGETS_PER_MESSAGE).entries()) {
    try {
      const ticket = queue.enqueue({ userId: `tiktok:${message.id}:${index}`, run: () => buildAndReply(target) });
      if (ticket.ok) {
        await ticket.promise;
        continue;
      }
      deps.log.warn({ reason: ticket.reason, messageId: message.id }, "tiktok preview queue full; replying original url");
      await message.reply(buildTikTokFallbackReply(target.url));
    } catch (err) {
      deps.log.warn({ err: String(err) }, "tiktok preview reply error");
    }
  }
  // 上限を超えた分も元メッセージの埋め込みは非表示になっているため、元URLをまとめて返信する。
  // 正規化でURLが元より長くなりうるので、文字数上限に収まるよう複数通に分ける
  const overflowUrls = targets.slice(MAX_TIKTOK_TARGETS_PER_MESSAGE).map((target) => target.url);
  for (const urls of chunkUrlsForMessages(overflowUrls)) {
    try {
      await message.reply(buildTikTokFallbackReply(urls));
    } catch (err) {
      deps.log.warn({ err: String(err) }, "tiktok preview overflow reply error");
    }
  }
}
