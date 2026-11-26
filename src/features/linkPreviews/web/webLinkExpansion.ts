import type { ExpansionReply } from "../shared/linkExpansionTracker.js";
import {
  ButtonStyle,
  ComponentType,
  MessageFlags,
  type APIMessageTopLevelComponent,
  type Message,
  type MessageCreateOptions,
} from "discord.js";
import type { CoreDeps } from "../../../core/deps.js";
import type { AppConfig } from "../../../core/config.js";
import type { AiProviderRouter } from "../../ai/aiProviderRouter.js";
import { buildTranslatedPreview, type PreviewPipelineState } from "../shared/previewPipeline.js";
import { savePreviewTranslationState } from "../shared/previewState.repository.js";
import {
  translatePreviewDocument,
  type PreviewDocumentTranslations,
} from "../shared/previewTranslationGate.js";
import { fetchWebPage, isHtmlContentType, type WebFetchErrorReason, type WebPageFetcher } from "./webPageFetcher.js";
import {
  decodeHtml,
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
  | { status: "error"; reason: WebPageLoadErrorReason; statusCode?: number };

export type WebPreviewBuildResult =
  | { target: WebReplyTarget; status: "success"; payload: WebPreviewPayload }
  | { target: WebReplyTarget; status: "error"; reason: WebPageLoadErrorReason; statusCode?: number };

/** 再試行で回復しうる失敗。内部アドレス・HTML 以外・タイトル無しなどは再試行しても変わらない */
export function isTransientWebFailure(result: { reason: WebPageLoadErrorReason; statusCode?: number }): boolean {
  if (result.reason === "timeout" || result.reason === "request_failed") return true;
  return result.reason === "http_error" && result.statusCode !== undefined
    && (result.statusCode === 408 || result.statusCode === 429 || result.statusCode >= 500);
}

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

/**
 * 取得できなかったリンクの代わりのカード。他のリンクの展開で元投稿の Embed を抑制したときに、
 * このリンクの Embed だけが何も無いまま消えないようにする。
 */
export function buildWebFailurePayload(target: WebReplyTarget): WebPreviewPayload {
  return {
    embeds: [],
    flags: MessageFlags.IsComponentsV2,
    components: [{
      type: ComponentType.Container,
      components: [
        {
          type: ComponentType.TextDisplay,
          content: `🔗 **${new URL(target.url).hostname}**\n-# ページの情報を取得できませんでした`,
        },
        {
          type: ComponentType.ActionRow,
          components: [{ type: ComponentType.Button, style: ButtonStyle.Link, label: "リンクを開く", url: target.url }],
        },
      ],
    }],
    allowedMentions: { parse: [], repliedUser: false },
  };
}

const MAX_OVERFLOW_CONTENT_CHARS = 3_900;

/** 取得の上限を超えたリンクを1枚にまとめたカード。Embed を抑制した投稿で、これらのリンクの表示が消えないようにする */
export function buildWebOverflowPayload(targets: readonly WebReplyTarget[]): WebPreviewPayload {
  const lines = ["-# ほかのリンク"];
  for (const [index, target] of targets.entries()) {
    const line = `🔗 [${new URL(target.url).hostname}](<${target.url}>)`;
    if ([...lines, line].join("\n").length > MAX_OVERFLOW_CONTENT_CHARS) {
      lines.push(`-# ほか ${targets.length - index} 件`);
      break;
    }
    lines.push(line);
  }
  return {
    embeds: [],
    flags: MessageFlags.IsComponentsV2,
    components: [{
      type: ComponentType.Container,
      components: [{ type: ComponentType.TextDisplay, content: lines.join("\n") }],
    }],
    allowedMentions: { parse: [], repliedUser: false },
  };
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
    if (loaded.status === "error") {
      return {
        target, status: "error", reason: loaded.reason,
        ...(loaded.statusCode !== undefined ? { statusCode: loaded.statusCode } : {}),
      };
    }
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
  db: CoreDeps["db"];
  log: LoggerLike;
  saveState?: typeof savePreviewTranslationState;
};

/**
 * includeFailures: 元投稿の Embed を抑制したときは、取得できなかったリンクにも代わりのカードを出す。
 * overflow: 取得の上限を超えて取得しなかったリンク。includeFailures のときに1枚のカードにまとめて出す。
 */
export async function sendWebLinkExpansion(
  message: Message,
  results: readonly WebPreviewBuildResult[],
  deps: SendWebExpansionDeps,
  options: { includeFailures?: boolean; overflow?: readonly WebReplyTarget[] } = {},
): Promise<void> {
  await sendWebCards(message, results, deps, options.includeFailures === true);
  if (options.includeFailures !== true || !options.overflow?.length) return;
  try {
    await (deps.replyExpansion?.(message, "web:overflow", buildWebOverflowPayload(options.overflow))
      ?? message.reply(buildWebOverflowPayload(options.overflow)));
  } catch (error) {
    deps.log.warn({ error: String(error) }, "web preview overflow reply error");
  }
}

async function sendWebCards(
  message: Message,
  results: readonly WebPreviewBuildResult[],
  deps: SendWebExpansionDeps,
  includeFailures: boolean,
): Promise<void> {
  for (const [index, result] of results.entries()) {
    if (result.status !== "success" && !includeFailures) continue;
    try {
      const { previewState, ...replyPayload } = result.status === "success"
        ? result.payload
        : buildWebFailurePayload(result.target);
      // 一時的な失敗の代替カードは未完了として扱い、定期確認でページが回復したら作り直す
      const retry = result.status === "error" && isTransientWebFailure(result);
      const reply = await (deps.replyExpansion?.(message, `web:${index}`, replyPayload, undefined, { retry })
        ?? message.reply(replyPayload));
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
