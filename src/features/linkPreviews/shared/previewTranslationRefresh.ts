import type { Message } from "discord.js";
import type { BotContext } from "../../../bot/context.js";
import type { PreviewDocument } from "./previewDocument.js";
import type { PreviewTranslationStateV1 } from "./previewState.repository.js";
import type { PreviewDocumentTranslations } from "./previewTranslationGate.js";
import { buildGithubReplyPayloads } from "../github/githubLinkExpansion.js";
import { parseGithubUrl } from "../github/githubPreviewSource.js";
import { buildInstagramReplyPayloads } from "../instagram/instagramLinkExpansion.js";
import { parseInstagramUrl } from "../instagram/instagramPreviewSource.js";
import { buildSteamReplyPayloads } from "../steam/steamLinkExpansion.js";
import { parseSteamUrl } from "../steam/steamPreviewSource.js";
import { buildTikTokReplyPayloads } from "../tiktok/tiktokLinkExpansion.js";
import { parseTikTokUrl } from "../tiktok/tiktokPreviewSource.js";
import { buildTwitterReplyPayloads } from "../twitter/twitterLinkExpansion.js";
import { parseXStatusUrl } from "../twitter/twitterPreviewSource.js";
import { buildWebReplyPayloads } from "../web/webLinkExpansion.js";
import { parseWebUrl } from "../web/webPreviewSource.js";
import { buildYouTubeReplyPayloads } from "../youtube/youtubeLinkExpansion.js";
import { parseYouTubeUrl } from "../youtube/youtubePreviewSource.js";
import { extractComponentMediaUrls, extractComponentUrls } from "./linkExtraction.js";

export type RefreshPreviewDeps = {
  buildTwitter?: typeof buildTwitterReplyPayloads;
  buildYouTube?: typeof buildYouTubeReplyPayloads;
  buildSteam?: typeof buildSteamReplyPayloads;
  buildGithub?: typeof buildGithubReplyPayloads;
  buildTikTok?: typeof buildTikTokReplyPayloads;
  buildInstagram?: typeof buildInstagramReplyPayloads;
  buildWeb?: typeof buildWebReplyPayloads;
};

function toV1State(
  messageId: string,
  guildId: string,
  channelId: string,
  previewState: { document: PreviewDocument; translations: PreviewDocumentTranslations } | undefined,
): PreviewTranslationStateV1 | null {
  if (!previewState) return null;
  return {
    version: 1,
    messageId,
    guildId,
    channelId,
    sourceUrl: previewState.document.url,
    ...previewState,
  };
}

export async function refreshPreviewTranslationState(
  message: Pick<Message, "id" | "components">,
  ctx: Pick<BotContext, "config" | "log" | "aiRouter"> & Partial<Pick<BotContext, "mainPgPool">>,
  guildId: string,
  channelId: string,
  deps: RefreshPreviewDeps = {},
): Promise<PreviewTranslationStateV1 | null> {
  // 種類の判定には先頭のリンクボタン（「Xで開く」等）の URL だけを使う。
  const url = extractComponentUrls(message.components)[0];
  if (!url) return null;
  const mediaUrl = extractComponentMediaUrls(message.components)[0];
  const baseOpts = { config: ctx.config, log: ctx.log, aiRouter: ctx.aiRouter, guildId };

  const steam = parseSteamUrl(url);
  if (steam) {
    const [payload] = await (deps.buildSteam ?? buildSteamReplyPayloads)([steam], {
      mainPgPool: ctx.mainPgPool,
      ...baseOpts,
    });
    return toV1State(message.id, guildId, channelId, payload?.previewState);
  }

  const x = parseXStatusUrl(url);
  if (x) {
    const [payload] = await (deps.buildTwitter ?? buildTwitterReplyPayloads)(
      [{ vxUrl: x.vxUrl, screenName: x.screenName, statusId: x.id }],
      baseOpts,
    );
    return toV1State(message.id, guildId, channelId, payload?.previewState);
  }

  const youtube = parseYouTubeUrl(url);
  if (youtube) {
    const [payload] = await (deps.buildYouTube ?? buildYouTubeReplyPayloads)([youtube], {
      apiKey: ctx.config.YOUTUBE_DATA_API_KEY,
      requestTimeoutMs: ctx.config.YOUTUBE_REQUEST_TIMEOUT_MS,
      componentsOnly: true,
      mediaMode: "none",
      ...baseOpts,
    });
    return toV1State(message.id, guildId, channelId, payload?.previewState);
  }

  const tiktok = parseTikTokUrl(url);
  if (tiktok) {
    // 表示切り替えはテキストのみ差し替えるため、動画は再ダウンロードしない
    const [payload] = await (deps.buildTikTok ?? buildTikTokReplyPayloads)([tiktok], {
      attachmentSizeLimitBytes: 0,
      ...baseOpts,
    });
    const previewState = payload && "previewState" in payload ? payload.previewState : undefined;
    return toV1State(message.id, guildId, channelId, previewState);
  }

  const instagram = parseInstagramUrl(url);
  if (instagram) {
    // 表示切り替えはテキストのみ差し替えるため、メディアは再取得しない
    const [payload] = await (deps.buildInstagram ?? buildInstagramReplyPayloads)([instagram], {
      attachmentSizeLimitBytes: 0,
      ...baseOpts,
    });
    const previewState = payload && "previewState" in payload ? payload.previewState : undefined;
    return toV1State(message.id, guildId, channelId, previewState);
  }

  const github = parseGithubUrl(url);
  if (github) {
    const [result] = await (deps.buildGithub ?? buildGithubReplyPayloads)([github], {
      token: ctx.config.GITHUB_API_TOKEN,
      ...baseOpts,
      ...(mediaUrl ? { imageUrlByCanonicalUrl: new Map([[github.canonicalUrl, mediaUrl]]) } : {}),
    });
    return result?.status === "success"
      ? toV1State(message.id, guildId, channelId, result.payload.previewState)
      : null;
  }

  const web = parseWebUrl(url);
  if (web) {
    const [result] = await (deps.buildWeb ?? buildWebReplyPayloads)([web], baseOpts);
    return result?.status === "success"
      ? toV1State(message.id, guildId, channelId, result.payload.previewState)
      : null;
  }

  return null;
}
