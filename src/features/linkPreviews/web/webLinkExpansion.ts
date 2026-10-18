import type { ExpansionReply } from "../shared/linkExpansionTracker.js";
import {
  MessageFlags,
  type APIMessageTopLevelComponent,
  type Message,
  type MessageCreateOptions,
} from "discord.js";
import type { BotContext } from "../../../bot/context.js";
import type { AppConfig } from "../../../core/config.js";
import type { AiProviderRouter } from "../../ai/aiProviderRouter.js";
import { buildTranslatedPreview, type PreviewPipelineState } from "../shared/previewPipeline.js";
import { savePreviewTranslationState } from "../shared/previewState.repository.js";
import {
  translatePreviewDocument,
  type PreviewDocumentTranslations,
} from "../shared/previewTranslationGate.js";
import { fetchWebPage, type WebFetchErrorReason, type WebPageFetcher } from "./webPageFetcher.js";
import {
  decodeHtml,
  isHtmlContentType,
  parseWebPageHtml,
  webPreviewToDocument,
  type WebPagePreview,
  type WebReplyTarget,
} from "./webPreviewSource.js";

type LoggerLike = {
  warn: (obj: unknown, msg?: string) => void;
};

export type WebPreviewPayload = MessageCreateOptions & {
  embeds: [];
  flags: MessageFlags.IsComponentsV2;
  components: APIMessageTopLevelComponent[];
  allowedMentions: { parse: []; repliedUser: false };
  previewState?: PreviewPipelineState;
};

export type WebPageLoadErrorReason = WebFetchErrorReason | "not_html" | "no_title";

export type WebPageLoadResult =
  | { status: "ok"; page: WebPagePreview }
  | { status: "error"; reason: WebPageLoadErrorReason };

export type WebPreviewBuildResult =
  | { target: WebReplyTarget; status: "success"; payload: WebPreviewPayload }
  | { target: WebReplyTarget; status: "error"; reason: WebPageLoadErrorReason };

export type WebPreviewBuildOptions = {
  fetcher?: WebPageFetcher;
  config?: Pick<AppConfig, "DEEPSEEK_API_KEY"> & Partial<AppConfig>;
  log?: LoggerLike;
  aiRouter?: AiProviderRouter;
  guildId?: string;
  translate?: (document: ReturnType<typeof webPreviewToDocument>) => Promise<PreviewDocumentTranslations>;
};

/** ページを取得して OGP と本文を読む。カードの作成と AI要約の両方で使う */
export async function loadWebPage(
  target: WebReplyTarget,
  fetcher: WebPageFetcher = fetchWebPage,
): Promise<WebPageLoadResult> {
  const result = await fetcher(target.url);
  if (result.status === "error") return result;
  if (!isHtmlContentType(result.response.contentType)) return { status: "error", reason: "not_html" };
  const html = decodeHtml(result.response.body, result.response.contentType);
  const page = parseWebPageHtml(html, target.url, result.response.finalUrl);
  return page ? { status: "ok", page } : { status: "error", reason: "no_title" };
}

async function translateDocument(
  document: ReturnType<typeof webPreviewToDocument>,
  options: WebPreviewBuildOptions,
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
  } catch (error) {
    options.log?.warn({ error: String(error) }, "web preview translation skipped");
    return { translations: {} };
  }
}

export async function buildWebReplyPayloads(
  targets: readonly WebReplyTarget[],
  options: WebPreviewBuildOptions = {},
): Promise<WebPreviewBuildResult[]> {
  return await Promise.all(targets.map(async (target): Promise<WebPreviewBuildResult> => {
    let loaded: WebPageLoadResult;
    try {
      loaded = await loadWebPage(target, options.fetcher);
    } catch (error) {
      options.log?.warn({ error: String(error), url: target.url }, "web preview fetch failed");
      return { target, status: "error", reason: "request_failed" };
    }
    if (loaded.status === "error") return { target, status: "error", reason: loaded.reason };
    const document = webPreviewToDocument(loaded.page);
    const built = await buildTranslatedPreview(document, {
      translate: async () => await translateDocument(document, options),
    });
    return {
      target,
      status: "success",
      payload: {
        embeds: [],
        flags: MessageFlags.IsComponentsV2,
        components: built.components,
        allowedMentions: { parse: [], repliedUser: false },
        ...(built.state ? { previewState: built.state } : {}),
      },
    };
  }));
}

export type SendWebExpansionDeps = {
  replyExpansion?: ExpansionReply;
  db: BotContext["db"];
  log: LoggerLike;
  saveState?: typeof savePreviewTranslationState;
};

export async function sendWebLinkExpansion(
  message: Message,
  results: readonly WebPreviewBuildResult[],
  deps: SendWebExpansionDeps,
): Promise<void> {
  for (const [index, result] of results.entries()) {
    // 取得できなかったリンクはカードを出さない（他に展開が無ければ公式の Embed が残る）
    if (result.status !== "success") continue;
    try {
      const { previewState, ...replyPayload } = result.payload;
      const reply = await (deps.replyExpansion?.(message, `web:${index}`, replyPayload) ?? message.reply(replyPayload));
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
      } catch (error) {
        deps.log.warn({ error: String(error), messageId: reply.id }, "web preview state save failed");
      }
    } catch (error) {
      deps.log.warn({ error: String(error) }, "web preview reply error");
    }
  }
}
