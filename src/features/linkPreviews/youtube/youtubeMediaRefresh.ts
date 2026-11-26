import {
  ButtonStyle,
  ComponentType,
  MessageFlags,
  type APIMessageTopLevelComponent,
  type ButtonInteraction,
} from "discord.js";
import type { CoreDeps } from "../../../core/deps.js";
import { PostgresYouTubeVideoCacheRepository } from "../../youtube/youtubeVideoCache.repository.js";
import {
  isGoogleVideoMediaUrl,
  resolveYouTubeVideoMediaWithRetry,
} from "../../youtube/youtubeVideoMedia.js";
import { replacePreviewMedia } from "../../../core/previewMedia.js";
import { parseYouTubeUrl } from "./youtubePreviewSource.js";
import {
  downloadYouTubeMediaAttachment,
  youtubeAttachmentSizeLimitForPremiumTier,
  type YouTubeMediaAttachmentOptions,
} from "./youtubeMediaAttachment.js";

export const PREVIEW_YOUTUBE_MEDIA_REFRESH_ID = "preview:youtube-refresh";
const refreshInFlightMessageIds = new Set<string>();

type YouTubeMediaRefreshDeps = {
  resolveMedia?: typeof resolveYouTubeVideoMediaWithRetry;
  fetcher?: YouTubeMediaAttachmentOptions["fetcher"];
  attachmentSizeLimitBytes?: number;
  updateReference?: (
    messageId: string,
    mediaMode: "google",
    lastError: null,
  ) => Promise<void>;
};

function isComponentRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

export function addYouTubeMediaRefreshButton(
  components: readonly unknown[],
): APIMessageTopLevelComponent[] {
  const next = structuredClone(components) as Array<Record<string, unknown>>;
  let alreadyPresent = false;
  const findExisting = (component: Record<string, unknown>): void => {
    if (component.custom_id === PREVIEW_YOUTUBE_MEDIA_REFRESH_ID) alreadyPresent = true;
    if (Array.isArray(component.components)) {
      component.components.filter(isComponentRecord).forEach(findExisting);
    }
  };
  next.forEach(findExisting);
  if (alreadyPresent) return next as unknown as APIMessageTopLevelComponent[];

  let added = false;
  const append = (component: Record<string, unknown>): void => {
    if (added) return;
    if (component.type === ComponentType.ActionRow && Array.isArray(component.components)) {
      const videoLink = component.components.filter(isComponentRecord).some((button) => {
        if (button.type !== ComponentType.Button || button.style !== ButtonStyle.Link || typeof button.url !== "string") {
          return false;
        }
        return parseYouTubeUrl(button.url)?.kind === "video";
      });
      if (videoLink && component.components.length < 5) {
        component.components.push({
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          label: "動画を再取得",
          custom_id: PREVIEW_YOUTUBE_MEDIA_REFRESH_ID,
        });
        added = true;
        return;
      }
    }
    if (Array.isArray(component.components)) {
      component.components.filter(isComponentRecord).forEach(append);
    }
  };
  next.forEach(append);
  return next as unknown as APIMessageTopLevelComponent[];
}

function componentJson(components: readonly unknown[]): APIMessageTopLevelComponent[] {
  return components.map((component) => {
    if (!isComponentRecord(component)) throw new Error("invalid message component");
    const toJSON = component.toJSON;
    const json = typeof toJSON === "function" ? toJSON.call(component) : component;
    if (!isComponentRecord(json)) throw new Error("invalid message component json");
    return json as unknown as APIMessageTopLevelComponent;
  });
}

function findYouTubeVideoUrl(components: readonly unknown[]): string | null {
  let result: string | null = null;
  const visit = (value: unknown): void => {
    if (result || !isComponentRecord(value)) return;
    if (
      value.type === ComponentType.Button
      && value.style === ButtonStyle.Link
      && typeof value.url === "string"
      && parseYouTubeUrl(value.url)?.kind === "video"
    ) {
      result = parseYouTubeUrl(value.url)?.canonicalUrl ?? null;
      return;
    }
    if (Array.isArray(value.components)) value.components.forEach(visit);
  };
  components.forEach(visit);
  return result;
}

async function reportRefreshFailure(interaction: ButtonInteraction): Promise<void> {
  const payload = {
    content: "動画を再取得できませんでした。時間をおいてもう一度お試しください。",
    flags: MessageFlags.Ephemeral,
  } as const;
  if (interaction.deferred || interaction.replied) {
    await interaction.followUp(payload).catch(() => undefined);
    return;
  }
  await interaction.reply(payload).catch(() => undefined);
}

async function reportRefreshBusy(interaction: ButtonInteraction): Promise<void> {
  const payload = {
    content: "この動画は現在再取得中です。完了してからもう一度お試しください。",
    flags: MessageFlags.Ephemeral,
  } as const;
  if (interaction.deferred || interaction.replied) {
    await interaction.followUp(payload).catch(() => undefined);
    return;
  }
  await interaction.reply(payload).catch(() => undefined);
}

export async function handleYouTubeMediaRefresh(
  interaction: ButtonInteraction,
  ctx: Pick<CoreDeps, "config" | "log" | "client" | "mainPgPool">,
  deps: YouTubeMediaRefreshDeps = {},
): Promise<boolean> {
  if (interaction.customId !== PREVIEW_YOUTUBE_MEDIA_REFRESH_ID) return false;
  if (
    !interaction.guildId
    || !interaction.channelId
    || interaction.guildId !== ctx.config.GUILD_ID
    || interaction.message.author.id !== ctx.client.user?.id
  ) return false;

  const messageId = interaction.message.id;
  if (refreshInFlightMessageIds.has(messageId)) {
    await reportRefreshBusy(interaction);
    return true;
  }
  refreshInFlightMessageIds.add(messageId);

  try {
    await interaction.deferUpdate();
    const sourceMessage = await interaction.message.fetch(true);
    const videoUrl = findYouTubeVideoUrl(componentJson(sourceMessage.components));
    if (!videoUrl) {
      await reportRefreshFailure(interaction);
      return true;
    }

    const attachmentSizeLimitBytes = deps.attachmentSizeLimitBytes
      ?? youtubeAttachmentSizeLimitForPremiumTier(interaction.guild?.premiumTier);
    const resolved = await (deps.resolveMedia ?? resolveYouTubeVideoMediaWithRetry)(videoUrl, {
      bypassCache: true,
      timeoutMs: ctx.config.YOUTUBE_REQUEST_TIMEOUT_MS,
      maxBytes: attachmentSizeLimitBytes,
    });
    if (resolved.status !== "ok" || !isGoogleVideoMediaUrl(resolved.mediaUrl)) {
      await reportRefreshFailure(interaction);
      return true;
    }

    const latestMessage = await interaction.message.fetch(true);
    const latestComponents = componentJson(latestMessage.components);
    if (findYouTubeVideoUrl(latestComponents) !== videoUrl) {
      await reportRefreshFailure(interaction);
      return true;
    }

    const attachment = await downloadYouTubeMediaAttachment(resolved.mediaUrl, {
      fetcher: deps.fetcher,
      attachmentSizeLimitBytes,
      requestTimeoutMs: ctx.config.YOUTUBE_REQUEST_TIMEOUT_MS,
    });
    if (!attachment) {
      await reportRefreshFailure(interaction);
      return true;
    }
    const components = replacePreviewMedia(
      latestComponents,
      attachment.mediaUrl,
      { description: "YouTube video" },
    );
    await latestMessage.edit({
      components,
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { parse: [], repliedUser: false },
      files: attachment.files,
      attachments: [],
    });

    try {
      if (deps.updateReference) {
        await deps.updateReference(
          interaction.message.id,
          "google",
          null,
        );
      } else {
        await new PostgresYouTubeVideoCacheRepository(ctx.mainPgPool)
          .updateVideoCacheReferenceMedia(
            interaction.message.id,
            "google",
            null,
          );
      }
    } catch (error) {
      ctx.log.warn({ error, messageId: interaction.message.id }, "youtube media refresh reference update failed");
    }
    return true;
  } catch (error) {
    ctx.log.warn({ error, messageId: interaction.message.id }, "youtube media refresh failed");
    await reportRefreshFailure(interaction);
    return true;
  } finally {
    refreshInFlightMessageIds.delete(messageId);
  }
}
