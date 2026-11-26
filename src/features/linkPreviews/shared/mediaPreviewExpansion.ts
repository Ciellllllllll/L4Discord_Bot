import type { ExpansionReply } from "./linkExpansionTracker.js";
import type {
  APIMessageTopLevelComponent,
  AttachmentBuilder,
  Message,
  MessageCreateOptions,
  MessageFlags,
} from "discord.js";
import type { CoreDeps } from "../../../core/deps.js";
import type { AppConfig } from "../../../core/config.js";
import type { AiProviderRouter } from "../../ai/aiProviderRouter.js";
import type { LocalLlmQueue } from "../../ai/localLlmQueue.js";
import type { PreviewDocument } from "./previewDocument.js";
import {
  buildOriginalUrlReply, chunkUrlsForMessages, isRetryablePreview, mediaPreviewBuildQueue,
} from "./previewMediaDownload.js";
import type { PreviewPipelineState } from "./previewPipeline.js";
import { savePreviewTranslationState } from "./previewState.repository.js";
import { translatePreviewDocument, type PreviewDocumentTranslations } from "./previewTranslationGate.js";

type LoggerLike = {
  warn: (obj: unknown, msg?: string) => void;
};

/** 動画・画像を添付する Components V2 のプレビュー（TikTok・Instagram） */
export type MediaPreviewPayload = {
  embeds: [];
  flags: MessageFlags.IsComponentsV2;
  components: APIMessageTopLevelComponent[];
  files: AttachmentBuilder[];
  allowedMentions: { parse: []; repliedUser: false };
  previewState?: PreviewPipelineState;
};

export type MediaPreviewTranslationOptions = {
  config?: Pick<AppConfig, "DEEPSEEK_API_KEY"> & Partial<AppConfig>;
  log?: LoggerLike;
  aiRouter?: AiProviderRouter;
  guildId?: string;
  translate?: (document: PreviewDocument) => Promise<PreviewDocumentTranslations>;
};

/** 翻訳ゲートで翻訳する。失敗しても原文で表示できるよう、例外は翻訳なしとして扱う。 */
export async function translateMediaPreview(
  document: PreviewDocument,
  options: MediaPreviewTranslationOptions,
  logLabel: string,
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
    options.log?.warn({ reason: "request_or_response_error", err: String(err) }, `${logLabel} preview translation skipped`);
    return { translations: {} };
  }
}

export type MediaPreviewExpansionOptions<T extends { url: string }> = {
  /** ログとキューの識別に使う名前（"tiktok" など） */
  source: string;
  /** 1メッセージで展開する件数の上限。動画をメモリに保持するため絞る */
  maxTargets: number;
  build: (target: T) => Promise<MediaPreviewPayload | MessageCreateOptions | undefined>;
  replyExpansion?: ExpansionReply;
  db: CoreDeps["db"];
  log: LoggerLike;
  saveState?: typeof savePreviewTranslationState;
  /** テスト用。省略時はプロセス全体で共有するキューを使う */
  queue?: LocalLlmQueue;
};

/**
 * 構築→返信を共有キューで1件ずつ行い、返信済みの動画バッファを次の構築前に手放す。
 * 上限件数を超えた分とキューに入れられなかった分は元URLを返信する。
 */
export async function expandQueuedMediaPreviews<T extends { url: string }>(
  message: Message,
  targets: readonly T[],
  options: MediaPreviewExpansionOptions<T>,
): Promise<void> {
  const { source, log } = options;
  const buildAndReply = async (target: T, index: number): Promise<void> => {
    const payload = await options.build(target);
    if (!payload) return;
    const { previewState, ...replyPayload } = payload as MediaPreviewPayload;
    const reply = await (options.replyExpansion?.(
      message, `${source}:${index}`, replyPayload, undefined, { retry: isRetryablePreview(payload) },
    ) ?? message.reply(replyPayload));
    if (!previewState || !message.guildId) return;
    try {
      await (options.saveState ?? savePreviewTranslationState)(options.db, {
        version: 1,
        messageId: reply.id,
        guildId: message.guildId,
        channelId: message.channelId,
        sourceUrl: previewState.document.url,
        ...previewState,
      });
    } catch (err) {
      log.warn({ err: String(err), messageId: reply.id }, `${source} preview state save failed`);
    }
  };
  const queue = options.queue ?? mediaPreviewBuildQueue;
  for (const [index, target] of targets.slice(0, options.maxTargets).entries()) {
    try {
      // 同じメッセージに複数サービスのリンクがあっても重複扱いにならないよう、サービス名で区別する
      const ticket = queue.enqueue({ userId: `${source}:${message.id}:${index}`, run: () => buildAndReply(target, index) });
      if (ticket.ok) {
        await ticket.promise;
        continue;
      }
      log.warn({ reason: ticket.reason, messageId: message.id }, `${source} preview queue full; replying original url`);
      const fallback = buildOriginalUrlReply(target.url);
      // キューの混雑は一時的なので、追跡中の展開は定期確認で構築し直す。
      await (options.replyExpansion?.(message, `${source}:${index}`, fallback, undefined, { retry: true }) ?? message.reply(fallback));
    } catch (err) {
      log.warn({ err: String(err) }, `${source} preview reply error`);
    }
  }
  // 上限を超えた分も元メッセージの埋め込みは非表示になっているため、元URLをまとめて返信する。
  // 正規化でURLが元より長くなりうるので、文字数上限に収まるよう複数通に分ける
  const overflowUrls = targets.slice(options.maxTargets).map((target) => target.url);
  for (const [index, urls] of chunkUrlsForMessages(overflowUrls).entries()) {
    try {
      const fallback = buildOriginalUrlReply(urls);
      await (options.replyExpansion?.(message, `${source}:overflow:${index}`, fallback) ?? message.reply(fallback));
    } catch (err) {
      log.warn({ err: String(err) }, `${source} preview overflow reply error`);
    }
  }
}
