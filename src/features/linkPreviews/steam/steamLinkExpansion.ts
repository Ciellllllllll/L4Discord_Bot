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
import { SteamExchangeRateRepository } from "../../steam/steamExchangeRateRepository.js";
import { SteamStoreClient, type SteamPagePreview, type SteamStoreFetchOptions } from "../../steam/steamStoreClient.js";
import { buildTranslatedPreview, type PreviewPipelineState } from "../shared/previewPipeline.js";
import { savePreviewTranslationState } from "../shared/previewState.repository.js";
import {
  collectPreviewTranslationSegments,
  translatePreviewDocument,
  type PreviewDocumentTranslations,
} from "../shared/previewTranslationGate.js";
import { steamPreviewToDocument, type SteamReplyTarget } from "./steamPreviewSource.js";

const STEAM_RATING_JA: Record<string, string> = {
  "overwhelmingly positive": "圧倒的に好評",
  "very positive": "非常に好評",
  positive: "好評",
  "mostly positive": "やや好評",
  mixed: "賛否両論",
  "mostly negative": "やや不評",
  negative: "不評",
  "very negative": "非常に不評",
  "overwhelmingly negative": "圧倒的に不評",
  "no user reviews": "ユーザーレビューなし",
};

type LoggerLike = {
  warn: (obj: unknown, message?: string) => void;
};

export type SteamPreviewPayload = MessageCreateOptions & {
  embeds: [];
  flags: MessageFlags.IsComponentsV2;
  components: APIMessageTopLevelComponent[];
  allowedMentions: { parse: []; repliedUser: false };
  previewState?: PreviewPipelineState;
};

export type SteamPreviewBuildOptions = SteamStoreFetchOptions & {
  client?: Pick<SteamStoreClient, "fetchPagePreview">;
  mainPgPool?: BotContext["mainPgPool"];
  exchangeRate?: number | null | (() => Promise<number | null>);
  config?: Pick<AppConfig, "DEEPSEEK_API_KEY"> & Partial<AppConfig>;
  log?: LoggerLike;
  aiRouter?: AiProviderRouter;
  guildId?: string;
  translate?: (document: ReturnType<typeof steamPreviewToDocument>) => Promise<PreviewDocumentTranslations>;
};

function fallbackPreview(target: SteamReplyTarget): SteamPagePreview {
  return {
    canonicalUrl: target.canonicalUrl,
    ...(target.appid ? { appid: target.appid } : {}),
    title: "Steamページ",
    body: "",
    price: { kind: "unknown" },
    rating: {},
  };
}

async function resolveExchangeRate(options: SteamPreviewBuildOptions): Promise<number | null> {
  if (typeof options.exchangeRate === "function") return await options.exchangeRate();
  if (typeof options.exchangeRate === "number") return options.exchangeRate;
  if (!options.mainPgPool) return null;
  try {
    return await new SteamExchangeRateRepository(options.mainPgPool, options.log).getLatestSuccessfulRate();
  } catch (error) {
    options.log?.warn({ error: String(error) }, "steam exchange rate lookup failed");
    return null;
  }
}

async function translateDocument(
  document: ReturnType<typeof steamPreviewToDocument>,
  options: SteamPreviewBuildOptions,
): Promise<PreviewDocumentTranslations> {
  try {
    const translated = options.translate
      ? await options.translate(document)
      : options.config
        ? await translatePreviewDocument(document, {
            config: options.config,
            log: options.log,
            router: options.aiRouter,
            guildId: options.guildId,
          })
        : { translations: {} };
    const aiRating = translated.translations.rating;
    if (aiRating?.shouldTranslate && aiRating.translatedText.trim()) return translated;
    const originalRating = collectPreviewTranslationSegments(document).rating;
    const fallback = originalRating && STEAM_RATING_JA[originalRating.toLowerCase()];
    return fallback ? {
      ...translated,
      translations: {
        ...translated.translations,
        rating: {
          shouldTranslate: true,
          sourceLanguage: "en",
          confidence: 1,
          translatedText: fallback,
        },
      },
    } : translated;
  } catch (error) {
    options.log?.warn({ error: String(error) }, "steam preview translation skipped");
    return { translations: {} };
  }
}

export async function buildSteamReplyPayloads(
  targets: readonly SteamReplyTarget[],
  options: SteamPreviewBuildOptions = {},
): Promise<SteamPreviewPayload[]> {
  const client = options.client ?? new SteamStoreClient(options.log);
  const exchangeRate = await resolveExchangeRate(options);
  return await Promise.all(targets.slice(0, 5).map(async (target) => {
    let preview: SteamPagePreview;
    try {
      preview = await client.fetchPagePreview(target.canonicalUrl, {
        signal: options.signal,
        fetcher: options.fetcher,
      });
    } catch (error) {
      options.log?.warn({ error: String(error), url: target.canonicalUrl }, "steam page preview fetch failed");
      preview = fallbackPreview(target);
    }
    const document = steamPreviewToDocument(preview, exchangeRate);
    const built = await buildTranslatedPreview(document, {
      translate: async () => await translateDocument(document, options),
    });
    return {
      embeds: [],
      flags: MessageFlags.IsComponentsV2,
      components: built.components,
      allowedMentions: { parse: [], repliedUser: false },
      ...(built.state ? { previewState: built.state } : {}),
    } satisfies SteamPreviewPayload;
  }));
}

export type SendSteamExpansionDeps = {
  replyExpansion?: ExpansionReply;
  db: BotContext["db"];
  mainPgPool?: BotContext["mainPgPool"];
  config: AppConfig;
  log: LoggerLike;
  aiRouter?: AiProviderRouter;
  buildReplyPayloads?: typeof buildSteamReplyPayloads;
  saveState?: typeof savePreviewTranslationState;
};

export async function sendSteamLinkExpansion(
  message: Message,
  targets: readonly SteamReplyTarget[],
  deps: SendSteamExpansionDeps,
): Promise<void> {
  const build = deps.buildReplyPayloads ?? buildSteamReplyPayloads;
  const payloads = await build(targets, {
    mainPgPool: deps.mainPgPool,
    config: deps.config,
    log: deps.log,
    aiRouter: deps.aiRouter,
    guildId: message.guildId ?? deps.config.GUILD_ID,
  });
  for (const [index, payload] of payloads.entries()) {
    try {
      const previewState = payload.previewState;
      const { previewState: _previewState, ...replyPayload } = payload;
      const reply = await (deps.replyExpansion?.(message, `steam:${index}`, replyPayload) ?? message.reply(replyPayload));
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
        deps.log.warn({ error: String(error), messageId: reply.id }, "steam preview state save failed");
      }
    } catch (error) {
      deps.log.warn({ error: String(error) }, "steam preview reply error");
    }
  }
}
