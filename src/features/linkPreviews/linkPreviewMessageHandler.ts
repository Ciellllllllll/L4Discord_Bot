import type { ExpansionReply } from "./shared/linkExpansionTracker.js";
import { MessageFlags, type Message } from "discord.js";
import type pino from "pino";
import type { CoreDeps } from "../../core/deps.js";
import type { AiProviderRouter } from "../ai/aiProviderRouter.js";
import { getGuildSettingsData } from "../../core/guildSettings.js";
import { looksLikePrefixCommandLine } from "../../core/commandLike.js";
import {
  cacheYouTubeVideoForPost,
  saveYouTubeVideoCacheReferenceForPost,
} from "../youtube/youtubeVideoCache.service.js";
import {
  buildTwitterReplyPayloads,
  expandTwitterLinks,
} from "./twitter/twitterLinkExpansion.js";
import { collectTwitterReplyTargets } from "./twitter/twitterPreviewSource.js";
import {
  buildSteamReplyPayloads,
  sendSteamLinkExpansion,
} from "./steam/steamLinkExpansion.js";
import { collectSteamReplyTargets } from "./steam/steamPreviewSource.js";
import {
  buildYouTubeReplyPayloads,
  prepareYouTubeLinkExpansion,
  sendYouTubeLinkExpansion,
  type YouTubePreviewBuildOptions,
} from "./youtube/youtubeLinkExpansion.js";
import { collectYouTubeReplyTargets } from "./youtube/youtubePreviewSource.js";
import { waitForNativeYouTubeEmbed } from "./youtube/youtubeNativeEmbedWait.js";
import { collectGithubReplyTargets } from "./github/githubPreviewSource.js";
import {
  buildGithubReplyPayloads,
  isTransientGithubFailure,
  sendGithubLinkExpansion,
  type GithubPreviewBuildResult,
} from "./github/githubLinkExpansion.js";
import { expandTikTokLinks } from "./tiktok/tiktokLinkExpansion.js";
import { collectTikTokReplyTargets } from "./tiktok/tiktokPreviewSource.js";
import { expandInstagramLinks } from "./instagram/instagramLinkExpansion.js";
import { collectInstagramReplyTargets } from "./instagram/instagramPreviewSource.js";
import { buildWebReplyPayloads, sendWebLinkExpansion, type WebPreviewBuildResult } from "./web/webLinkExpansion.js";
import { collectWebReplyTargets, extractWebLinks, MAX_WEB_PREVIEWS } from "./web/webPreviewSource.js";
import { resolveYouTubeVideoMedia } from "../youtube/youtubeVideoMedia.js";
import { LateEmbedWatcher } from "./shared/lateEmbedWatcher.js";
import { youtubeAttachmentSizeLimitForPremiumTier } from "./youtube/youtubeMediaAttachment.js";
import {
  extractGithubEmbedImageUrls,
  extractGithubLinks,
  extractGithubLinksFromMessage,
  extractInstagramLinks,
  extractSteamLinksFromMessage,
  extractTikTokLinks,
  extractXLinks,
  extractYouTubeLinks,
} from "./shared/linkExtraction.js";
import { refreshPreviewTranslationState } from "./shared/previewTranslationRefresh.js";

export {
  extractGithubEmbedImageUrls,
  extractGithubLinks,
  extractInstagramLinks,
  extractTikTokLinks,
  extractXLinks,
  extractYouTubeLinks,
  refreshPreviewTranslationState,
};

function attachmentSizeLimitForMessage(message: Message): number {
  return youtubeAttachmentSizeLimitForPremiumTier(message.guild?.premiumTier);
}

/**
 * Discord の公式 Embed はメッセージ作成後に遅れて生成されることがあり、最初の抑制の後から付くと残ってしまう。
 * プレビューのカードを送った後にメッセージを API から取り直し、Embed が残っていればもう一度抑制する。
 */
export async function suppressLateEmbeds(
  message: Pick<Message, "id" | "fetch">,
  log: Pick<pino.Logger, "warn">,
): Promise<void> {
  try {
    const latest = await message.fetch(true);
    if (latest.embeds.length > 0) await latest.suppressEmbeds(true);
  } catch (err) {
    log.warn({ err: String(err), messageId: message.id }, "late embed suppression failed");
  }
}

// リンクプレビュー処理が使う依存。aiRouter は翻訳に使う。
export type LinkPreviewHandlerDeps =
  & Pick<CoreDeps, "config" | "db" | "log" | "client" | "mainPgPool">
  & { aiRouter: AiProviderRouter };

type LinkPreviewMessageHandlerDeps = {
  replyExpansion?: ExpansionReply;
  /** カードを送らない一時的な失敗を、追跡中の投稿の再試行対象として記録する */
  deferExpansion?: (message: Message, key: string) => Promise<void>;
  buildVxTwitterReplyPayloads?: typeof buildTwitterReplyPayloads;
  expandTwitterLinks?: typeof expandTwitterLinks;
  buildYouTubeReplyPayloads?: typeof buildYouTubeReplyPayloads;
  cacheYouTubeVideoForPost?: typeof cacheYouTubeVideoForPost;
  saveYouTubeVideoCacheReference?: typeof saveYouTubeVideoCacheReferenceForPost;
  mediaResolver?: YouTubePreviewBuildOptions["mediaResolver"];
  fetcher?: YouTubePreviewBuildOptions["fetcher"];
  buildSteamReplyPayloads?: typeof buildSteamReplyPayloads;
  buildGithubReplyPayloads?: typeof buildGithubReplyPayloads;
  expandTikTokLinks?: typeof expandTikTokLinks;
  expandInstagramLinks?: typeof expandInstagramLinks;
  buildWebReplyPayloads?: typeof buildWebReplyPayloads;
  suppressLateEmbeds?: (message: Message) => Promise<void>;
  /** 抑制した後に遅れて付く公式 Embed を messageUpdate で監視する。null なら監視しない */
  lateEmbedWatcher?: Pick<LateEmbedWatcher, "watch" | "unwatch"> | null;
};

type MessageUpdateSource = ConstructorParameters<typeof LateEmbedWatcher>[0];

function hasMessageUpdateEvents(client: unknown): client is MessageUpdateSource {
  const candidate = client as { on?: unknown; off?: unknown } | null | undefined;
  return typeof candidate?.on === "function" && typeof candidate.off === "function";
}

export class LinkPreviewMessageHandler {
  private readonly deps: Required<LinkPreviewMessageHandlerDeps>;
  private readonly tracked: boolean;

  constructor(private readonly ctx: LinkPreviewHandlerDeps, deps: LinkPreviewMessageHandlerDeps = {}) {
    this.tracked = Boolean(deps.replyExpansion);
    this.deps = {
      replyExpansion: deps.replyExpansion ?? ((message, _key, payload) => message.reply(payload)),
      deferExpansion: deps.deferExpansion ?? (async () => undefined),
      buildVxTwitterReplyPayloads: deps.buildVxTwitterReplyPayloads ?? buildTwitterReplyPayloads,
      expandTwitterLinks: deps.expandTwitterLinks ?? expandTwitterLinks,
      buildYouTubeReplyPayloads: deps.buildYouTubeReplyPayloads ?? buildYouTubeReplyPayloads,
      cacheYouTubeVideoForPost: deps.cacheYouTubeVideoForPost ?? cacheYouTubeVideoForPost,
      saveYouTubeVideoCacheReference: deps.saveYouTubeVideoCacheReference ?? saveYouTubeVideoCacheReferenceForPost,
      mediaResolver: deps.mediaResolver ?? resolveYouTubeVideoMedia,
      fetcher: deps.fetcher ?? fetch,
      buildSteamReplyPayloads: deps.buildSteamReplyPayloads ?? buildSteamReplyPayloads,
      buildGithubReplyPayloads: deps.buildGithubReplyPayloads ?? buildGithubReplyPayloads,
      expandTikTokLinks: deps.expandTikTokLinks ?? expandTikTokLinks,
      expandInstagramLinks: deps.expandInstagramLinks ?? expandInstagramLinks,
      buildWebReplyPayloads: deps.buildWebReplyPayloads ?? buildWebReplyPayloads,
      suppressLateEmbeds: deps.suppressLateEmbeds ?? ((message) => suppressLateEmbeds(message, this.ctx.log)),
      lateEmbedWatcher: deps.lateEmbedWatcher !== undefined
        ? deps.lateEmbedWatcher
        : hasMessageUpdateEvents(ctx.client) ? new LateEmbedWatcher(ctx.client, ctx.log) : null,
    };
  }

  /** 展開が無くなった投稿の公式 Embed を戻す。抑制していなければ何もしない。 */
  async releaseEmbeds(message: Message): Promise<void> {
    this.deps.lateEmbedWatcher?.unwatch(message.id);
    if (message.flags?.has(MessageFlags.SuppressEmbeds)) await message.suppressEmbeds(false);
  }

  hasLinks(message: Message): boolean {
    if (message.author?.bot || message.guildId !== this.ctx.config.GUILD_ID || looksLikePrefixCommandLine(message.content)) return false;
    return extractSteamLinksFromMessage(message).length > 0 || extractGithubLinksFromMessage(message).length > 0
      || extractXLinks(message.content).length > 0 || extractTikTokLinks(message.content).length > 0
      || extractInstagramLinks(message.content).length > 0
      || collectWebReplyTargets(extractWebLinks(message.content)).length > 0
      || (this.ctx.config.YOUTUBE_PREVIEW_ENABLED && extractYouTubeLinks(message.content).length > 0);
  }

  async onMessage(message: Message): Promise<void> {
    if (message.author?.bot || !message.guild || message.guild.id !== this.ctx.config.GUILD_ID) return;
    if (looksLikePrefixCommandLine(message.content)) return;
    const settings = await getGuildSettingsData(this.ctx.db, message.guild.id);
    if (settings.auto_reply_excluded_channel_ids?.includes(message.channelId)) return;

    const content = String(message.content || "");
    const directSteamLinks = extractSteamLinksFromMessage(message);
    const githubTargets = collectGithubReplyTargets(extractGithubLinksFromMessage(message));
    const githubImageUrls = extractGithubEmbedImageUrls(message);
    const twitterTargets = collectTwitterReplyTargets(extractXLinks(content));
    const youtubeTargets = this.ctx.config.YOUTUBE_PREVIEW_ENABLED
      ? collectYouTubeReplyTargets(extractYouTubeLinks(content))
      : [];
    const tiktokTargets = collectTikTokReplyTargets(extractTikTokLinks(content));
    const instagramTargets = collectInstagramReplyTargets(extractInstagramLinks(content));
    const allWebTargets = collectWebReplyTargets(extractWebLinks(content));
    const webTargets = allWebTargets.slice(0, MAX_WEB_PREVIEWS);
    const overflowWebTargets = allWebTargets.slice(MAX_WEB_PREVIEWS);
    if (
      directSteamLinks.length === 0
      && twitterTargets.length === 0
      && youtubeTargets.length === 0
      && githubTargets.length === 0
      && tiktokTargets.length === 0
      && instagramTargets.length === 0
      && webTargets.length === 0
    ) return;

    const youtubePlan = youtubeTargets.length > 0
      ? await prepareYouTubeLinkExpansion(message, youtubeTargets, {
        production: this.ctx.config.BOT_PROFILE === "production",
        cache: async (target) => await this.deps.cacheYouTubeVideoForPost(this.ctx, {
          videoId: target.id!,
          videoUrl: target.canonicalUrl,
        }, { attachmentSizeLimitBytes: attachmentSizeLimitForMessage(message) }),
        waitForNative: async (target) => await waitForNativeYouTubeEmbed(
          message,
          target,
          youtubeTargets.length === 1,
          this.ctx.client as unknown as { on?: (...args: unknown[]) => unknown; off?: (...args: unknown[]) => unknown },
        ),
      })
      : null;

    // GitHub と汎用のリンクは、取得できたときだけ公式 Embed を抑制するので、抑制の前にカードを作る
    const [githubResults, webResults] = await Promise.all([
      githubTargets.length > 0
        ? this.deps.buildGithubReplyPayloads(githubTargets, {
          token: this.ctx.config.GITHUB_API_TOKEN,
          config: this.ctx.config,
          log: this.ctx.log,
          aiRouter: this.ctx.aiRouter,
          guildId: message.guildId ?? this.ctx.config.GUILD_ID,
          imageUrlByCanonicalUrl: githubImageUrls,
        }).catch((error: unknown): GithubPreviewBuildResult[] => {
          this.ctx.log.warn({ error: String(error) }, "github preview build failed");
          return [];
        })
        : Promise.resolve([]),
      webTargets.length > 0
        ? this.deps.buildWebReplyPayloads(webTargets, {
          config: this.ctx.config,
          log: this.ctx.log,
          aiRouter: this.ctx.aiRouter,
          guildId: message.guildId ?? this.ctx.config.GUILD_ID,
        }).catch((error: unknown): WebPreviewBuildResult[] => {
          this.ctx.log.warn({ error: String(error) }, "web preview build failed");
          return [];
        })
        : Promise.resolve([]),
    ]);

    const hasExistingPreview = directSteamLinks.length > 0
      || twitterTargets.length > 0
      || youtubeTargets.length > 0
      || tiktokTargets.length > 0
      || instagramTargets.length > 0;
    const hasGithubSuccess = githubResults.some((result) => result.status === "success");
    const hasWebSuccess = webResults.some((result) => result.status === "success");
    // 最初の抑制に成功したときだけ、カードを送った後に遅れて付いた公式 Embed を確認する
    // （権限不足などで失敗したチャンネルでは、確認しても抑制できない）
    let suppressed = false;
    if (hasExistingPreview || hasGithubSuccess || hasWebSuccess) {
      // 抑制との間に付いた Embed も取りこぼさないよう、抑制の前に messageUpdate の監視を始める
      this.deps.lateEmbedWatcher?.watch(message);
      try {
        await message.suppressEmbeds(true);
        suppressed = true;
      } catch {
        this.deps.lateEmbedWatcher?.unwatch(message.id);
      }
    }
    const recheckLateEmbeds = () => suppressed ? this.deps.suppressLateEmbeds(message) : Promise.resolve();

    const nestedTwitterSteamLinks = twitterTargets.length > 0
      ? await this.deps.expandTwitterLinks(message, twitterTargets, {
        db: this.ctx.db,
        replyExpansion: this.deps.replyExpansion,
        log: this.ctx.log,
        config: this.ctx.config,
        aiRouter: this.ctx.aiRouter,
        buildReplyPayloads: this.deps.buildVxTwitterReplyPayloads,
      })
      : [];
    const mediaTasks: Promise<void>[] = [];
    if (tiktokTargets.length > 0) {
      // 共有キューの待ちで後続処理（AutoMod など）を止めないよう、完了を待たずに実行する
      mediaTasks.push(this.deps.expandTikTokLinks(message, tiktokTargets, {
        db: this.ctx.db,
        replyExpansion: this.deps.replyExpansion,
        log: this.ctx.log,
        config: this.ctx.config,
        aiRouter: this.ctx.aiRouter,
        attachmentSizeLimitBytes: attachmentSizeLimitForMessage(message),
      }).then(recheckLateEmbeds).catch((err: unknown) => {
        this.ctx.log.warn({ err: String(err), messageId: message.id }, "tiktok preview expansion failed");
      }));
    }
    if (instagramTargets.length > 0) {
      // TikTok と同じ共有キューを使うため、待ちで後続処理を止めないよう完了を待たずに実行する
      mediaTasks.push(this.deps.expandInstagramLinks(message, instagramTargets, {
        db: this.ctx.db,
        replyExpansion: this.deps.replyExpansion,
        log: this.ctx.log,
        config: this.ctx.config,
        aiRouter: this.ctx.aiRouter,
        attachmentSizeLimitBytes: attachmentSizeLimitForMessage(message),
      }).then(recheckLateEmbeds).catch((err: unknown) => {
        this.ctx.log.warn({ err: String(err), messageId: message.id }, "instagram preview expansion failed");
      }));
    }
    const nestedYouTubeSteamLinks = youtubePlan
      ? await sendYouTubeLinkExpansion(message, youtubePlan, {
        db: this.ctx.db,
        replyExpansion: this.deps.replyExpansion,
        mainPgPool: this.ctx.mainPgPool,
        config: this.ctx.config,
        log: this.ctx.log,
        aiRouter: this.ctx.aiRouter,
        buildReplyPayloads: this.deps.buildYouTubeReplyPayloads,
        attachmentSizeLimitBytes: attachmentSizeLimitForMessage(message),
        saveReference: this.deps.saveYouTubeVideoCacheReference,
        mediaResolver: this.deps.mediaResolver,
        fetcher: this.deps.fetcher,
      })
      : [];
    const steamTargets = collectSteamReplyTargets([
      ...directSteamLinks,
      ...nestedTwitterSteamLinks,
      ...nestedYouTubeSteamLinks,
    ]);
    if (steamTargets.length > 0) {
      await sendSteamLinkExpansion(message, steamTargets, {
        db: this.ctx.db,
        replyExpansion: this.deps.replyExpansion,
        mainPgPool: this.ctx.mainPgPool,
        config: this.ctx.config,
        log: this.ctx.log,
        aiRouter: this.ctx.aiRouter,
        buildReplyPayloads: this.deps.buildSteamReplyPayloads,
      });
    }
    if (githubResults.length > 0 && (hasExistingPreview || hasGithubSuccess || hasWebSuccess)) {
      await sendGithubLinkExpansion(message, githubResults, {
        db: this.ctx.db,
        replyExpansion: this.deps.replyExpansion,
        config: this.ctx.config,
        log: this.ctx.log,
        aiRouter: this.ctx.aiRouter,
      }, { includeFailures: true });
    } else if (githubResults.some((result) => result.status === "error" && isTransientGithubFailure(result.reason))) {
      await this.deps.deferExpansion(message, "github:retry");
    }
    // 抑制した投稿では、取得できなかったリンクも Embed の代わりのカードを出す
    // （抑制していなければカードを出さず、公式の Embed を残す）
    if (webResults.length > 0 && (hasExistingPreview || hasGithubSuccess || hasWebSuccess)) {
      await sendWebLinkExpansion(message, webResults, {
        db: this.ctx.db,
        replyExpansion: this.deps.replyExpansion,
        log: this.ctx.log,
      }, { includeFailures: true, overflow: overflowWebTargets });
    }
    // カードを送り終えた後に、遅れて付いた公式 Embed が残っていないか確認する。
    // TikTok・Instagram だけのときはまだカードを送っていないので、それぞれの展開完了後に確認する
    const sentCardsHere = twitterTargets.length > 0 || youtubeTargets.length > 0 || steamTargets.length > 0
      || githubResults.length > 0 || webResults.length > 0;
    if (sentCardsHere) await recheckLateEmbeds();
    if (this.tracked) await Promise.all(mediaTasks);
  }
}
