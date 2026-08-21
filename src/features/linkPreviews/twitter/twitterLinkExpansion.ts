import {
  MessageFlags,
  type APIMessageTopLevelComponent,
  type Message,
  type MessageCreateOptions,
} from "discord.js";
import type { BotContext } from "../../../bot/context.js";
import type { AppConfig } from "../../../core/config.js";
import type { AiProviderRouter } from "../../ai/aiProviderRouter.js";
import type { PreviewDocument } from "../shared/previewDocument.js";
import { buildTranslatedPreview, type PreviewPipelineState } from "../shared/previewPipeline.js";
import { savePreviewTranslationState } from "../shared/previewState.repository.js";
import {
  translatePreviewDocument,
  type PreviewDocumentTranslations,
} from "../shared/previewTranslationGate.js";
import {
  collectTwitterReplyTargets,
  fetchFixTweetPreview,
  tweetPreviewToDocument,
  type FetchLike,
  type TweetPreview,
  type TwitterReplyTarget,
} from "./twitterPreviewSource.js";
import { extractSteamLinks } from "../steam/steamPreviewSource.js";

type LoggerLike = {
  warn: (obj: unknown, msg?: string) => void;
};

export type TwitterPreviewPayload = {
  embeds: [];
  flags: MessageFlags.IsComponentsV2;
  components: APIMessageTopLevelComponent[];
  allowedMentions: { parse: []; repliedUser: false };
  previewState?: PreviewPipelineState;
  detectedSteamLinks?: string[];
};

export type TwitterReplyPayload = MessageCreateOptions & {
  previewState?: PreviewPipelineState;
};

export type TwitterReplyBuildOptions = {
  fetcher?: FetchLike;
  config?: Pick<AppConfig, "DEEPSEEK_API_KEY"> & Partial<AppConfig>;
  log?: LoggerLike;
  aiRouter?: AiProviderRouter;
  guildId?: string;
  translate?: (document: PreviewDocument) => Promise<PreviewDocumentTranslations>;
  translateTweet?: (tweet: TweetPreview) => Promise<PreviewDocumentTranslations>;
};

export function buildTwitterFallbackReply(vxUrls: readonly string[]): MessageCreateOptions {
  return {
    content: vxUrls.join("\n"),
    flags: MessageFlags.SuppressEmbeds,
    allowedMentions: { parse: [], repliedUser: false },
  };
}

function compactText(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function compactQuoteTranslation(bundle: PreviewDocumentTranslations): PreviewDocumentTranslations {
  const quote = bundle.translations.quote;
  if (!quote) return bundle;
  return {
    ...bundle,
    translations: {
      ...bundle.translations,
      quote: { ...quote, translatedText: compactText(quote.translatedText, 180) },
    },
  };
}

async function translateForTwitter(
  document: ReturnType<typeof tweetPreviewToDocument>,
  tweet: TweetPreview,
  options: TwitterReplyBuildOptions,
): Promise<PreviewDocumentTranslations> {
  try {
    if (options.translateTweet) return compactQuoteTranslation(await options.translateTweet(tweet));
    if (options.translate) return compactQuoteTranslation(await options.translate(document));
    if (!options.config) return { translations: {} };
    return compactQuoteTranslation(await translatePreviewDocument(document, {
      config: options.config,
      log: options.log,
      router: options.aiRouter,
      guildId: options.guildId,
    }));
  } catch (err) {
    options.log?.warn({ reason: "request_or_response_error", err: String(err) }, "twitter preview translation skipped");
    return { translations: {} };
  }
}

export async function buildTwitterReplyPayloads(
  targetsOrLinks: readonly TwitterReplyTarget[] | readonly string[],
  options: TwitterReplyBuildOptions = {},
): Promise<TwitterReplyPayload[]> {
  const targets = typeof targetsOrLinks[0] === "string"
    ? collectTwitterReplyTargets(targetsOrLinks as readonly string[])
    : targetsOrLinks as readonly TwitterReplyTarget[];
  return await Promise.all(targets.map(async (target) => {
    if (!target.statusId || !target.screenName) return buildTwitterFallbackReply([target.vxUrl]);
    const result = await fetchFixTweetPreview(
      { id: target.statusId, screenName: target.screenName },
      options.fetcher,
    );
    if (result.status !== "ok") return buildTwitterFallbackReply([target.vxUrl]);
    const document = tweetPreviewToDocument(result.tweet);
    const built = await buildTranslatedPreview(document, {
      translate: async () => await translateForTwitter(document, result.tweet, options),
    });
    const detectedSteamLinks = extractSteamLinks([
      result.tweet.text,
      result.tweet.quote?.text ?? "",
    ].join("\n"));
    return {
      embeds: [],
      flags: MessageFlags.IsComponentsV2,
      components: built.components,
      allowedMentions: { parse: [], repliedUser: false },
      ...(built.state ? { previewState: built.state } : {}),
      ...(detectedSteamLinks.length > 0 ? { detectedSteamLinks } : {}),
    } satisfies TwitterPreviewPayload;
  }));
}

type TwitterExpansionDeps = {
  db: BotContext["db"];
  log: LoggerLike;
  config?: AppConfig;
  aiRouter?: AiProviderRouter;
  buildReplyPayloads?: typeof buildTwitterReplyPayloads;
  saveState?: typeof savePreviewTranslationState;
};

export async function expandTwitterLinks(
  message: Message,
  targets: readonly TwitterReplyTarget[],
  deps: TwitterExpansionDeps,
): Promise<string[]> {
  const build = deps.buildReplyPayloads ?? buildTwitterReplyPayloads;
  const payloads = await build(targets, {
    ...(deps.config ? { config: deps.config } : {}),
    log: deps.log,
    aiRouter: deps.aiRouter,
    guildId: message.guildId ?? deps.config?.GUILD_ID,
  });
  const detectedSteamLinks: string[] = [];
  for (const payload of payloads) {
    try {
      const previewState = (payload as TwitterPreviewPayload).previewState;
      detectedSteamLinks.push(...((payload as TwitterPreviewPayload).detectedSteamLinks ?? []));
      const { previewState: _previewState, detectedSteamLinks: _detectedSteamLinks, ...replyPayload } = payload as TwitterPreviewPayload;
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
        deps.log.warn({ err: String(err), messageId: reply.id }, "twitter preview state save failed");
      }
    } catch (err) {
      deps.log.warn({ err: String(err) }, "twitter preview reply error");
    }
  }
  return detectedSteamLinks;
}
