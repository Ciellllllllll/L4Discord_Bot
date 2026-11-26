import { ComponentType, MessageFlags, type ButtonInteraction } from "discord.js";
import type { CoreDeps } from "../../../core/deps.js";
import type { AiProviderRouter } from "../../ai/aiProviderRouter.js";
import { buildPreviewComponents, hasUsefulPreviewTranslation } from "../shared/previewRenderer.js";
import {
  getPreviewTranslationState,
  savePreviewTranslationState,
  type PreviewTranslationState,
  type PreviewTranslationStateV1,
} from "../shared/previewState.repository.js";
import { buildTwitterReplyPayloads } from "./twitterLinkExpansion.js";
import {
  parseXStatusUrl,
  tweetPreviewToDocument,
  type TweetMedia,
  type TweetPreview,
} from "./twitterPreviewSource.js";
import {
  getVxTwitterPreviewState,
  type VxTwitterPreviewState,
} from "./vxtwitterPreviewState.js";
import {
  vxTwitterTranslationsToPreviewBundle,
} from "./vxtwitterPreview.js";
import type { TranslationDecision, VxTwitterTextTranslations } from "./vxtwitterTranslation.js";

const LEGACY_SHOW_ORIGINAL_ID = "vxpreview:show-original";
const LEGACY_SHOW_TRANSLATION_ID = "vxpreview:show-translation";
const locks = new Map<string, Promise<void>>();

type LegacyInteractionDeps = {
  getCommonState?: (messageId: string) => Promise<PreviewTranslationState | null>;
  getLegacyState?: (messageId: string) => Promise<VxTwitterPreviewState | null>;
  saveCommonState?: typeof savePreviewTranslationState;
  buildReplyPayloads?: typeof buildTwitterReplyPayloads;
};

function toggleMode(id: string): "original" | "translation" | null {
  if (id === LEGACY_SHOW_ORIGINAL_ID) return "original";
  if (id === LEGACY_SHOW_TRANSLATION_ID) return "translation";
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function legacyMedia(value: unknown): TweetMedia[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate): TweetMedia[] => {
    const item = asRecord(candidate);
    if (!item) return [];
    const kind = item?.kind;
    const url = optionalString(item?.url);
    if ((kind !== "photo" && kind !== "video" && kind !== "gif") || !url) return [];
    try {
      if (new URL(url).protocol !== "https:") return [];
    } catch {
      return [];
    }
    return [{
      kind,
      url,
      ...(optionalString(item.thumbnailUrl) ? { thumbnailUrl: optionalString(item.thumbnailUrl) } : {}),
      ...(optionalString(item.description) ? { description: optionalString(item.description) } : {}),
      sensitive: item.sensitive === true,
    }];
  }).slice(0, 10);
}

function legacyTweet(value: unknown): TweetPreview | null {
  const tweet = asRecord(value);
  const author = asRecord(tweet?.author);
  const id = optionalString(tweet?.id);
  const url = optionalString(tweet?.url);
  const text = typeof tweet?.text === "string" ? tweet.text : null;
  const screenName = optionalString(author?.screenName);
  if (!tweet || !id || !url || text === null || !screenName || !parseXStatusUrl(url)) return null;
  const quoteValue = asRecord(tweet.quote);
  const quoteAuthor = asRecord(quoteValue?.author);
  const quoteScreenName = optionalString(quoteAuthor?.screenName);
  const quote = quoteValue && quoteScreenName && typeof quoteValue.text === "string"
    ? {
      ...(optionalString(quoteValue.id) ? { id: optionalString(quoteValue.id) } : {}),
      ...(optionalString(quoteValue.url) ? { url: optionalString(quoteValue.url) } : {}),
      text: quoteValue.text,
      media: legacyMedia(quoteValue.media),
      author: {
        ...(optionalString(quoteAuthor?.name) ? { name: optionalString(quoteAuthor?.name) } : {}),
        screenName: quoteScreenName,
      },
    }
    : undefined;
  return {
    id,
    url,
    text,
    ...(optionalNumber(tweet.createdTimestamp) !== undefined ? { createdTimestamp: optionalNumber(tweet.createdTimestamp) } : {}),
    author: {
      ...(optionalString(author?.name) ? { name: optionalString(author?.name) } : {}),
      screenName,
      ...(optionalString(author?.avatarUrl) ? { avatarUrl: optionalString(author?.avatarUrl) } : {}),
    },
    ...(optionalNumber(tweet.likes) !== undefined ? { likes: optionalNumber(tweet.likes) } : {}),
    ...(optionalNumber(tweet.retweets) !== undefined ? { retweets: optionalNumber(tweet.retweets) } : {}),
    ...(optionalNumber(tweet.replies) !== undefined ? { replies: optionalNumber(tweet.replies) } : {}),
    ...(optionalNumber(tweet.views) !== undefined ? { views: optionalNumber(tweet.views) } : {}),
    sensitive: tweet.sensitive === true,
    media: legacyMedia(tweet.media),
    ...(quote ? { quote } : {}),
  };
}

function legacyDecision(value: unknown): TranslationDecision | undefined {
  const decision = asRecord(value);
  if (
    !decision
    || decision.shouldTranslate !== true
    || typeof decision.sourceLanguage !== "string"
    || typeof decision.confidence !== "number"
    || !Number.isFinite(decision.confidence)
    || typeof decision.translatedText !== "string"
    || !decision.translatedText.trim()
  ) return undefined;
  return {
    shouldTranslate: true,
    sourceLanguage: decision.sourceLanguage,
    confidence: Math.max(0, Math.min(1, decision.confidence)),
    translatedText: decision.translatedText,
  };
}

function legacyTranslations(value: unknown): VxTwitterTextTranslations {
  const record = asRecord(value);
  const main = legacyDecision(record?.main);
  const quote = legacyDecision(record?.quote);
  return {
    ...(optionalString(record?.model) ? { model: optionalString(record?.model) } : {}),
    ...(main ? { main } : {}),
    ...(quote ? { quote } : {}),
  };
}

function xLinkFromMessage(interaction: ButtonInteraction): string | null {
  const inspect = (components: readonly { type: ComponentType; components?: readonly any[]; label?: string; url?: string }[]): string | null => {
    for (const component of components) {
      if (component.type === ComponentType.Button && component.label === "Xで開く" && component.url) return component.url;
      if (component.components) {
        const nested = inspect(component.components);
        if (nested) return nested;
      }
    }
    return null;
  };
  return inspect(interaction.message.components as never);
}

async function serialized(messageId: string, task: () => Promise<void>): Promise<void> {
  const previous = locks.get(messageId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(task);
  locks.set(messageId, current);
  try {
    await current;
  } finally {
    if (locks.get(messageId) === current) locks.delete(messageId);
  }
}

async function reportMissing(interaction: ButtonInteraction, content: string): Promise<void> {
  await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
}

function migratedState(
  messageId: string,
  guildId: string,
  channelId: string,
  tweet: TweetPreview,
  translations: VxTwitterTextTranslations,
): PreviewTranslationStateV1 | null {
  const document = tweetPreviewToDocument(tweet);
  const bundle = vxTwitterTranslationsToPreviewBundle(translations);
  if (!hasUsefulPreviewTranslation(document, bundle)) return null;
  return {
    version: 1,
    messageId,
    guildId,
    channelId,
    sourceUrl: document.url,
    document,
    translations: bundle,
  };
}

// vX(Twitter) プレビューの翻訳切替で使う依存。
type VxTwitterPreviewDeps =
  & Pick<CoreDeps, "config" | "db" | "log" | "client">
  & { aiRouter: AiProviderRouter };

export async function handleVxTwitterPreviewButton(
  interaction: ButtonInteraction,
  ctx: VxTwitterPreviewDeps,
  deps: LegacyInteractionDeps = {},
): Promise<boolean> {
  const mode = toggleMode(interaction.customId);
  if (!mode) return false;
  const guildId = interaction.guildId;
  const channelId = interaction.channelId;
  if (!guildId || !channelId || guildId !== ctx.config.GUILD_ID || interaction.message.author.id !== ctx.client.user?.id) return false;
  await interaction.deferUpdate();
  await serialized(interaction.message.id, async () => {
    const common = await (deps.getCommonState
      ? deps.getCommonState(interaction.message.id)
      : getPreviewTranslationState(ctx.db, interaction.message.id, { log: ctx.log }));
    const commonMatchesInteraction = common?.guildId === guildId && common.channelId === channelId;
    const legacyCommonTweet = common?.version === 0 && commonMatchesInteraction
      ? legacyTweet(common.document.legacyTweet)
      : null;
    const legacyCommonTranslations = common?.version === 0 && commonMatchesInteraction
      ? legacyTranslations(common.translations.legacyTranslations)
      : null;
    const old = legacyCommonTweet ? null : await (deps.getLegacyState
      ? deps.getLegacyState(interaction.message.id)
      : getVxTwitterPreviewState(ctx.db, interaction.message.id));
    const oldTweet = old ? legacyTweet(old.tweet) : null;
    const migrated = legacyCommonTweet && legacyCommonTranslations
      ? migratedState(interaction.message.id, guildId, channelId, legacyCommonTweet, legacyCommonTranslations)
      : oldTweet && old
        ? migratedState(interaction.message.id, guildId, channelId, oldTweet, old.translations)
        : null;
    if (migrated) {
      await (deps.saveCommonState ?? savePreviewTranslationState)(ctx.db, migrated);
      await interaction.editReply({ components: buildPreviewComponents(migrated.document, migrated.translations, mode) });
      return;
    }

    const tweetUrl = xLinkFromMessage(interaction);
    const parsed = tweetUrl ? parseXStatusUrl(tweetUrl) : null;
    if (!tweetUrl || !parsed) {
      await reportMissing(interaction, "投稿URLを検証できないため、表示を切り替えられませんでした。");
      return;
    }
    const [payload] = await (deps.buildReplyPayloads ?? buildTwitterReplyPayloads)([{
      vxUrl: parsed.vxUrl,
      screenName: parsed.screenName,
      statusId: parsed.id,
    }], {
      config: ctx.config,
      log: ctx.log,
      aiRouter: ctx.aiRouter,
      guildId,
    });
    const refreshed = payload?.previewState;
    if (!refreshed) {
      await reportMissing(interaction, "投稿を再取得できないため、表示を切り替えられませんでした。");
      return;
    }
    const state: PreviewTranslationStateV1 = {
      version: 1,
      messageId: interaction.message.id,
      guildId,
      channelId,
      sourceUrl: refreshed.document.url,
      ...refreshed,
    };
    await (deps.saveCommonState ?? savePreviewTranslationState)(ctx.db, state);
    await interaction.editReply({ components: buildPreviewComponents(state.document, state.translations, mode) });
  }).catch(async (err) => {
    ctx.log.warn({ err: String(err), messageId: interaction.message.id }, "vxtwitter preview toggle failed");
    await interaction.followUp({
      content: "表示の切り替えに失敗しました。しばらくしてからお試しください。",
      flags: MessageFlags.Ephemeral,
    }).catch(() => undefined);
  });
  return true;
}
