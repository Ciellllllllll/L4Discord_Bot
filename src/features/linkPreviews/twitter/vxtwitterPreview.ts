import { MessageFlags, type MessageCreateOptions } from "discord.js";
import type { AppConfig } from "../../../core/config.js";
import type { AiProviderRouter } from "../../ai/aiProviderRouter.js";
import type { PreviewDocumentTranslations } from "../shared/previewTranslationGate.js";
import {
  buildPreviewComponents,
  hasUsefulPreviewTranslation,
} from "../shared/previewRenderer.js";
import {
  buildTwitterFallbackReply,
  buildTwitterReplyPayloads,
  type TwitterPreviewPayload,
} from "./twitterLinkExpansion.js";
import {
  collectTwitterReplyTargets,
  fetchFixTweetPreview,
  normalizeFixTweetResponse,
  parseXStatusUrl,
  tweetPreviewToDocument,
  type FetchLike,
  type FixTweetPreviewResult,
  type ParsedXStatusUrl,
  type TweetMedia,
  type TweetMediaKind,
  type TweetPreview,
  type TwitterReplyTarget,
} from "./twitterPreviewSource.js";
import type { VxTwitterTextTranslations } from "./vxtwitterTranslation.js";

export {
  fetchFixTweetPreview,
  normalizeFixTweetResponse,
  parseXStatusUrl,
  tweetPreviewToDocument,
};
export type {
  FixTweetPreviewResult,
  ParsedXStatusUrl,
  TweetMedia,
  TweetMediaKind,
  TweetPreview,
};

export type VxTwitterReplyTarget = TwitterReplyTarget;
export type VxTwitterDisplayMode = "translation" | "original";
export type VxTwitterPreviewPayload = TwitterPreviewPayload;
export const VX_PREVIEW_SHOW_ORIGINAL_ID = "vxpreview:show-original";
export const VX_PREVIEW_SHOW_TRANSLATION_ID = "vxpreview:show-translation";

type LoggerLike = {
  warn: (obj: unknown, msg?: string) => void;
};

type VxTwitterReplyBuildOptions = {
  fetcher?: FetchLike;
  config?: Pick<AppConfig, "DEEPSEEK_API_KEY"> & Partial<AppConfig>;
  log?: LoggerLike;
  translate?: (tweet: TweetPreview) => Promise<VxTwitterTextTranslations>;
  aiRouter?: AiProviderRouter;
  guildId?: string;
};

export function collectVxTwitterReplyTargets(links: readonly string[]): VxTwitterReplyTarget[] {
  return collectTwitterReplyTargets(links);
}

export function vxTwitterTranslationsToPreviewBundle(
  translations: VxTwitterTextTranslations | undefined,
): PreviewDocumentTranslations {
  return {
    ...(translations?.model ? { model: translations.model } : {}),
    translations: {
      ...(translations?.main ? { main: translations.main } : {}),
      ...(translations?.quote ? { quote: translations.quote } : {}),
    },
  };
}


export function buildVxTwitterPreviewPayload(
  tweet: TweetPreview,
  _vxUrl: string,
  translations?: VxTwitterTextTranslations,
  displayMode: VxTwitterDisplayMode = "translation",
): VxTwitterPreviewPayload {
  const document = tweetPreviewToDocument(tweet);
  const bundle = vxTwitterTranslationsToPreviewBundle(translations);
  const translated = hasUsefulPreviewTranslation(document, bundle);
  return {
    embeds: [],
    flags: MessageFlags.IsComponentsV2,
    components: buildPreviewComponents(document, bundle, displayMode),
    allowedMentions: { parse: [], repliedUser: false },
    ...(translated ? { previewState: { document, translations: bundle } } : {}),
  };
}

export function buildVxTwitterFallbackReply(vxUrls: readonly string[]): MessageCreateOptions {
  return buildTwitterFallbackReply(vxUrls);
}

export async function buildVxTwitterReplyPayloads(
  links: readonly string[] | readonly VxTwitterReplyTarget[],
  fetcherOrOptions: FetchLike | VxTwitterReplyBuildOptions = fetch,
  maybeOptions?: VxTwitterReplyBuildOptions,
): Promise<MessageCreateOptions[]> {
  const options = typeof fetcherOrOptions === "function"
    ? { ...(maybeOptions ?? {}), fetcher: fetcherOrOptions }
    : fetcherOrOptions;
  return await buildTwitterReplyPayloads(links, {
    fetcher: options.fetcher,
    config: options.config,
    log: options.log,
    aiRouter: options.aiRouter,
    guildId: options.guildId,
    ...(options.translate ? {
      translateTweet: async (tweet) => vxTwitterTranslationsToPreviewBundle(await options.translate!(tweet)),
    } : {}),
  });
}
