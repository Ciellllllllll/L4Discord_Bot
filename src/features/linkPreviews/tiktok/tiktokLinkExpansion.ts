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
import { readResponseArrayBufferWithLimit } from "../../ai/fetchWithLimits.js";
import type { PreviewDocument } from "../shared/previewDocument.js";
import { buildTranslatedPreview, type PreviewPipelineState } from "../shared/previewPipeline.js";
import { savePreviewTranslationState } from "../shared/previewState.repository.js";
import {
  translatePreviewDocument,
  type PreviewDocumentTranslations,
} from "../shared/previewTranslationGate.js";
import {
  fetchTikTokPreview,
  tiktokPreviewToDocument,
  type FetchLike,
  type TikTokReplyTarget,
} from "./tiktokPreviewSource.js";

const DOWNLOAD_TIMEOUT_MS = 20_000;
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
};

export function buildTikTokFallbackReply(url: string): MessageCreateOptions {
  return {
    content: url,
    allowedMentions: { parse: [], repliedUser: false },
  };
}

async function cancelBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

/** 動画をダウンロードして添付ファイル化する。サイズ超過や失敗時は undefined。 */
export async function downloadTikTokVideo(
  playUrl: string,
  maxBytes: number,
  fetcher: FetchLike = fetch,
): Promise<AttachmentBuilder | undefined> {
  try {
    const response = await fetcher(playUrl, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      headers: { Accept: "video/mp4,video/*;q=0.9,*/*;q=0.1" },
    });
    if (!response.ok) {
      await cancelBody(response);
      return undefined;
    }
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (contentType && !contentType.startsWith("video/")) {
      await cancelBody(response);
      return undefined;
    }
    const contentLength = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      await cancelBody(response);
      return undefined;
    }
    const buffer = Buffer.from(await readResponseArrayBufferWithLimit(response, maxBytes));
    return buffer.byteLength > 0 ? new AttachmentBuilder(buffer, { name: TIKTOK_MEDIA_ATTACHMENT_FILENAME }) : undefined;
  } catch {
    return undefined;
  }
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

export async function buildTikTokReplyPayloads(
  targets: readonly TikTokReplyTarget[],
  options: TikTokReplyBuildOptions,
): Promise<Array<TikTokPreviewPayload | MessageCreateOptions>> {
  return await Promise.all(targets.map(async (target) => {
    const result = await fetchTikTokPreview(target, options.fetcher);
    if (result.status !== "ok") return buildTikTokFallbackReply(target.url);
    const video = result.video.playUrl && options.attachmentSizeLimitBytes > 0
      ? await downloadTikTokVideo(result.video.playUrl, options.attachmentSizeLimitBytes, options.fetcher)
      : undefined;
    const document = tiktokPreviewToDocument(
      result.video,
      video ? `attachment://${TIKTOK_MEDIA_ATTACHMENT_FILENAME}` : undefined,
    );
    const built = await buildTranslatedPreview(document, {
      translate: async () => await translateForTikTok(document, options),
    });
    return {
      embeds: [],
      flags: MessageFlags.IsComponentsV2,
      components: built.components,
      files: video ? [video] : [],
      allowedMentions: { parse: [], repliedUser: false },
      // 保存スキーマは https URL のみ許可するため、attachment:// を含まない文書を保存する。
      // 表示切り替えは本文テキストのみ差し替えるので、メディア部分の違いは影響しない。
      ...(built.state ? { previewState: { ...built.state, document: tiktokPreviewToDocument(result.video) } } : {}),
    } satisfies TikTokPreviewPayload;
  }));
}

type TikTokExpansionDeps = {
  db: BotContext["db"];
  log: LoggerLike;
  attachmentSizeLimitBytes: number;
  config?: AppConfig;
  aiRouter?: AiProviderRouter;
  buildReplyPayloads?: typeof buildTikTokReplyPayloads;
  saveState?: typeof savePreviewTranslationState;
};

export async function expandTikTokLinks(
  message: Message,
  targets: readonly TikTokReplyTarget[],
  deps: TikTokExpansionDeps,
): Promise<void> {
  const build = deps.buildReplyPayloads ?? buildTikTokReplyPayloads;
  const payloads = await build(targets, {
    attachmentSizeLimitBytes: deps.attachmentSizeLimitBytes,
    ...(deps.config ? { config: deps.config } : {}),
    log: deps.log,
    aiRouter: deps.aiRouter,
    guildId: message.guildId ?? deps.config?.GUILD_ID,
  });
  for (const payload of payloads) {
    try {
      const { previewState, ...replyPayload } = payload as TikTokPreviewPayload;
      const reply = await message.reply(replyPayload);
      if (!previewState || !message.guildId) continue;
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
    } catch (err) {
      deps.log.warn({ err: String(err) }, "tiktok preview reply error");
    }
  }
}
